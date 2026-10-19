import { readFile, writeFile, rename, rm } from 'node:fs/promises'
import type { Database } from '../database/database'
import { Logger } from '../system/logger'
import { paceIndexing } from './indexing-pacing'
import { GLOBAL_BROWSER_PROJECT_ID, type Thread, type ThreadStatus } from '../../lib/types'
import { SEARCH_MODEL_CATALOG, searchModelsForRuntime } from '../../lib/search/model-catalog'
import {
  clampSearchContextTokens,
  DEFAULT_SEARCH_SETTINGS,
  SEARCH_MAX_WINDOWS_PER_THREAD,
  SEARCH_MIN_RUNTIME_BUILD,
  SEARCH_WINDOW_CHARS,
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
import type { ThreadIndexOptions } from './thread-embedding-index'
import { SearchStorage } from './search-storage'
import {
  ThreadSearchSummaries,
  type SearchSummaryExecutor,
  type SearchSummaryThread
} from './thread-search-summary'

/** Interval between light staleness sweeps while intent search is enabled. */
const PERIODIC_SWEEP_MS = 5 * 60 * 1000

/**
 * How long after a run settles its thread is indexed.
 *
 * The transcript is already persisted when the settle status is written, so this
 * is only insurance for the writes a settle sets in motion around it (an
 * auto-title, the turn's checkpoint row). Long enough for those to land, short
 * enough to read as immediate to the user who just finished the run.
 */
const SETTLED_INDEX_DELAY_MS = 2_000

/**
 * Statuses that mean a run stopped producing content, so the conversation a user
 * can search is stable. `awaiting_approval` is deliberately absent: it is the
 * mid-turn gate for a permission, question, or secret card, and the run resumes
 * into more content after it, so indexing there is churn rather than freshness.
 */
const SETTLED_THREAD_STATUSES: ReadonlySet<ThreadStatus> = new Set([
  'completed',
  'failed',
  'interrupted',
  'spec'
])

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
  /** A warm-up boot is in flight; a second one would only duplicate it. */
  private warming = false
  private sweep: Promise<void> | null = null
  private sweepTotals: { total: number | null; pending: number } = { total: null, pending: 0 }
  private indexing = false
  private periodicTimer: ReturnType<typeof setInterval> | null = null
  private corpusTimer: ReturnType<typeof setTimeout> | null = null
  /** Threads whose run just settled, awaiting an immediate targeted index pass. */
  private readonly settledIndexQueue = new Set<string>()
  private settledIndexTimer: ReturnType<typeof setTimeout> | null = null
  private settledIndexWorker: Promise<void> | null = null
  private settledIndexController: AbortController | null = null
  /** Last status seen per thread, so a settle is read as a transition. */
  private readonly threadStatuses = new Map<string, ThreadStatus>()
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
    this.refreshPeriodicSweep()
  }

  /**
   * Arm or clear the periodic staleness sweep for the settings as they are now.
   *
   * A pass only has work when intent search is on, a model is active, and the
   * local runtime can embed, so with any of the three missing the interval is
   * cleared rather than waking up every five minutes to skip itself. Every write
   * that can change one of the three calls this, which is why the sweep no longer
   * has to re-check the same three inside its own callback.
   */
  private refreshPeriodicSweep(): void {
    if (this.disposed) return
    if (this.settings.enabled && this.activeModel() && this.canEmbed()) this.armPeriodicSweep()
    else this.clearPeriodicSweep()
  }

  private armPeriodicSweep(): void {
    if (this.periodicTimer) return
    this.periodicTimer = setInterval(() => void this.runSweep('periodic'), PERIODIC_SWEEP_MS)
    // Never keep the process alive solely for the sweep timer.
    this.periodicTimer.unref?.()
  }

  private clearPeriodicSweep(): void {
    if (!this.periodicTimer) return
    clearInterval(this.periodicTimer)
    this.periodicTimer = null
  }

  private updateCorpusThread(thread: Thread): void {
    const previousStatus = this.threadStatuses.get(thread.id)
    this.threadStatuses.set(thread.id, thread.status)
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
    // A run that just stopped producing content is indexed now: its user can be
    // searching the conversation they just finished, and the next sweep is
    // minutes away (and hours away when a first backfill is still running).
    if (
      previousStatus !== undefined &&
      !SETTLED_THREAD_STATUSES.has(previousStatus) &&
      SETTLED_THREAD_STATUSES.has(thread.status)
    ) {
      this.queueSettledIndex(thread.id)
    }
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

  /**
   * Queue the thread a finished run belongs to for an immediate index pass.
   *
   * Debounced so a settle that lands while its last writes are still in flight is
   * indexed once, against the complete conversation rather than a partial one.
   */
  private queueSettledIndex(threadId: string): void {
    if (this.disposed) return
    this.settledIndexQueue.add(threadId)
    if (this.settledIndexTimer) return
    this.settledIndexTimer = setTimeout(() => {
      this.settledIndexTimer = null
      void this.drainSettledIndex()
    }, SETTLED_INDEX_DELAY_MS)
    this.settledIndexTimer.unref()
  }

  /**
   * Index every settled thread waiting in the queue, then hand the optional
   * summaries they asked for to the summary worker.
   *
   * This runs beside the corpus sweep rather than behind it on purpose: a first
   * full pass can take hours on a large corpus, and a thread the user just
   * finished must not stay invisible to meaning-based search for that whole time.
   * One worker serializes the passes, the embedding runtime serializes its own
   * requests, and a failure is logged and left to the next sweep.
   */
  private async drainSettledIndex(): Promise<void> {
    if (this.settledIndexWorker) return
    this.settledIndexWorker = (async () => {
      while (!this.disposed && this.settledIndexQueue.size > 0) {
        const model = this.activeModel()
        if (!this.settings.enabled || !model || !this.canEmbed()) {
          this.settledIndexQueue.clear()
          return
        }
        const ids = [...this.settledIndexQueue]
        this.settledIndexQueue.clear()
        await this.indexSettledThreads(ids, model)
      }
    })().finally(() => {
      this.settledIndexWorker = null
    })
    await this.settledIndexWorker
  }

  private async indexSettledThreads(
    ids: readonly string[],
    model: InstalledSearchModel
  ): Promise<void> {
    const controller = new AbortController()
    this.settledIndexController = controller
    try {
      const runtime = await this.ensureRuntime(model)
      const options: ThreadIndexOptions = {
        modelSignature: modelSignatureOf(
          model,
          embeddingWorkingContext(this.settings.contextTokens)
        ),
        documentPrefix: model.documentPrefix,
        windowChars: SEARCH_WINDOW_CHARS,
        maxWindows: SEARCH_MAX_WINDOWS_PER_THREAD,
        expectedDimensions: model.dimensions,
        signal: controller.signal,
        onOversized: (thread) => {
          this.summaryJobs.set(thread.id, { thread, model, generation: this.generation })
        }
      }
      for (const id of ids) {
        if (this.disposed) return
        if (!this.settings.enabled || this.settings.activeModelId !== model.id) return
        const startedAt = performance.now()
        await this.index.indexNow(
          id,
          (texts) => this.embedWith(runtime, texts, controller.signal),
          options
        )
        await paceIndexing(startedAt, controller.signal)
      }
    } catch (error) {
      if (!controller.signal.aborted) Logger.error('Immediate thread indexing failed:', error)
    } finally {
      if (this.settledIndexController === controller) this.settledIndexController = null
      this.emitStatus()
      this.startSummaries()
    }
  }

  private removeCorpusThread(id: string): void {
    this.threadStatuses.delete(id)
    this.settledIndexQueue.delete(id)
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
    this.refreshPeriodicSweep()
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
    this.settings.enabled = enabled
    if (!enabled) {
      this.sweepController?.abort()
      this.settledIndexController?.abort()
      this.settledIndexQueue.clear()
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
    this.refreshPeriodicSweep()
    this.emitStatus()
  }

  async setActiveModel(modelId: string | null): Promise<void> {
    if (modelId !== null && !this.models.some((model) => model.id === modelId)) {
      throw new Error('The selected model is not installed.')
    }
    const previous = this.settings.activeModelId
    if (previous === modelId) return
    await this.stopSweep()
    this.settings.activeModelId = modelId
    await this.saveSettings()
    // A different model produces a different vector space, so the existing
    // index is meaningless. Drop it and rebuild.
    await this.disposeRuntime()
    await this.index.reset()
    this.sweepTotals = { total: null, pending: 0 }
    if (this.settings.enabled && modelId && this.canEmbed()) await this.runSweep('model-changed')
    this.refreshPeriodicSweep()
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
    await this.stopSweep()
    await this.index.reset()
    this.sweepTotals = { total: null, pending: 0 }
    if (this.settings.enabled && this.activeModel() && this.canEmbed()) {
      await this.runSweep('rebuild')
    }
    this.emitStatus()
  }

  /**
   * Semantic matches for a query, ranked from whatever the index holds right now.
   *
   * A background sweep never suppresses an answer: every thread already indexed
   * carries complete vectors for the revision it was embedded from, so partial
   * coverage only means fewer candidates, never a wrong one. Gating on the sweep
   * instead made search silently keyword-only for as long as indexing ran, which
   * with one thread every few seconds of work is most of a working day.
   *
   * Returns an empty list when intent search is off, no model is ready, nothing is
   * indexed yet, or the embedding fails, so the hybrid search falls back to
   * keyword results.
   *
   * A cold runtime is booted here, so this can take tens of seconds on the first
   * call of a session. That is deliberate: the only caller that awaits it is the
   * spotlight's deferred enrichment, whose keyword rows are already on screen.
   * Warm-ups at boot and on Cmd+K are what keep the wait rare.
   */
  async searchIntent(query: string, limit: number): Promise<IntentThreadMatch[]> {
    const model = this.activeModel()
    if (!this.settings.enabled || !model) return []
    if (this.index.size === 0) return []
    if (!this.canEmbed()) return []
    const trimmed = query.trim()
    if (trimmed.length === 0) return []
    const document = `${model.queryPrefix}${trimmed}`
    const controller = new AbortController()
    try {
      const runtime = await this.ensureRuntime(model)
      const vector = await this.embedOne(runtime, document, controller.signal)
      // A rebuild, disable, or model change may have started during embedding.
      if (!this.settings.enabled || this.settings.activeModelId !== model.id) return []
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
    if (this.settledIndexTimer) clearTimeout(this.settledIndexTimer)
    this.settledIndexTimer = null
    this.settledIndexQueue.clear()
    this.settledIndexController?.abort()
    this.unsubscribeCorpus?.()
    this.unsubscribeCorpus = null
    this.sweepController?.abort()
    this.cancelSummaries()
    this.clearPeriodicSweep()
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
    const modelReady = Boolean(model) && runtimeAvailable && runtimeSupported
    return {
      // Active means "a query right now would return semantic matches": enabled,
      // a runtime that can embed, and at least one thread already indexed. It no
      // longer flickers off whenever the background sweep is running.
      active: this.settings.enabled && modelReady && this.index.size > 0,
      runtimeAvailable,
      runtimeSupported,
      runtimeBuild,
      modelReady,
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
    this.refreshPeriodicSweep()
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
    const [vector] = await this.embedWith(runtime, [text], signal)
    if (!vector) throw new Error('The embedding model returned no vector.')
    return vector
  }

  /** Embed a batch through the runtime, normalizing every vector in place. */
  private async embedWith(
    runtime: EmbeddingRuntime,
    texts: readonly string[],
    signal: AbortSignal
  ): Promise<Float32Array[]> {
    const vectors = await runtime.embed(texts, signal)
    for (const vector of vectors) normalizeInPlace(vector)
    return vectors
  }

  /**
   * Boot the embedding model in the background, off every interactive path.
   *
   * Called once the workspace is interactive (main's `workspace:ready`) and
   * again whenever the spotlight opens, so a Cmd+K thread search finds a
   * resident model instead of paying a cold load inside its semantic step. A
   * no-op unless intent search is enabled with a model the local runtime can
   * load, and idempotent while a boot is already in flight.
   *
   * The embed is not about the text: it is what re-arms the runtime's idle timer
   * (five minutes), so a warm-up nobody follows up on is retired again instead of
   * holding the model for the rest of the session.
   */
  warm(): void {
    const model = this.activeModel()
    if (!this.settings.enabled || !model || !this.canEmbed()) return
    if (this.runtimeResident() || this.warming) return
    this.warming = true
    void this.warmRuntime(model, `${model.queryPrefix}warm`).finally(() => {
      this.warming = false
    })
  }

  private async warmRuntime(model: InstalledSearchModel, text: string): Promise<void> {
    try {
      const runtime = await this.ensureRuntime(model)
      await this.embedOne(runtime, text, new AbortController().signal)
    } catch (error) {
      Logger.dev('Embedding runtime warm-up failed.', error)
    }
  }

  /** Whether the model is loaded, so an embed would not pay a boot first. */
  private runtimeResident(): boolean {
    return this.runtime?.isResident() ?? false
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
    this.settledIndexController?.abort()
    await this.sweep
  }

  private async performSweep(reason: string): Promise<void> {
    const model = this.activeModel()
    if (!model) return
    if (!this.canEmbed()) return
    if (this.index.pending === 0) {
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
      // The runtime's physical window sizes one embedding; a thread's windows are
      // spread across its whole conversation at a fixed, measured character width
      // so every thread is sampled on the same scale.
      const effectiveTokens = embeddingWorkingContext(this.settings.contextTokens)
      const modelSignature = modelSignatureOf(model, effectiveTokens)
      const result = await this.index.sweep(
        (texts) => this.embedWith(runtime, texts, controller.signal),
        {
          modelSignature,
          documentPrefix: model.documentPrefix,
          windowChars: SEARCH_WINDOW_CHARS,
          maxWindows: SEARCH_MAX_WINDOWS_PER_THREAD,
          expectedDimensions: model.dimensions,
          signal: controller.signal,
          onOversized: (thread) => {
            this.summaryJobs.set(thread.id, {
              thread,
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
          onThreadProgress: (thread, stage, windows) => {
            const title = thread.title.slice(0, 100) || 'Untitled thread'
            this.indexingDetail = { threadTitle: title, stage, completedChunks: windows }
            this.emitStatus()
          }
        }
      )
      this.sweepTotals = { total: result.total, pending: result.pending }
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
      if (job.generation !== this.generation || this.index.isParked(id)) continue
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
        if (signal.aborted || job.generation !== this.generation || this.index.isParked(id))
          continue
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
        if (signal.aborted || job.generation !== this.generation || this.index.isParked(id))
          continue
        await this.index.applySummary(
          job.thread,
          vector,
          summary,
          modelSignatureOf(job.model, embeddingWorkingContext(this.settings.contextTokens))
        )
      } catch (error) {
        if (!signal.aborted)
          Logger.dev('Optional search summary failed; keeping the window embeddings.', {
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

/**
 * Identity of the vectors one model produces. It is part of every window
 * fingerprint, so changing the model - or the physical window, which decides how
 * much of a window is actually read - retires the vectors built under the
 * previous pair instead of mixing incomparable spaces in one index.
 */
function modelSignatureOf(model: InstalledSearchModel, effectiveTokens: number): string {
  return `windows-v4:${model.id}:${model.dimensions}:${effectiveTokens}:${SEARCH_WINDOW_CHARS}`
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
