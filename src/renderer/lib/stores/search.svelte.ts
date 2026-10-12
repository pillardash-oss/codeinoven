import { invoke, subscribe } from '$lib/ipc.svelte'
import { toast } from 'svelte-sonner'
import { reportError } from './app-errors.svelte'
import type { SearchProgressEvent, SearchState } from '../../../lib/search/types'

/**
 * Renderer mirror of the intent-search state: catalog, installed models, live
 * downloads, index status, and settings. One instance is shared by the Search
 * settings page so a download and a background reindex both report live.
 */
class SearchSettingsStore {
  state = $state<SearchState | null>(null)
  loading = $state(false)
  error = $state('')
  private unsubscribe: (() => void) | null = null

  async load(): Promise<void> {
    this.loading = true
    this.error = ''
    try {
      this.state = await invoke('search:getState')
      this.unsubscribe ??= subscribe('search:progress', (progress) => this.onProgress(progress))
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      this.loading = false
    }
  }

  async download(artifactId: string): Promise<void> {
    try {
      await invoke('search:downloadArtifact', artifactId)
    } catch (cause) {
      reportError(cause, 'The embedding model could not be downloaded.')
    }
    await this.load()
  }

  async cancelDownload(artifactId: string): Promise<void> {
    try {
      await invoke('search:cancelDownload', artifactId)
    } catch (cause) {
      reportError(cause, 'The download could not be cancelled.')
    }
  }

  async deleteModel(modelId: string): Promise<void> {
    try {
      await invoke('search:deleteModel', modelId)
      await this.load()
    } catch (cause) {
      reportError(cause, 'The embedding model could not be removed.')
    }
  }

  /** Opens a native picker, then imports the chosen embedding model. */
  async importModel(): Promise<void> {
    try {
      const path = await invoke('search:pickModelFile')
      if (!path) return
      await invoke('search:importModel', path)
      toast.success('Embedding model imported.')
    } catch (cause) {
      reportError(cause, 'The embedding model could not be imported.')
    }
    await this.load()
  }

  async setEnabled(enabled: boolean): Promise<void> {
    try {
      await invoke('search:setEnabled', enabled)
      await this.load()
    } catch (cause) {
      reportError(cause, 'Intent search could not be toggled.')
    }
  }

  async setActiveModel(modelId: string | null): Promise<void> {
    try {
      await invoke('search:setActiveModel', modelId)
      await this.load()
    } catch (cause) {
      reportError(cause, 'The active model could not be changed.')
    }
  }

  async rebuildIndex(): Promise<void> {
    try {
      await invoke('search:rebuildIndex')
    } catch (cause) {
      reportError(cause, 'The search index could not be rebuilt.')
    }
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private onProgress(progress: SearchProgressEvent): void {
    if (!this.state) return
    if (progress.kind === 'download') {
      this.state = {
        ...this.state,
        downloads: { ...this.state.downloads, [progress.artifactId]: progress.download }
      }
      return
    }
    this.state = { ...this.state, status: progress.status }
  }
}

export const searchSettingsStore = new SearchSettingsStore()
