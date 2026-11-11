import { displayDeviceCommand } from '../../lib/display-device-command'
import { Logger } from '../system/logger'
import { displayRequests } from './display-requests'

/**
 * The app's own reading of the device work an agent already started.
 *
 * `ext_simulation` is how an agent announces a device, but an agent that went
 * straight to `adb` or `simctl` never calls it, and the panel stayed hidden while
 * the person watched a thread test an emulator blind. This module closes that
 * gap without a watch: it is handed the tool calls a session publishes, reads the
 * command text, and asks the display panel to mirror the device that command is
 * on. A thread that runs no device command costs one regex per tool call, and the
 * display service is only loaded when a device command is actually seen.
 *
 * Asking is deliberately slow on repeats. A device session issues many `adb`
 * commands, and each ask would list the devices again, so one thread re-announces
 * the same platform at most once every few minutes unless the last ask found
 * nothing (a device that is still booting), which is retried sooner.
 */

/** A thread re-announces a platform it already mirrored at most this often. */
const MIRRORED_COOLDOWN_MS = 2 * 60_000
/** A device that was not there yet (still booting) is looked for again sooner. */
const MISSING_COOLDOWN_MS = 30_000
/** Ceiling on remembered threads, so a long-lived app keeps a bounded map. */
const MAX_REMEMBERED_THREADS = 256

interface AskRecord {
  at: number
  mirrored: boolean
}

class DisplayDeviceAttention {
  private readonly asked = new Map<string, AskRecord>()
  private readonly asking = new Set<string>()

  /**
   * Note one tool call and mirror the device it works on, when it works on one.
   *
   * The call's input is what decides: no device command, no work. A tool call
   * whose input is already being asked about is skipped rather than queued, so a
   * harness that republishes the same running call cannot ask twice.
   */
  noteToolCall(threadId: string, input: Record<string, unknown>): void {
    if (threadId.length === 0) return
    const command = displayDeviceCommand(input)
    if (!command) return
    const key = `${threadId}:${command.platform}`
    if (this.asking.has(key)) return
    const previous = this.asked.get(key)
    if (previous) {
      const cooldown = previous.mirrored ? MIRRORED_COOLDOWN_MS : MISSING_COOLDOWN_MS
      if (Date.now() - previous.at < cooldown) return
    }
    this.asking.add(key)
    void displayRequests
      .request({
        platform: command.platform,
        ...(command.device ? { device: command.device } : {}),
        threadId
      })
      .then((result) => {
        this.remember(key, result.ok)
      })
      .catch((error: unknown) => {
        this.remember(key, false)
        Logger.dev('The display panel could not follow the agent to its device:', error)
      })
      .finally(() => {
        this.asking.delete(key)
      })
  }

  /** Forget a thread that is gone, so its next turn starts clean. */
  forget(threadId: string): void {
    const prefix = `${threadId}:`
    for (const key of [...this.asked.keys()]) {
      if (key.startsWith(prefix)) this.asked.delete(key)
    }
  }

  private remember(key: string, mirrored: boolean): void {
    this.asked.set(key, { at: Date.now(), mirrored })
    if (this.asked.size <= MAX_REMEMBERED_THREADS) return
    const oldest = [...this.asked.entries()].sort((left, right) => left[1].at - right[1].at)
    for (const [stale] of oldest.slice(0, this.asked.size - MAX_REMEMBERED_THREADS)) {
      this.asked.delete(stale)
    }
  }
}

export const displayDeviceAttention = new DisplayDeviceAttention()
