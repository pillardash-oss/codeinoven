import type { ComputerUseActivity, ComputerUsePipFrame, ComputerUsePipState } from '$shared/types'
import { invoke, subscribe } from '$lib/ipc.svelte'

/**
 * Live state for the floating computer-use PiP monitor. Main process streams
 * frames of the app an agent is driving; the overlay renders the latest frame
 * and can bring the app to the front.
 *
 * It also mirrors per-thread computer-use activity, which thread rows use for
 * their cursor indicator. That mirror is intentionally not the same thing as
 * `active`: the overlay needs a capturable window, while a desktop-scoped run
 * has no pid at all. The mirror also outlives a dismissed overlay, so closing
 * the preview no longer hides the fact that the agent is still driving.
 */
class PipState {
  active = $state(false)
  pid: number | null = $state(null)
  appName = $state('')
  threadId: string | null = $state(null)
  frameDataUrl: string | null = $state(null)
  frameWidth = $state(0)
  frameHeight = $state(0)
  cursorVisible = $state(false)
  cursorX = $state(0)
  cursorY = $state(0)
  timestamp = $state(0)
  /** Threads whose agent is driving the computer right now, keyed by thread id. */
  activity = $state<Record<string, ComputerUseActivity>>({})

  private cleanups: Array<() => void> = []
  /** Last device width reported to main, so an unchanged demand never costs an
   *  IPC round trip. Not reactive: nothing in the UI renders from it. */
  private reportedFrameWidth = 0

  init(): void {
    const unsubFrame = subscribe('computerUse:pipFrame', (frame: ComputerUsePipFrame) => {
      this.applyFrame(frame)
    })
    this.cleanups.push(unsubFrame)

    const unsubState = subscribe('computerUse:pipState', (state: ComputerUsePipState) => {
      this.applyState(state)
    })
    this.cleanups.push(unsubState)

    const unsubActivity = subscribe('computerUse:activity', (activity: ComputerUseActivity) => {
      this.applyActivity(activity)
    })
    this.cleanups.push(unsubActivity)

    void this.refresh()
  }

  destroy(): void {
    for (const cleanup of this.cleanups) cleanup()
    this.cleanups = []
  }

  async refresh(): Promise<void> {
    try {
      const state = await invoke('computerUse:pipGetState')
      this.applyState(state)
    } catch {
      // PiP service unavailable — keep the overlay hidden.
    }
    try {
      const activity = await invoke('computerUse:activityGet')
      this.activity = Object.fromEntries(activity.map((entry) => [entry.threadId, entry]))
    } catch {
      // PiP service unavailable — no thread is marked as using the computer.
    }
  }

  /** Whether this thread's agent is driving the computer right now. */
  isThreadUsingComputerUse(threadId: string): boolean {
    return this.activity[threadId]?.active === true
  }

  /** When this thread's most recent computer-use action ran, or 0 when none. */
  threadActivityAt(threadId: string): number {
    return this.activity[threadId]?.at ?? 0
  }

  async bringToFront(): Promise<void> {
    try {
      await invoke('computerUse:pipBringToFront')
    } catch {
      // The target app may have quit — the next state event hides the overlay.
    }
  }

  /**
   * Tell main how many device pixels wide the preview is about to be painted, so
   * the captured frame is never upscaled. Called by the overlay whenever its
   * footprint changes; repeated values are dropped here.
   */
  setFrameDemand(deviceWidth: number): void {
    const next = Math.round(deviceWidth)
    if (next <= 0 || next === this.reportedFrameWidth) return
    this.reportedFrameWidth = next
    void invoke('computerUse:pipSetFrameWidth', next).catch(() => {
      // Main may no longer own the PiP service; the next change reports again,
      // so a dropped demand is never permanent.
      this.reportedFrameWidth = 0
    })
  }

  async dismiss(): Promise<void> {
    try {
      await invoke('computerUse:pipDismiss')
    } catch {
      // Fall through — the overlay hides locally on the next state event anyway.
    }
    this.applyState({ active: false })
  }

  private applyActivity(activity: ComputerUseActivity): void {
    const next = { ...this.activity }
    if (activity.active) next[activity.threadId] = activity
    else delete next[activity.threadId]
    this.activity = next
  }

  private applyFrame(frame: ComputerUsePipFrame): void {
    // A frame already in flight when the overlay was dismissed must not
    // resurrect it — only apply frames while the main process is tracking.
    if (!this.active) return
    this.pid = frame.pid
    this.appName = frame.appName
    this.frameDataUrl = frame.dataUrl
    this.frameWidth = frame.width
    this.frameHeight = frame.height
    this.cursorVisible = frame.cursor?.visible ?? false
    this.cursorX = frame.cursor?.x ?? this.cursorX
    this.cursorY = frame.cursor?.y ?? this.cursorY
    this.timestamp = frame.timestamp
  }

  private applyState(state: ComputerUsePipState): void {
    this.active = state.active
    if (state.active) {
      this.pid = state.pid ?? null
      this.appName = state.appName ?? this.appName
      this.threadId = state.threadId ?? this.threadId
    } else {
      this.pid = null
      this.appName = ''
      this.threadId = null
      this.frameDataUrl = null
      this.frameWidth = 0
      this.frameHeight = 0
      this.cursorVisible = false
      this.cursorX = 0
      this.cursorY = 0
    }
  }
}

export const pipState = new PipState()
