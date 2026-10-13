import { readFile, writeFile, rename, rm } from 'node:fs/promises'
import type { Database } from '../database/database'
import { Logger } from '../system/logger'
import { paceIndexing } from './indexing-pacing'
import { GLOBAL_BROWSER_PROJECT_ID, type Thread } from '../../lib/types'
import { SEARCH_MODEL_CATALOG, searchModelsForRuntime } from '../../lib/search/model-catalog'
import {
  clampSearchContextTokens,
  DEFAULT_SEARCH_SETTINGS,
  SEARCH_MIN_RUNTIME_BUILD,
  type IntentThreadMatch,
  type InstalledSearchModel,
  type SearchArchitecture,
  type SearchDownloadState,
  type SearchIndexStatus,
  type SearchModelArtifact,
  type SearchPlatform,
  type SearchProgressEvent,
  type SearchSettings,
  type SearchState
} from '../../lib/search/types'
import { normalizeInPlace } from '../../lib/search/vector'
import { SearchModelDownloader } from './embedding-model-downloader'
import type { EmbeddingRuntime } from './llama-embedding-runtime'
import { LlamaEmbeddingRuntime, embeddingWorkingContext } from './llama-embedding-runtime'
import { SearchModelImporter, type ImportProbe } from './search-model-importer'
import { ThreadEmbeddingIndex, composeDocument } from './thread-embedding-index'
import { SearchStorage } from './search-storage'
import {
  ThreadSearchSummaries,
  type SearchSummaryExecutor,
  type SearchSummaryThread
} from './thread-search-summary'

/** Interval between light staleness sweeps while intent search is enabled. */
const PERIODIC_SWEEP_MS = 5 * 60 * 1000

interface PersistedModelIndex {
  version: 1
  models: InstalledSearchModel[]
}

export interface SearchServiceHost {
  subscribeCorpus?: (listener: {
    updated(thread: Thread): void
    deleted(thread: Pick<Thread, 'projectId' | 'id'>): void
    draftUpdated(projectId: string, threadId: string, drafting: boolean): void
  }) => () => void
  summarizeThread: SearchSummaryExecutor
  llamaServerPath: () => string | null
  /**
   * llama.cpp build of the selected runtime, or null when it cannot be read.
   * The catalogued models need a build that understands `gemma-embedding2`; a
   * runtime that predates it is reported as unsupported instead of failing the
   * sweep with an opaque model-load error.
   */
  runtimeBuild: () => number | null
  registerProcess: (pid: number, command: string, cwd: string) => void
  unregisterProcess: (pid: number) => void
}

/**
 * Owns every part of intent search: the installed embedding models, their
 * download and import, the local embedding runtime, the thread index, and the
 * semantic query used by the hybrid thread search.
 *
 * The service is inert until the user enables intent search and a model is
 * installed, so a keyword-only install behaves exactly as before.
 */
export class SearchService {
  private readonly index: ThreadEmbeddingIndex
  private readonly downloader: SearchModelDownloader
  private readonly importer: SearchModelImporter
  private readonly listeners = new Set<(event: SearchProgressEvent) => void>()
  private settings: SearchSettings = { ...DEFAULT_SEARCH_SETTINGS }
  private models: InstalledSearchModel[] = []
  private readonly downloads = new Map<string, SearchDownloadState>()
  private catalog: SearchModelArtifact[] = []
  private runtime: EmbeddingRuntime | null = null
  private runtimeModelId: string | null = null
  private sweep: Promise<void> | null = null
  private sweepTotals: { total: number | null; pending: number } = { total: null, pending: 0 }
  private indexing = false
  /** Loaded or partially built records are unusable until a full sweep succeeds. */
  private intentReady = false
  private periodicTimer: ReturnType<typeof setInterval> | null = null
  private corpusTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribeCorpus: (() => void) | null = null
  private disposed = false
  private sweepController: AbortController | null = null
  private indexingError: string | null = null
  private indexingDetail: SearchIndexStatus['progress'] = null
  private readonly summaries: ThreadSearchSummaries
  private readonly summaryJobs = new Map<
    string,
    {
      thread: SearchSummaryThread
      contentHash: string
      model: InstalledSearchModel
      generation: number
    }
  >()
  private summaryWorker: Promise<void> | null = null
  private summaryController = new AbortController()
  private summaryDetail: SearchIndexStatus['progress'] = null
  private generation = 0

  constructor(
    private readonly db: Database,
    private readonly host: SearchServiceHost,
    private readonly storage: SearchStorage = new SearchStorage()
  ) {
    this.summaries = new ThreadSearchSummaries(db, storage.summaryDirectory, host.summarizeThread)
    this.index = new ThreadEmbeddingIndex(db, storage.threadIndexPath, this.summaries)
    this.downloader = new SearchModelDownloader(storage, {
      catalog: () => this.catalog,
      emitDownload: (artifactId, download) => this.onDownload(artifactId, download),
      recordInstalled: (artifact, installedAt) => this.recordInstalled(artifact, installedAt)
    })
    this.importer = new SearchModelImporter(storage, (directory) => this.probeModel(directory))
  }

  async initialize(): Promise<void> {
    this.unsubscribeCorpus =
      this.host.subscribeCorpus?.({
        updated: (thread) => this.updateCorpusThread(thread),
        deleted: (thread) => this.removeCorpusThread(thread.id),
        draftUpdated: (projectId, threadId, drafting) => {
          if (drafting) this.removeCorpusThread(threadId)
          else
            void this.reloadCorpusThread(projectId, threadId).catch((error) => {
              Logger.error('Search corpus draft update failed:', error)
            })
        }
      }) ?? null
    await this.storage.initialize()
    const platform = process.platform as SearchPlatform
    const architecture = process.arch as SearchArchitecture
    this.catalog = searchModelsForRuntime(SEARCH_MODEL_CATALOG, 'gguf', platform, architecture)
    await this.loadSettings()
    await this.loadModelIndex()
    await this.index.load()
    await this.index.initializeCorpus()
    if (this.settings.enabled && this.activeModel() && this.canEmbed()) {
      void this.runSweep('startup')
    }
    this.periodicTimer = setInterval(() => {
      if (this.settings.enabled && this.activeModel() && this.canEmbed()) {
        void this.runSweep('periodic')
      }
    }, PERIODIC_SWEEP_MS)
    // Never keep the process alive solely for the sweep timer.
    this.periodicTimer.unref?.()
  }

  private updateCorpusThread(thread: Thread): void {
    if (thread.drafting || thread.projectId === GLOBAL_BROWSER_PROJECT_ID) {
      this.removeCorpusThread(thread.id)
      return
    }
    const isNew = !this.index.candidates.has(thread.id)
    this.index.updateThread({
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      stamp: Math.max(thread.lastActivity ?? 0, thread.updatedAt ?? 0)
    })
    this.emitStatus()
    if (isNew) this.requestCorpusSweep()
  }

  private requestCorpusSweep(): void {
    if (this.corpusTimer || this.disposed) return
    this.corpusTimer = setTimeout(() => {
      this.corpusTimer = null
      if (!this.settings.enabled || !this.activeModel() || !this.canEmbed()) return
      if (this.sweep) this.requestCorpusSweep()
      else void this.runSweep('thread-created')
    }, 3000)
    this.corpusTimer.unref()
  }

  private removeCorpusThread(id: string): void {
    this.index.removeThread(id)
    this.summaryJobs.delete(id)
    this.emitStatus()
  }

  private async reloadCorpusThread(projectId: string, id: string): Promise<void> {
    const result = await this.db.queryViaWorker(
      'SELECT title, last_activity, updated_at FROM threads WHERE id = ? AND project_id = ? AND drafting = 0',
      [id, projectId],
      1
    )
    const row = result.rows[0]
    if (!result.ok || !row || this.disposed || projectId === GLOBAL_BROWSER_PROJECT_ID) return
    this.index.updateThread({
      id,
      projectId,
      title: String(row['title'] ?? ''),
      stamp: Math.max(Number(row['last_activity'] ?? 0), Number(row['updated_at'] ?? 0))
    })
    this.emitStatus()
    this.requestCorpusSweep()
  }

  onProgress(listener: (event: SearchProgressEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  state(): SearchState {
    const downloads: Record<string, SearchDownloadState> = {}
    for (const [artifactId, download] of this.downloads) downloads[artifactId] = download
    return {
      settings: { ...this.settings },
      status: this.status(),
      models: this.models,
      catalog: this.catalog,
      downloads
    }
  }

  async downloadArtifact(artifactId: string): Promise<void> {
    await this.downloader.download(artifactId)
  }

  cancelDownload(artifactId: string): boolean {
    return this.downloader.cancel(artifactId)
  }

  async deleteModel(modelId: string): Promise<void> {
    const model = this.models.find((candidate) => candidate.id === modelId)
    if (!model) throw new Error('The model is not installed.')
    if (this.settings.activeModelId === modelId) await this.stopSweep()
    await rm(model.directory, { recursive: true, force: true }).catch(() => undefined)
    this.models = this.models.filter((candidate) => candidate.id !== modelId)
    if (this.runtimeModelId === modelId) await this.disposeRuntime()
    if (this.settings.activeModelId === modelId) {
      this.settings.activeModelId = null
      this.settings.enabled = false
      await this.index.reset()
      await this.saveSettings()
    }
    await this.saveModelIndex()
    this.emitStatus()
  }

  async importModel(sourcePath: string): Promise<InstalledSearchModel> {
    const imported = await this.importer.importFromPath(sourcePath)
    const model: InstalledSearchModel = {
      id: imported.modelId,
      artifactId: null,
      label: imported.label,
      runtime: 'gguf',
      dimensions: imported.dimensions,
      contextTokens: imported.contextTokens,
      queryPrefix: '',
      documentPrefix: '',
      byteSize: imported.byteSize,
      installedAt: Date.now(),
      directory: imported.directory,
      source: 'imported'
    }
    this.models = [...this.models.filter((candidate) => candidate.id !== model.id), model]
    await this.saveModelIndex()
    const becameActive = !this.settings.activeModelId
    if (becameActive) {
      this.settings.activeModelId = model.id
      await this.saveSettings()
    }
    await this.enableAfterFirstActivation(becameActive)
    return model
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.intentReady = false
    this.settings.enabled = enabled
    if (!enabled) {
      this.sweepController?.abort()
      this.cancelSummaries()
    }
    await this.saveSettings()
    if (enabled) {
      if (!this.settings.activeModelId) {
        const first = this.models[0]
        if (first) this.settings.activeModelId = first.id
        await this.saveSettings()
      }
      if (this.canEmbed()) await this.runSweep('enabled')
    }
    this.emitStatus()
  }

  async setActiveModel(modelId: string | null): Promise<void> {
    if (modelId !== null && !this.models.some((model) => model.id === modelId)) {
      throw new Error('The selected model is not installed.')
    }
    const previous = this.settings.activeModelId
    if (previous === modelId) return
    this.intentReady = false
    await this.stopSweep()
    this.settings.activeModelId = modelId
    await this.saveSettings()
    // A different model produces a different vector space, so the existing
    // index is meaningless. Drop it and rebuild.
    await this.disposeRuntime()
    await this.index.reset()
    this.sweepTotals = { total: null, pending: 0 }
    if (this.settings.enabled && modelId && this.canEmbed()) await this.runSweep('model-changed')
    this.emitStatus()
  }

  /**
   * Change the embedding context window. The window decides how much of a
   * thread is embedded, so vectors produced under a different window are not
   * comparable: the index is dropped and rebuilt from scratch.
   */
  async setContextTokens(tokens: number): Promise<void> {
    const next = clampSearchContextTokens(tokens)
    if (this.settings.contextTokens === next) return
    this.intentReady = false
    await this.stopSweep()
    this.settings.contextTokens = next
    await this.saveSettings()
    await this.disposeRuntime()
    await this.index.reset()
    this.sweepTotals = { total: null, pending: 0 }
    if (this.settings.enabled && this.activeModel() && this.canEmbed()) {
      await this.runSweep('context-changed')
    }
    this.emitStatus()
  }

  async rebuildIndex(): Promise<void> {
    this.intentReady = false
    await this.stopSweep()
    await this.index.reset()
    this.sweepTotals = { total: null, pending: 0 }
    if (this.settings.enabled && this.activeModel() && this.canEmbed()) {
      await this.runSweep('rebuild')
    }
    this.emitStatus()
  }

  /**
   * Semantic matches for a query. Returns an empty list whenever intent search
   * is off, no model is ready, or the embedding fails, so the hybrid search
   * simply falls back to keyword results.
   */
  async searchIntent(query: string, limit: number): Promise<IntentThreadMatch[]> {
    const model = this.activeModel()
    if (!this.settings.enabled || !model) return []
    if (!this.intentReady || this.indexing) return []
    if (!this.canEmbed()) return []
    const trimmed = query.trim()
    if (trimmed.length === 0) return []
    const controller = new AbortController()
    try {
      const runtime = await this.ensureRuntime(model)
      const vector = await this.embedOne(
        runtime,
        `${model.queryPrefix}${trimmed}`,
        controller.signal
      )
      // A rebuild, disable, or model change may have started during embedding.
      if (
        !this.intentReady ||
        this.indexing ||
        !this.settings.enabled ||
        this.settings.activeModelId !== model.id
      )
        return []
      return this.index.search(vector, Math.max(1, limit))
    } catch (error) {
      Logger.dev('Intent search failed; falling back to keyword results.', error)
      return []
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.corpusTimer) clearTimeout(this.corpusTimer)
    this.corpusTimer = null
    this.unsubscribeCorpus?.()
    this.unsubscribeCorpus = null
    this.sweepController?.abort()
    this.cancelSummaries()
    if (this.periodicTimer) clearInterval(this.periodicTimer)
    this.periodicTimer = null
    this.downloader.abortAll()
    await this.disposeRuntime()
    await this.index.dispose()
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private activeModel(): InstalledSearchModel | undefined {
    const id = this.settings.activeModelId
    if (!id) return undefined
    return this.models.find((model) => model.id === id)
  }

  private status(): SearchIndexStatus {
    const model = this.activeModel()
    const runtimeAvailable = this.host.llamaServerPath() !== null
    const runtimeBuild = this.host.runtimeBuild()
    // An unreadable build is given the benefit of the doubt: a custom build can
    // legitimately have no version string, and the model load itself still
    // fails loudly if it cannot handle the architecture.
    const runtimeSupported = runtimeBuild === null || runtimeBuild >= SEARCH_MIN_RUNTIME_BUILD
    return {
      active:
        this.settings.enabled &&
        this.intentReady &&
        !this.indexing &&
        Boolean(model) &&
        runtimeAvailable &&
        runtimeSupported,
      runtimeAvailable,
      runtimeSupported,
      runtimeBuild,
      modelReady: Boolean(model) && runtimeAvailable && runtimeSupported,
      activeModelId: model?.id ?? null,
      indexedThreads: this.index.size,
      pendingThreads: this.index.pending,
      totalThreads: this.index.candidates.size,
      indexing: this.indexing,
      dimensions: model?.dimensions ?? 0,
      lastIndexedAt: this.index.lastIndexedAt,
      error: this.indexingError,
      progress: this.indexing ? this.indexingDetail : this.summaryDetail
    }
  }

  private emitStatus(): void {
    if (this.disposed) return
    this.emit({ kind: 'status', status: this.status() })
  }

  private emit(event: SearchProgressEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        Logger.dev('Search progress listener failed.', error)
      }
    }
  }

  private onDownload(artifactId: string, download: SearchDownloadState): void {
    this.downloads.set(artifactId, download)
    this.emit({ kind: 'download', artifactId, download })
  }

  private async recordInstalled(artifact: SearchModelArtifact, installedAt: number): Promise<void> {
    const model: InstalledSearchModel = {
      id: artifact.id,
      artifactId: artifact.id,
      label: artifact.label,
      runtime: artifact.runtime,
      dimensions: artifact.dimensions,
      contextTokens: artifact.contextTokens,
      queryPrefix: artifact.queryPrefix,
      documentPrefix: artifact.documentPrefix,
      byteSize: artifact.byteSize,
      installedAt,
      directory: this.storage.modelDirectory(artifact.id),
      source: 'catalog'
    }
    this.models = [...this.models.filter((candidate) => candidate.id !== model.id), model]
    const becameActive = !this.settings.activeModelId
    if (becameActive) {
      this.settings.activeModelId = model.id
      await this.saveSettings()
    }
    await this.saveModelIndex()
    await this.enableAfterFirstActivation(becameActive)
  }

  /**
   * Turn intent search on the moment the first model becomes active, so a fresh
   * install starts indexing without the user flipping a switch they never saw.
   * A model that the user already turned off stays off: this only fires on the
   * transition from no active model to one, and only when the local runtime can
   * actually embed, which is the same bar the page uses to allow the toggle.
   */
  private async enableAfterFirstActivation(becameActive: boolean): Promise<void> {
    if (!becameActive || this.settings.enabled || !this.canEmbed()) {
      this.emitStatus()
      return
    }
    this.settings.enabled = true
    await this.saveSettings()
    this.emitStatus()
    // Fire and forget: the install or import that triggered this must not wait
    // for a full backfill to finish before it answers the renderer.
    void this.runSweep('first-model')
  }

  private async probeModel(directory: string): Promise<ImportProbe> {
    if (!this.host.llamaServerPath()) {
      throw new Error('A local llama.cpp runtime is required to use an imported model.')
    }
    if (!this.canEmbed()) {
      throw new Error(
        `The local llama.cpp runtime is too old to load this model. Install the app runtime (build ${SEARCH_MIN_RUNTIME_BUILD} or newer).`
      )
    }
    const runtime = new LlamaEmbeddingRuntime(directory, 0, this.host)
    try {
      const [vector] = await runtime.embed(['compatibility probe'], new AbortController().signal)
      if (!vector || vector.length === 0) {
        throw new Error('The model did not return an embedding for a probe input.')
      }
      return { dimensions: vector.length, contextTokens: 0 }
    } finally {
      await runtime.dispose()
    }
  }

  private async ensureRuntime(model: InstalledSearchModel): Promise<EmbeddingRuntime> {
    if (this.runtime && this.runtimeModelId === model.id) return this.runtime
    await this.disposeRuntime()
    if (model.runtime !== 'gguf') {
      throw new Error(`No local runtime is available for ${model.runtime} models.`)
    }
    const runtime = new LlamaEmbeddingRuntime(
      model.directory,
      this.settings.contextTokens,
      this.host
    )
    this.runtime = runtime
    this.runtimeModelId = model.id
    return runtime
  }

  private async disposeRuntime(): Promise<void> {
    const runtime = this.runtime
    this.runtime = null
    this.runtimeModelId = null
    if (runtime) await runtime.dispose().catch(() => undefined)
  }

  private async embedOne(
    runtime: EmbeddingRuntime,
    text: string,
    signal: AbortSignal
  ): Promise<Float32Array> {
    const [vector] = await runtime.embed([text], signal)
    if (!vector) throw new Error('The embedding model returned no vector.')
    normalizeInPlace(vector)
    return vector
  }

  /**
   * Whether the selected runtime can actually embed the installed model. The
   * path alone is not enough: an old llama.cpp binary starts the server and then
   * refuses the model with `unknown model architecture`, so a sweep would only
   * ever produce an opaque load error.
   */
  private canEmbed(): boolean {
    if (!this.host.llamaServerPath()) return false
    const build = this.host.runtimeBuild()
    return build === null || build >= SEARCH_MIN_RUNTIME_BUILD
  }

  private runSweep(reason: string): Promise<void> {
    if (this.sweep) return this.sweep
    this.sweep = this.performSweep(reason).finally(() => {
      this.sweep = null
    })
    return this.sweep
  }

  private async stopSweep(): Promise<void> {
    this.cancelSummaries()
    this.sweepController?.abort()
    await this.sweep
  }

  private async performSweep(reason: string): Promise<void> {
    this.intentReady = false
    const model = this.activeModel()
    if (!model) return
    if (!this.canEmbed()) return
    if (this.index.pending === 0) {
      this.intentReady = true
      this.emitStatus()
      return
    }
    this.indexing = true
    this.indexingError = null
    this.emitStatus()
    const controller = new AbortController()
    this.sweepController = controller
    try {
      const runtime = await this.ensureRuntime(model)
      const documentChars = Math.min(
        262_144,
        (embeddingWorkingContext(this.settings.contextTokens) - 1) * 8
      )
      const result = await this.index.sweep(
        async (texts) => {
          const vectors = await runtime.embed(texts, controller.signal)
          for (const vector of vectors) normalizeInPlace(vector)
          return vectors
        },
        {
          modelSignature: `raw-v3:${model.id}:${model.dimensions}:${this.settings.contextTokens}`,
          documentPrefix: model.documentPrefix,
          expectedDimensions: model.dimensions,
          signal: controller.signal,
          fitsContext: (text) => runtime.fitsContext(text, controller.signal),
          documentChars,
          onOversized: (thread, contentHash) => {
            this.summaryJobs.set(thread.id, {
              thread,
              contentHash,
              model,
              generation: this.generation
            })
          },
          onProgress: ({ total, pending }) => {
            this.sweepTotals = { total, pending }
            this.emitStatus()
          },
          onError: (thread, error) => {
            const detail = error instanceof Error ? error.message : String(error)
            this.indexingError = `Could not index "${thread.title.slice(0, 100)}": ${detail}`
            Logger.error('Thread search indexing skipped a failed thread', {
              threadId: thread.id,
              error: detail
            })
            this.emitStatus()
          },
          onThreadProgress: (thread, stage, chunks) => {
            const title = thread.title.slice(0, 100) || 'Untitled thread'
            this.indexingDetail = { threadTitle: title, stage, completedChunks: chunks }
            this.emitStatus()
          }
        }
      )
      this.sweepTotals = { total: result.total, pending: result.pending }
      this.intentReady =
        !controller.signal.aborted && this.index.pending === 0 && this.indexingError === null
      Logger.dev(`Thread embedding index swept (${reason})`, result)
    } catch (error) {
      if (controller.signal.aborted) return
      this.indexingError = error instanceof Error ? error.message : String(error)
      Logger.error('Thread embedding index sweep failed:', error)
    } finally {
      this.sweepController = null
      this.indexing = false
      this.indexingDetail = null
      this.emitStatus()
      this.startSummaries()
    }
  }

  private cancelSummaries(): void {
    this.generation += 1
    this.summaryJobs.clear()
    this.summaryController.abort()
    this.summaryController = new AbortController()
    this.summaryDetail = null
  }

  /** Optional refinements never hold up the raw/truncated indexing sweep. */
  private startSummaries(): void {
    if (
      this.disposed ||
      !this.settings.enabled ||
      this.summaryWorker ||
      this.summaryJobs.size === 0
    )
      return
    this.summaryWorker = this.drainSummaries().finally(() => {
      this.summaryWorker = null
      this.summaryDetail = null
      this.emitStatus()
      if (this.summaryJobs.size > 0) this.startSummaries()
    })
  }

  private async drainSummaries(): Promise<void> {
    while (!this.disposed && this.settings.enabled && this.summaryJobs.size > 0) {
      const entry = this.summaryJobs.entries().next().value
      if (!entry) return
      const [id, job] = entry
      this.summaryJobs.delete(id)
      if (job.generation !== this.generation) continue
      const signal = this.summaryController.signal
      const startedAt = performance.now()
      try {
        this.summaryDetail = {
          threadTitle: job.thread.title.slice(0, 100),
          stage: 'summarizing',
          completedChunks: 0
        }
        this.emitStatus()
        const summary = await this.summaries.get(job.thread, signal)
        if (signal.aborted || job.generation !== this.generation) continue
        this.summaryDetail = {
          threadTitle: job.thread.title.slice(0, 100),
          stage: 'embedding',
          completedChunks: 1
        }
        this.emitStatus()
        const runtime = await this.ensureRuntime(job.model)
        const vector = await this.embedOne(
          runtime,
          composeDocument(job.model.documentPrefix, job.thread.title, summary),
          signal
        )
        if (signal.aborted || job.generation !== this.generation) continue
        await this.index.applySummary(
          job.thread,
          job.contentHash,
          vector,
          summary,
          `raw-v3:${job.model.id}:${job.model.dimensions}:${this.settings.contextTokens}`
        )
      } catch (error) {
        if (!signal.aborted)
          Logger.dev('Optional search summary failed; keeping the truncated embedding.', {
            threadId: id,
            error: error instanceof Error ? error.message : String(error)
          })
      }
      if (this.summaryJobs.size > 0 && !signal.aborted)
        await paceIndexing(startedAt, signal).catch(() => undefined)
    }
  }

  private async loadSettings(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.storage.settingsPath, 'utf8'))
      if (raw && typeof raw === 'object') {
        const record = raw as Record<string, unknown>
        this.settings = {
          enabled: record['enabled'] === true,
          activeModelId:
            typeof record['activeModelId'] === 'string' ? record['activeModelId'] : null,
          contextTokens: clampSearchContextTokens(
            typeof record['contextTokens'] === 'number'
              ? record['contextTokens']
              : DEFAULT_SEARCH_SETTINGS.contextTokens
          )
        }
      }
    } catch {
      this.settings = { ...DEFAULT_SEARCH_SETTINGS }
    }
  }

  private async saveSettings(): Promise<void> {
    await writeJsonAtomic(this.storage.settingsPath, this.settings)
  }

  private async loadModelIndex(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.storage.modelIndexPath, 'utf8'))
      if (raw && typeof raw === 'object') {
        const models = (raw as Record<string, unknown>)['models']
        if (Array.isArray(models)) {
          this.models = models.filter(isInstalledSearchModel)
        }
      }
    } catch {
      this.models = []
    }
  }

  private async saveModelIndex(): Promise<void> {
    const payload: PersistedModelIndex = { version: 1, models: this.models }
    await writeJsonAtomic(this.storage.modelIndexPath, payload)
  }
}

function isInstalledSearchModel(value: unknown): value is InstalledSearchModel {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record['id'] === 'string' &&
    typeof record['directory'] === 'string' &&
    typeof record['dimensions'] === 'number' &&
    typeof record['runtime'] === 'string' &&
    typeof record['contextTokens'] === 'number' &&
    typeof record['queryPrefix'] === 'string' &&
    typeof record['documentPrefix'] === 'string' &&
    typeof record['byteSize'] === 'number' &&
    typeof record['installedAt'] === 'number'
  )
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  await rename(temporary, path)
}
