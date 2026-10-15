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
  /**
   * How many surfaces are currently reading this store.
   *
   * The state is app-wide but its listener is not: an install started from
   * Settings has to reach a board that is already mounted, so the subscription
   * outlives either surface alone. Mounting adds a reader and unmounting removes
   * one, and the listener is dropped only when the last one goes.
   */
  private users = 0

  async load(): Promise<void> {
    this.users += 1
    this.unsubscribe ??= subscribe('video:packages:progress', (state) => this.applyProgress(state))
    await this.read()
  }

  /** Read the state once, without claiming a reader. */
  private async read(): Promise<void> {
    this.loading = true
    this.error = ''
    try {
      this.state = await invoke('video:packages:state')
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
    await this.read()
  }

  async remove(): Promise<void> {
    try {
      await invoke('video:packages:remove')
    } catch (cause) {
      reportError(cause, 'The optional video pack could not be removed.')
    }
    await this.read()
  }

  async cancel(): Promise<void> {
    try {
      await invoke('video:packages:cancel')
    } catch (cause) {
      reportError(cause, 'The video pack install could not be cancelled.')
    }
  }

  dispose(): void {
    this.users = Math.max(0, this.users - 1)
    if (this.users > 0) return
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private applyProgress(progress: VideoPackagesProgressEvent): void {
    this.state = progress
  }
}

export const videoPackagesStore = new VideoPackagesStore()
