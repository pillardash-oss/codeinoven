import type { DisplayAvailability } from '../../lib/ipc/display'

/**
 * Whether an agent is driving something the display panel could show, which thread
 * is doing it, and which device the panel should be showing.
 *
 * Two reasons the app looks for a device, and only two:
 *
 *  - An agent is working. Then a target that appeared during the turn is work the
 *    agent started, and it takes the panel. This is the reliable attribution: the
 *    process tree names the thread, and `simctl boot` itself lives for a second.
 *  - The panel is showing no device. A person boots a simulator to use it, and the
 *    panel is supposed to come up on it by itself. Nothing subscribes to that, so
 *    this half is a cheap poll that stops the moment the panel has a device.
 *
 * Both cases end in the same answer: the one target the panel should be mirroring,
 * so an agent that moves from one emulator to another takes the panel with it.
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
/**
 * How often a closed panel looks for a device to open.
 *
 * A device can be booted by the person rather than by an agent   they start a
 * simulator to work in it themselves   and the panel has to come up on it either
 * way. There is no event to subscribe to for that (`simctl` has no watch mode),
 * so this is a poll, and it is deliberately the cheap one: two short child
 * processes, only while the panel is showing nothing and the window is up.
 */
const DISCOVERY_INTERVAL_MS = 5_000

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
  /** Whether the renderer has ever said what the panel shows (a launch always
   *  reports it, including "nothing"). */
  private panelReported = false
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
      // Discovery keeps looking for a device the person boots themselves.
      this.schedule(this.panelTarget === null ? DISCOVERY_INTERVAL_MS : null)
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
   * Report the target the panel is mirroring, so the watch knows whether it still
   * has something to find and never offers the target already on screen.
   */
  setPanelTarget(key: string | null): void {
    if (this.disposed) return
    const changed = !this.panelReported || this.panelTarget !== key
    const first = !this.panelReported
    this.panelReported = true
    this.panelTarget = key
    if (key !== null) this.offered.add(key)
    if (!changed) return
    // A launch that reports "nothing mirrored" is what arms discovery.
    if (first && key === null) this.schedule(0)
    else this.schedule(this.working.size === 0 && key !== null ? null : 0)
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
    // Nothing to look for: an idle app with the panel already showing a device.
    if (this.working.size === 0 && this.panelTarget !== null) return
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
    if (this.working.size === 0 && this.panelTarget !== null) return
    if (!this.deps.isWindowOnScreen()) {
      // A hidden window is nothing to mirror: look again when it is back.
      this.schedule(DISCOVERY_INTERVAL_MS)
      return
    }
    this.checking = true
    try {
      const [targets, processes] = await Promise.all([
        this.deps.detectTargets().catch(() => [] as string[]),
        this.working.size === 0
          ? Promise.resolve([] as TrackedCommand[])
          : this.deps.listAgentProcesses().catch(() => [] as TrackedCommand[])
      ])
      if (this.disposed) return

      // An exact attribution beats a guess, so the process tree is read first.
      const attributed = new Set<string>()
      for (const process of processes) {
        const threadId = displayThreadForProcess(process)
        if (threadId) attributed.add(threadId)
      }
      const baseline = this.baseline ?? new Set<string>()
      const appeared = targets.filter((target) => !baseline.has(target))
      if (appeared.length > 0) {
        // Nothing in the process tree names the thread that booted it, so the
        // turn that was running when it appeared is the one that did.
        for (const threadId of this.working) attributed.add(threadId)
      }

      // The panel follows the device, not just the fact that one exists: a
      // simulator booted by the person and an emulator an agent moved to both
      // arrive through here, once each.
      const fresh = targets.filter((target) => !this.offered.has(target))
      const focus = fresh.at(-1)
      if (focus) {
        this.offered.add(focus)
        this.deps.onTargetAppeared(focus, [...attributed][0])
      }

      if (attributed.size > 0 && this.availableSince === null) {
        this.availableSince = Date.now()
        for (const threadId of attributed) this.markThread(threadId, true)
        this.deps.onAvailable([...attributed])
      }

      const idle = this.working.size === 0
      this.schedule(idle ? DISCOVERY_INTERVAL_MS : CHECK_INTERVAL_MS)
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
