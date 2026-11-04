import type { DisplayAvailability } from '../../lib/ipc/display'

/**
 * Whether an agent is driving something the display panel could show.
 *
 * The panel is not a tool a user browses to: it is a window into work an agent
 * started (an emulator, a booted simulator, a screen it is driving). So the app
 * must not look for one until an agent is actually working, and it must not look
 * on a timer while nothing runs.
 *
 * Detection is the cheapest signal the app already has: the harness subprocess
 * tree the agent process service tracks. A turn that starts `emulator`, `adb`,
 * `simctl`, `scrcpy` or `Simulator.app` leaves one of those in that tree, so one
 * process-table read per check answers the question without touching the devices
 * themselves. That read only happens while a turn is running, and it stops the
 * moment nothing is.
 */
export interface DisplayPresenceDeps {
  /** Every process the agent process service currently tracks. Never cached here. */
  listAgentProcesses: () => Promise<TrackedCommand[]>
  /** Called once, the first time a display target is seen. */
  onAvailable: () => void
}

/** One tracked process, as the decision needs it. */
export interface TrackedCommand {
  command: string
  /** The thread that owns it; null for an app-owned runtime. */
  threadId?: string | null
}

/** `adb` doing device work: a chosen target, a shell, an install, a screenshot. */
const DEVICE_ADB_USE =
  /(^|[\s/])adb($|\s)[\s\S]*\b(-s\s|devices|shell|exec-out|exec-in|install|uninstall|logcat|screencap|screenrecord|emu\s|push|pull|getprop|forward|reverse|reboot)\b/u
/** A device runtime the agent started itself. */
const DEVICE_TOOL = /(^|[\s/])(emulator|qemu-system[\w-]*|simctl|scrcpy)($|[\s/])/u
/** The Simulator or Android Emulator application, launched by an agent. */
const DEVICE_APP = /(^|[\s/])(Simulator|Android Emulator)\.app($|[\s/])/u
/** The adb server daemon, which outlives every client and belongs to no target. */
const ADB_SERVER = /\badb\b[\s\S]*\b(fork-server|start-server)\b/u

/**
 * A command that means an agent has a display target in hand.
 *
 * Two rules keep this from opening the panel on the wrong thing:
 *
 *  - The process has to belong to a thread. The process service also lists the
 *    app's own runtimes (a speech worker, a shared harness server), and those are
 *    not an agent driving a device.
 *  - `adb` only counts when it is doing something with a device. The adb *server*
 *    stays running once anything has ever used adb (`adb -L tcp:5037 fork-server
 *    server`), so treating the client binary alone as a signal meant a machine
 *    that had merely run `adb devices` once opened the panel forever.
 */
export function isDisplayCommand(process: TrackedCommand): boolean {
  if (process.threadId === null || process.threadId === undefined) return false
  const command = process.command
  if (ADB_SERVER.test(command)) return false
  return DEVICE_ADB_USE.test(command) || DEVICE_TOOL.test(command) || DEVICE_APP.test(command)
}

/** First look after a turn starts: an emulator an agent launched is already a process. */
const FIRST_CHECK_DELAY_MS = 4_000
/** How often a working turn is re-checked. A turn that spawns a device is caught here. */
const CHECK_INTERVAL_MS = 20_000

export class DisplayPresence {
  private availableSince: number | null = null
  private working = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private checking = false
  private disposed = false

  constructor(private readonly deps: DisplayPresenceDeps) {}

  get state(): DisplayAvailability {
    return this.availableSince === null
      ? { available: false }
      : { available: true, since: this.availableSince }
  }

  /** An agent started or stopped working. Arms or disarms the watch. */
  setAgentWorking(working: boolean): void {
    if (this.disposed || this.working === working) return
    this.working = working
    if (!working) {
      this.clearTimer()
      return
    }
    // Already known: the rail item is up, so there is nothing left to watch for.
    if (this.availableSince !== null) return
    this.schedule(FIRST_CHECK_DELAY_MS)
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  private schedule(delay: number): void {
    this.clearTimer()
    if (this.disposed || !this.working || this.availableSince !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.check()
    }, delay)
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }

  /** One look at the harness process tree, then the next look if still needed. */
  private async check(): Promise<void> {
    if (this.disposed || this.checking || this.availableSince !== null) return
    this.checking = true
    try {
      const processes = await this.deps.listAgentProcesses()
      if (this.disposed) return
      if (processes.some(isDisplayCommand)) {
        this.availableSince = Date.now()
        // Sticky for the run: a user who has seen the panel keeps the rail item
        // even after the agent closes the emulator it opened.
        this.clearTimer()
        this.deps.onAvailable()
        return
      }
    } catch {
      // A process table that cannot be read is not a device: try again next tick.
    } finally {
      this.checking = false
    }
    this.schedule(CHECK_INTERVAL_MS)
  }
}
