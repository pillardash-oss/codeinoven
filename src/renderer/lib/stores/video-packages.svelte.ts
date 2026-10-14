import { invoke, subscribe } from '$lib/ipc.svelte'
import type { VideoPackagesProgressEvent, VideoPackagesState } from '$shared/ipc/video-packages'
import { reportError } from './app-errors.svelte'

/**
 * Renderer mirror of the optional video pack state.
 *
 * The pack installs at runtime from Settings > Design and video. A package
 * manager install takes minutes and reports no percentage, so the state stream
 * carries the phase and the block renders it indeterminate. One instance is
 * shared by the settings block and any surface that needs the pack's state.
 */
class VideoPackagesStore {
  state = $state<VideoPackagesState | null>(null)
  loading = $state(false)
  error = $state('')
  private unsubscribe: (() => void) | null = null

  async load(): Promise<void> {
    this.loading = true
    this.error = ''
    try {
      this.state = await invoke('video:packages:state')
      this.unsubscribe ??= subscribe('video:packages:progress', (state) =>
        this.applyProgress(state)
      )
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      this.loading = false
    }
  }

  async install(): Promise<void> {
    try {
      await invoke('video:packages:install')
    } catch (cause) {
      // A user cancellation rejects the install too; it is not a failure to report.
      const message = cause instanceof Error ? cause.message : String(cause)
      if (!/cancel/iu.test(message)) {
        reportError(cause, 'The optional video pack could not be installed.')
      }
    }
    await this.load()
  }

  async remove(): Promise<void> {
    try {
      await invoke('video:packages:remove')
    } catch (cause) {
      reportError(cause, 'The optional video pack could not be removed.')
    }
    await this.load()
  }

  async cancel(): Promise<void> {
    try {
      await invoke('video:packages:cancel')
    } catch (cause) {
      reportError(cause, 'The video pack install could not be cancelled.')
    }
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private applyProgress(progress: VideoPackagesProgressEvent): void {
    this.state = progress
  }
}

export const videoPackagesStore = new VideoPackagesStore()
