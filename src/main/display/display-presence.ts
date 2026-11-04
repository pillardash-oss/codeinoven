import type { DisplayAvailability } from '../../lib/ipc/display'

/**
 * Whether an agent is driving something the display panel could show, which thread
 * is doing it, and which device it is on.
 *
 * The panel is not a tool the user browses to: it is a window into the device an
 * agent is working on, so this watch runs only while a thread is working and stops
 * the moment the last turn ends. Nothing about it polls an idle app, boots a device,
 * or loads a capture on its own.
 *
 * Two signals, because one is not enough:
 *
 *  - the process tree, which names the device (`adb -s <serial>` on a phone on a
 *    cable or wireless, a simulator udid) and the thread that ran the command.
 *  - the devices themselves, compared against what was already there when the turn
 *    started, which catches a target that appeared mid-turn even when the command
 *    that booted it was a second long and already gone.
 *
 * Together they answer the two questions the panel has: is there something to
 * show, and which device should be on screen.
 */
export interface DisplayPresenceDeps {
  /** Every process the agent process service currently tracks. Never cached here. */
  listAgentProcesses: () => Promise<TrackedCommand[]>
  /** Targets attached or booted right now, as `android:<serial>` / `ios:<udid>`. */
  detectTargets: () => Promise<string[]>
  /** The panel now exists. Called once per run, with the threads it belongs to. */
  onAvailable: (threadIds: string[]) => void
  /** A thread started or stopped using a display target. */
  onActivity: (threadId: string, active: boolean, at: number) => void
  /** A target should take the panel: `ios:<udid>`, optionally for one thread. */
  onTargetAppeared: (key: string, threadId?: string) => void
  /** Whether the app window is on screen, so a hidden app never probes devices. */
  isWindowOnScreen: () => boolean
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
 * The thread a tracked process says is driving a display target, or null.
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
export function displayThreadForProcess(process: TrackedCommand): string | null {
  if (process.threadId === null || process.threadId === undefined) return null
  const command = process.command
  if (ADB_SERVER.test(command)) return null
  const matched =
    DEVICE_ADB_USE.test(command) || DEVICE_TOOL.test(command) || DEVICE_APP.test(command)
  return matched ? process.threadId : null
}

/** `adb -s <serial>`: the target a device command was aimed at by name. */
const ADB_SERIAL = /(?:^|\s|\/)adb\s[\s\S]*?-s\s+([A-Za-z0-9.:_-]+)/u
/** A simulator udid, which `simctl` commands carry as an argument. */
const SIMULATOR_UDID =
  /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/gu
/** `simctl ... booted ...`: the only booted simulator, whichever it is. */
const SIMULATOR_BOOTED = /(?:^|\s)booted(?:\s|$)/u

/**
 * The device a command line is working on, or null when it does not say.
 *
 * This is what makes the panel show the phone on the cable as well as the emulator
 * an agent just booted: `adb -s RZCW61ATJDF shell input tap` names its target even
 * though nothing about the device changed, so waiting for a device to *appear* would
 * miss every command aimed at one that was already plugged in.
 */
export function displayTargetForProcess(
  process: TrackedCommand,
  targets: readonly string[]
): string | null {
  const command = process.command
  const deviceCommand =
    DEVICE_ADB_USE.test(command) || DEVICE_TOOL.test(command) || DEVICE_APP.test(command)
  if (!deviceCommand || ADB_SERVER.test(command)) return null

  const serial = ADB_SERIAL.exec(command)?.[1]
  if (serial) {
    const key = `android:${serial}`
    if (targets.includes(key)) return key
  }
  for (const udid of command.match(SIMULATOR_UDID) ?? []) {
    const key = `ios:${udid.toUpperCase()}`
    const match = targets.find((target) => target.toUpperCase() === key)
    if (match) return match
  }
  // A device command that names nothing (`adb shell ...`, `simctl spawn booted ...`)
  // means the only attached device, when there is exactly one to mean.
  if (targets.length === 1) return targets[0] ?? null
  if (SIMULATOR_BOOTED.test(command)) {
    const simulators = targets.filter((target) => target.startsWith('ios:'))
    if (simulators.length === 1) return simulators[0] ?? null
  }
  return null
}

/**
 * First look after a turn starts: a device the agent launched is already there.
 *
 * Presence is a promise that the panel appears while the agent is still working,
 * so these two numbers are the latency budget: a device that appears right after
 * the first look is caught within one interval, which is why the interval is
 * seconds rather than the minutes a cheaper watch could afford. Each look is two
 * short child processes, and only while a turn is running.
 */
const FIRST_CHECK_DELAY_MS = 3_000
/** How often the watch looks again while a thread works. */
const CHECK_INTERVAL_MS = 8_000

export class DisplayPresence {
  private availableSince: number | null = null
  /** Threads an agent is working in right now. */
  private working = new Set<string>()
  /** Threads this session is known to be driving a display target. */
  private readonly activeThreads = new Map<string, number>()
  /** Targets that were already there when the first thread started working. */
  private baseline: Set<string> | null = null
  /** Targets already handed to the panel, so nothing is offered twice. */
  private readonly offered = new Set<string>()
  /** The target the panel is mirroring, when it is mirroring one. */
  private panelTarget: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private checking = false
  private disposed = false

  constructor(private readonly deps: DisplayPresenceDeps) {}

  get state(): DisplayAvailability {
    return {
      available: this.availableSince !== null,
      ...(this.availableSince === null ? {} : { since: this.availableSince }),
      threads: [...this.activeThreads.keys()]
    }
  }

  /** Report the threads an agent is working in. Arms or disarms the watch. */
  setWorkingThreads(threadIds: readonly string[]): void {
    if (this.disposed) return
    const next = new Set(threadIds)
    const stopped = [...this.working].filter((id) => !next.has(id))
    const started = [...next].filter((id) => !this.working.has(id))
    this.working = next
    // A thread that stopped working stops wearing the mark, whatever it touched.
    for (const threadId of stopped) this.markThread(threadId, false)
    if (next.size === 0) {
      // Nothing is being worked on: the panel is inert, and so is this watch.
      this.clearTimer()
      return
    }
    if (this.availableSince !== null) {
      // The panel already exists. A new turn in a working thread joins the mark,
      // and the watch keeps looking so a different device can take the panel.
      for (const threadId of started) this.markThread(threadId, true)
      this.schedule(started.length > 0 ? 0 : CHECK_INTERVAL_MS)
      return
    }
    if (this.baseline === null) {
      void this.captureBaseline(started)
      return
    }
    this.schedule(started.length > 0 ? 0 : FIRST_CHECK_DELAY_MS)
  }

  /**
   * Report the target the panel is mirroring, so a device already on screen is
   * never offered a second time.
   */
  setPanelTarget(key: string | null): void {
    if (this.disposed) return
    this.panelTarget = key
    // Whatever the panel is showing is settled: it is never offered again.
    if (key !== null) this.offered.add(key)
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  /** Record what was already attached before the turn, so only new work counts. */
  private async captureBaseline(threads: readonly string[]): Promise<void> {
    try {
      this.baseline = new Set(await this.deps.detectTargets())
    } catch {
      this.baseline = new Set()
    }
    if (this.disposed) return
    for (const threadId of threads) this.markThread(threadId, false)
    this.schedule(FIRST_CHECK_DELAY_MS)
  }

  private schedule(delay: number | null): void {
    this.clearTimer()
    if (this.disposed || delay === null) return
    // The panel exists only while an agent works on a device: no turn, no look.
    if (this.working.size === 0) return
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

  /** One look at the devices and the agent's process tree, then the next look. */
  private async check(): Promise<void> {
    if (this.disposed || this.checking) return
    if (this.working.size === 0) return
    if (!this.deps.isWindowOnScreen()) {
      // A hidden window is nothing to mirror: look again when it is back.
      this.schedule(CHECK_INTERVAL_MS)
      return
    }
    this.checking = true
    try {
      const [targets, processes] = await Promise.all([
        this.deps.detectTargets().catch(() => [] as string[]),
        this.deps.listAgentProcesses().catch(() => [] as TrackedCommand[])
      ])
      if (this.disposed) return

      // An exact attribution beats a guess, so the process tree is read first.
      const attributed = new Set<string>()
      /** The device a command line names, which is the one being worked on. */
      const named: string[] = []
      for (const process of processes) {
        const threadId = displayThreadForProcess(process)
        if (threadId) attributed.add(threadId)
        const target = displayTargetForProcess(process, targets)
        if (target) named.push(target)
      }
      const baseline = this.baseline ?? new Set<string>()
      const appeared = targets.filter((target) => !baseline.has(target))
      if (appeared.length > 0) {
        // Nothing in the process tree names the thread that booted it, so the
        // turn that was running when it appeared is the one that did.
        for (const threadId of this.working) attributed.add(threadId)
      }

      // The panel follows the device, not just the fact that one exists. A command
      // that names a serial or a udid is the strongest answer (`adb -s ... shell`
      // on a phone on a cable is a device the panel has never seen boot); a device
      // that appeared during the turn is the next; anything else waits.
      const focus = named.at(-1) ?? (appeared.length > 0 ? appeared.at(-1) : undefined)
      if (focus && !this.offered.has(focus)) {
        this.offered.add(focus)
        this.deps.onTargetAppeared(focus, [...attributed][0])
      }

      if (attributed.size > 0 && this.availableSince === null) {
        this.availableSince = Date.now()
        for (const threadId of attributed) this.markThread(threadId, true)
        this.deps.onAvailable([...attributed])
      }

      this.schedule(CHECK_INTERVAL_MS)
    } finally {
      this.checking = false
    }
  }

  /** Move one thread's mark and tell the UI, once per real change. */
  private markThread(threadId: string, active: boolean): void {
    const was = this.activeThreads.has(threadId)
    if (was === active) return
    const at = Date.now()
    if (active) this.activeThreads.set(threadId, at)
    else this.activeThreads.delete(threadId)
    if (this.availableSince === null && active) this.availableSince = at
    this.deps.onActivity(threadId, active, at)
  }
}
