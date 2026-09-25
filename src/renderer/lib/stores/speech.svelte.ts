import { invoke, subscribe } from '$lib/ipc.svelte'
import { toast } from 'svelte-sonner'
import { reportError } from './app-errors.svelte'
import type {
  SpeechCapabilitySnapshot,
  SpeechDownloadState,
  SpeechHistoryPage,
  SpeechLlamaRuntimeStatus,
  SpeechLesson,
  SpeechModelCatalog,
  SpeechProgressEvent,
  SpeechRuntime
} from '../../../lib/speech/types'

class SpeechSettingsStore {
  catalog = $state<SpeechModelCatalog | null>(null)
  capabilities = $state<SpeechCapabilitySnapshot | null>(null)
  history = $state<SpeechHistoryPage>({ items: [], total: 0 })
  lessons = $state<SpeechLesson[]>([])
  llamaRuntime = $state<SpeechLlamaRuntimeStatus | null>(null)
  downloads = $state<Record<string, SpeechDownloadState>>({})
  loading = $state(false)
  error = $state('')
  private unsubscribe: (() => void) | null = null

  async load(): Promise<void> {
    this.loading = true
    this.error = ''
    try {
      const [catalog, capabilities, history, lessons, llama] = await Promise.all([
        invoke('speech:getCatalog'),
        invoke('speech:getCapabilities'),
        invoke('speech:getHistory', undefined, 50),
        invoke('speech:getLessons', undefined),
        invoke('speech:getLlamaRuntimeStatus')
      ])
      if (!catalog.ok) throw new Error(catalog.error.message)
      if (!capabilities.ok) throw new Error(capabilities.error.message)
      if (!history.ok) throw new Error(history.error.message)
      if (!lessons.ok) throw new Error(lessons.error.message)
      this.catalog = catalog.value
      this.capabilities = capabilities.value
      this.history = history.value
      this.lessons = lessons.value
      if (llama.ok) this.llamaRuntime = llama.value
      this.unsubscribe ??= subscribe('speech:progress', (progress) => this.onProgress(progress))
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      this.loading = false
    }
  }

  async download(artifactId: string): Promise<void> {
    this.error = ''
    try {
      const result = await invoke('speech:downloadArtifact', artifactId)
      if (!result.ok) {
        this.error = result.error.message
        toast.error(result.error.message)
        return
      }
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause)
      reportError(cause, 'The speech model could not be downloaded.')
      return
    }
    await this.load()
  }

  async importModel(
    path: string,
    capability?: import('../../../lib/speech/types').SpeechCapability
  ): Promise<boolean> {
    const result = await invoke('speech:importModel', path, capability)
    if (!result.ok) this.error = result.error.message
    await this.load()
    return result.ok
  }

  async unregisterModel(artifactId: string, token: string): Promise<boolean> {
    const result = await invoke('speech:unregisterModel', artifactId, token)
    if (!result.ok) this.error = result.error.message
    await this.load()
    return result.ok
  }

  async cancelDownload(artifactId: string): Promise<void> {
    await invoke('speech:cancelDownload', artifactId)
  }

  async retry(attemptId: string, runtime: SpeechRuntime, artifactId: string): Promise<void> {
    const result = await invoke('speech:retryTranscription', attemptId, runtime, artifactId, 'auto')
    if (!result.ok) this.error = result.error.message
    await this.load()
  }

  async setRuleEnabled(lessonId: string, enabled: boolean): Promise<void> {
    const result = await invoke('speech:setLessonEnabled', lessonId, enabled)
    if (!result.ok) this.error = result.error.message
    await this.load()
  }

  async deleteLesson(lessonId: string, token: string): Promise<boolean> {
    const result = await invoke('speech:deleteLesson', lessonId, token)
    if (!result.ok) this.error = result.error.message
    await this.load()
    return result.ok
  }

  async downloadLlamaRuntime(): Promise<void> {
    this.error = ''
    try {
      const result = await invoke('speech:downloadLlamaRuntime')
      if (!result.ok) {
        this.error = result.error.message
        toast.error(result.error.message)
      }
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause)
      reportError(cause, 'The speech runtime could not be downloaded.')
    }
    await this.load()
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private onProgress(progress: SpeechProgressEvent): void {
    if (progress.kind === 'download') {
      this.downloads = { ...this.downloads, [progress.artifactId]: progress.download }
      return
    }
    if (progress.kind === 'history') void this.load()
  }
}

export const speechSettingsStore = new SpeechSettingsStore()
