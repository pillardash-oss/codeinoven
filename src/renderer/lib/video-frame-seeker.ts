import type { BrowserCompositionPlayback } from '$shared/ipc-contract'

/** One active render and one latest target. No pointer-move IPC backlog. */
export class VideoFrameSeeker {
  private pending: { tabId: string; time: number } | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private busy = false
  private generation = 0

  constructor(
    private readonly send: (
      tabId: string,
      time: number
    ) => Promise<BrowserCompositionPlayback | null>,
    private readonly apply: (tabId: string, state: BrowserCompositionPlayback) => void
  ) {}

  seek(tabId: string, time: number): void {
    this.pending = { tabId, time }
    this.schedule()
  }

  clear(): void {
    this.generation += 1
    this.pending = null
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(): void {
    if (this.busy || this.timer !== undefined || !this.pending) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.drain()
    }, 32)
  }

  private async drain(): Promise<void> {
    const request = this.pending
    if (!request) return
    this.pending = null
    this.busy = true
    const generation = this.generation
    try {
      const result = await this.send(request.tabId, request.time)
      if (generation === this.generation && !this.pending && result)
        this.apply(request.tabId, result)
    } catch {
      // A composition can close or navigate during a scrub.
    } finally {
      this.busy = false
      this.schedule()
    }
  }
}
