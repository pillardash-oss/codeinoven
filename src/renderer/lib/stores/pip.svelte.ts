import type { ComputerUsePipFrame, ComputerUsePipState } from '$shared/types'
import { invoke, subscribe } from '$lib/ipc.svelte'

/**
 * Live state for the floating computer-use PiP monitor. Main process streams
 * frames of the app an agent is driving; the overlay renders the latest frame
 * and can bring the app to the front.
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

  private cleanups: Array<() => void> = []

  init(): void {
    const unsubFrame = subscribe('computerUse:pipFrame', (frame: ComputerUsePipFrame) => {
      this.applyFrame(frame)
    })
    this.cleanups.push(unsubFrame)

    const unsubState = subscribe('computerUse:pipState', (state: ComputerUsePipState) => {
      this.applyState(state)
    })
    this.cleanups.push(unsubState)

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
  }

  async bringToFront(): Promise<void> {
    try {
      await invoke('computerUse:pipBringToFront')
    } catch {
      // The target app may have quit — the next state event hides the overlay.
    }
  }

  async dismiss(): Promise<void> {
    try {
      await invoke('computerUse:pipDismiss')
    } catch {
      // Fall through — the overlay hides locally on the next state event anyway.
    }
    this.applyState({ active: false })
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
