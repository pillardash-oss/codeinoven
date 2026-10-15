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

/**
 * Transient feedback for one attempt's retry, read by the history row to spin
 * the retry button while it runs and flash a check plus a copy highlight when
 * it lands.
 */
export type SpeechRetryStatus = 'running' | 'done'

/** How long the done check and copy highlight stay up before fading out. */
const RETRY_DONE_MS = 4_000

class SpeechSettingsStore {
  catalog = $state<SpeechModelCatalog | null>(null)
  capabilities = $state<SpeechCapabilitySnapshot | null>(null)
  history = $state<SpeechHistoryPage>({ items: [], total: 0 })
  lessons = $state<SpeechLesson[]>([])
  llamaRuntime = $state<SpeechLlamaRuntimeStatus | null>(null)
  downloads = $state<Record<string, SpeechDownloadState>>({})
  retryStatus = $state<Record<string, SpeechRetryStatus>>({})
  loading = $state(false)
  error = $state('')
  private unsubscribe: (() => void) | null = null
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()

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
  ): Promise<import('../../../lib/speech/types').SpeechInstalledArtifact | null> {
    const result = await invoke('speech:importModel', path, capability)
    if (!result.ok) this.error = result.error.message
    await this.load()
    return result.ok ? result.value : null
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
    if (this.retryStatus[attemptId] === 'running') return
    this.setRetryStatus(attemptId, 'running')
    try {
      const result = await invoke(
        'speech:retryTranscription',
        attemptId,
        runtime,
        artifactId,
        'auto'
      )
      if (!result.ok) {
        this.error = result.error.message
        this.setRetryStatus(attemptId, null)
        return
      }
      // Read the finished transcript back before the check goes up, so the row
      // text and the success feedback land in the same paint.
      await this.load()
      this.setRetryStatus(attemptId, 'done')
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause)
      this.setRetryStatus(attemptId, null)
    }
  }

  /**
   * Set, replace, or clear an attempt's retry feedback. A `done` status clears
   * itself after a short beat; pass null to drop it immediately (a failed
   * retry leaves the button as it was).
   */
  private setRetryStatus(attemptId: string, status: SpeechRetryStatus | null): void {
    const pending = this.retryTimers.get(attemptId)
    if (pending) {
      clearTimeout(pending)
      this.retryTimers.delete(attemptId)
    }
    const { [attemptId]: _cleared, ...rest } = this.retryStatus
    this.retryStatus = status ? { ...rest, [attemptId]: status } : rest
    if (status === 'done') {
      const timer = setTimeout(() => {
        this.retryTimers.delete(attemptId)
        const next = { ...this.retryStatus }
        delete next[attemptId]
        this.retryStatus = next
      }, RETRY_DONE_MS)
      this.retryTimers.set(attemptId, timer)
    }
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
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
  }

  private onProgress(progress: SpeechProgressEvent): void {
    if (progress.kind === 'download') {
      this.downloads = { ...this.downloads, [progress.artifactId]: progress.download }
      // A finished download changes the installed set, so the page must re-read
      // it   otherwise the new model shows up only after leaving and reopening
      // the page, which is exactly the lag the install badge must not have.
      if (progress.download.state === 'installed') void this.load()
      return
    }
    if (progress.kind === 'history') void this.load()
  }
}

export const speechSettingsStore = new SpeechSettingsStore()
