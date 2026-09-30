import { execFile } from 'node:child_process'
import { DEFAULT_SPEECH_SETTINGS } from '../../../lib/speech/types'
import type { SpeechCapability, SpeechRuntime, SpeechUnloadOption } from '../../../lib/speech/types'
import { Logger } from '../../system/logger'

/** The capabilities that can hold a model resident, in release order. */
const CAPABILITIES = ['asr', 'cleanup', 'tts'] as const

const UNLOAD_MS: Record<Exclude<SpeechUnloadOption, 'keep'>, number> = {
  '5m': 5 * 60_000,
  '10m': 10 * 60_000,
  '20m': 20 * 60_000,
  '30m': 30 * 60_000
}

export const CAPABILITY_RUNTIME_MAP: Record<SpeechCapability, SpeechRuntime[]> = {
  asr: ['sherpa-onnx', 'mlx', 'coreml'],
  cleanup: ['gguf'],
  tts: ['sherpa-onnx', 'mlx']
}

/**
 * The most runtimes allowed to hold a model at once. One runtime per capability
 * is the working set the user actually asked for, so the cap equals the
 * capability count and only a runtime switch can cross it. Without it, moving ASR
 * from one backend to another leaves the previous backend resident alongside the
 * new one, and a machine carrying a model per backend keeps gigabytes it is not
 * using.
 */
const MAX_RESIDENT_RUNTIMES = CAPABILITIES.length

/**
 * Capabilities a runtime can serve. `sherpa-onnx` handles both ASR and TTS from a
 * single backend instance, so residency is not one capability's property.
 */
function capabilitiesOf(runtime: SpeechRuntime): SpeechCapability[] {
  return CAPABILITIES.filter((capability) => CAPABILITY_RUNTIME_MAP[capability].includes(runtime))
}

function unloadMs(option: SpeechUnloadOption): number | null {
  if (option === 'keep') return null
  return UNLOAD_MS[option]
}

/**
 * How often resident runtimes are weighed against system memory pressure. A
 * model left resident for its whole configured unload window is fine on a
 * machine with memory to spare and ruinous on one that is swapping.
 */
const PRESSURE_CHECK_MS = 60_000
/** Swap that is nearly exhausted means the machine has no memory to spare. */
const PRESSURE_SWAP_FREE_RATIO = 0.1
/** Linux reports the kernel's own estimate of memory available without swapping. */
const PRESSURE_AVAILABLE_RATIO = 0.05
/** `sysctl` path every macOS install ships, so no PATH lookup is needed. */
const DARWIN_SYSCTL_PATH = '/usr/sbin/sysctl'
/** `sysctl` key holding the kernel's own memory pressure verdict. */
const DARWIN_PRESSURE_LEVEL_KEY = 'kern.memorystatus_vm_pressure_level'
/** The first level above normal: the kernel has started reclaiming memory. */
const DARWIN_PRESSURE_WARN = 2
/** A `sysctl` read that has not answered within this window counts as absent. */
const DARWIN_SYSCTL_TIMEOUT_MS = 2_000

/** The subset of Electron's `process.getSystemMemoryInfo()` this service reads. */
interface SystemMemorySnapshot {
  total: number
  /** Linux only. */
  available?: number
  /** Windows and Linux only. */
  swapTotal?: number
  /** Windows and Linux only. */
  swapFree?: number
}

/**
 * Read system memory through Electron's main-process API, which is not part of
 * the shared `Process` type and is absent in a non-Electron runtime (tests).
 * Returns null when there is no reader rather than throwing, so pressure relief
 * simply never fires outside the app.
 */
function systemMemory(): SystemMemorySnapshot | null {
  const read = (process as NodeJS.Process & { getSystemMemoryInfo?: () => SystemMemorySnapshot })
    .getSystemMemoryInfo
  if (typeof read !== 'function') return null
  try {
    return read.call(process)
  } catch {
    return null
  }
}

/**
 * Read the kernel's memory pressure level on macOS.
 *
 * Electron's `getSystemMemoryInfo()` reports neither `available` nor swap on
 * darwin, so there is no ratio to read there, but the kernel publishes its own
 * verdict to every process through `kern.memorystatus_vm_pressure_level`. It holds
 * the same number `memory_pressure(8)` prints: 1 normal, 2 warning, 4 critical. A
 * failed or unparseable read returns null, and no signal never evicts.
 */
function darwinPressureLevel(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      DARWIN_SYSCTL_PATH,
      ['-n', DARWIN_PRESSURE_LEVEL_KEY],
      { timeout: DARWIN_SYSCTL_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        const level = Number.parseInt(stdout.trim(), 10)
        resolve(Number.isFinite(level) ? level : null)
      }
    )
  })
}

function unrefTimer(timer: NodeJS.Timeout): void {
  if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
    ;(timer as unknown as { unref: () => void }).unref?.()
  }
}

/** Queue and backend operations the evictor needs from the owning service. */
export interface SpeechEvictionHost {
  isCapabilityBusy(capability: SpeechCapability): boolean
  isRuntimeIdle(runtime: SpeechRuntime): boolean
  /** Runtimes whose backend currently holds a live native process. */
  residentRuntimes(): SpeechRuntime[]
  disposeRuntime(runtime: SpeechRuntime): Promise<void>
}

/**
 * Idle-time runtime eviction for resident speech backends. Tracks per-capability
 * activity and unload preferences, then disposes idle runtimes once a
 * capability's timer elapses.
 */
export class SpeechRuntimeEviction {
  private unloadOptions: Record<SpeechCapability, SpeechUnloadOption> = {
    asr: DEFAULT_SPEECH_SETTINGS.asrUnload,
    cleanup: DEFAULT_SPEECH_SETTINGS.cleanupUnload,
    tts: DEFAULT_SPEECH_SETTINGS.ttsUnload
  }
  private readonly unloadTimers = new Map<SpeechCapability, NodeJS.Timeout>()
  private readonly lastUsed = new Map<SpeechCapability, number>()
  /** Watches system memory for as long as any runtime is resident. */
  private pressureTimer: NodeJS.Timeout | null = null
  /** When each runtime last served a request, which orders the resident cap. */
  private readonly runtimeLastUsed = new Map<SpeechRuntime, number>()
  /** True while a pressure read and the evictions it caused are still running. */
  private pressureCheckInFlight = false

  constructor(private readonly host: SpeechEvictionHost) {}

  updateUnloadOptions(options: Partial<Record<SpeechCapability, SpeechUnloadOption>>): void {
    let changed = false
    for (const capability of CAPABILITIES) {
      const next = options[capability]
      if (next && next !== this.unloadOptions[capability]) {
        this.unloadOptions[capability] = next
        changed = true
        // reschedule with new delay based on last activity
        if (this.lastUsed.has(capability)) {
          this.scheduleEvict(capability)
        } else if (next === 'keep') {
          this.clearEvict(capability)
        }
      }
    }
    if (changed) {
      Logger.dev('Speech unload options updated', { ...this.unloadOptions })
    }
  }

  /**
   * Record activity for a capability, and for the runtime that served it when the
   * caller knows which one. The runtime timestamp is what orders the resident cap,
   * so a call without one only refreshes the capability's own unload window, which
   * is what the post-transcription cleanup refreshes do.
   */
  touch(capability: SpeechCapability, runtime?: SpeechRuntime): void {
    const now = Date.now()
    this.lastUsed.set(capability, now)
    if (runtime) this.runtimeLastUsed.set(runtime, now)
    this.startPressureWatch()
    // While work is active, ensure no pending evict races; reschedule after current work settles
    this.clearEvict(capability)
    // Don't schedule while a job is actively running for this capability
    if (!this.host.isCapabilityBusy(capability)) this.scheduleEvict(capability)
    // The runtime that just served this request can be the one that carried the
    // resident count over the cap, so the cap is checked on the way out rather
    // than only on the pressure tick.
    void this.enforceResidentCap()
  }

  clearEvict(capability: SpeechCapability): void {
    const timer = this.unloadTimers.get(capability)
    if (timer) {
      clearTimeout(timer)
      this.unloadTimers.delete(capability)
    }
  }

  /** Clear every pending eviction timer on shutdown. */
  dispose(): void {
    for (const timer of this.unloadTimers.values()) clearTimeout(timer)
    this.unloadTimers.clear()
    this.runtimeLastUsed.clear()
    this.pressureCheckInFlight = false
    if (this.pressureTimer) {
      clearInterval(this.pressureTimer)
      this.pressureTimer = null
    }
  }

  /**
   * Start watching system memory the first time a runtime becomes resident, and
   * keep watching until shutdown. The configured unload window is a preference
   * about latency, not a promise to hold a model through a swap storm.
   */
  private startPressureWatch(): void {
    if (this.pressureTimer) return
    this.pressureTimer = setInterval(() => void this.relieveMemoryPressure(), PRESSURE_CHECK_MS)
    unrefTimer(this.pressureTimer)
  }

  /**
   * Release every idle runtime the user has not pinned when the machine is out
   * of memory, so a resident model cannot push a tight machine into swap for the
   * rest of its unload window. Capabilities are released one after another, so a
   * pressure event never fires several teardowns at once on a machine that is
   * already struggling.
   */
  private async relieveMemoryPressure(): Promise<void> {
    if (this.pressureCheckInFlight) return
    this.pressureCheckInFlight = true
    try {
      if (!(await this.underMemoryPressure())) return
      for (const capability of CAPABILITIES) {
        // `keep` is an explicit request to hold the model; pressure never
        // overrides a user's own instruction.
        if (this.unloadOptions[capability] === 'keep') continue
        // A busy capability keeps its normal schedule: a forced eviction would
        // delete that timer and then defer anyway, leaving it unevicted.
        if (this.host.isCapabilityBusy(capability)) continue
        await this.evictCapability(capability, true)
      }
    } catch (cause) {
      Logger.error('Speech memory pressure relief failed', { cause })
    } finally {
      this.pressureCheckInFlight = false
    }
  }

  /**
   * Release idle runtimes until the resident count is back inside the cap.
   *
   * The cap covers the leftovers a runtime switch creates: moving ASR from one
   * backend to another leaves the previous backend resident beside the new one for
   * its whole unload window. The least recently used resident goes first, so the
   * runtime that just served a request is the last candidate to be released.
   *
   * `keep` still wins. A pinned capability is an explicit instruction to hold that
   * model, and a runtime serving two capabilities is pinned when either of them
   * is, because disposing it would break the pinned one too.
   */
  private async enforceResidentCap(): Promise<void> {
    try {
      const residents = this.host.residentRuntimes()
      if (residents.length <= MAX_RESIDENT_RUNTIMES) return
      const leastRecentFirst = [...residents].sort(
        (left, right) =>
          (this.runtimeLastUsed.get(left) ?? 0) - (this.runtimeLastUsed.get(right) ?? 0)
      )
      let remaining = residents.length
      for (const runtime of leastRecentFirst) {
        if (remaining <= MAX_RESIDENT_RUNTIMES) break
        if (!this.host.isRuntimeIdle(runtime)) continue
        const pinned = capabilitiesOf(runtime).some(
          (capability) => this.unloadOptions[capability] === 'keep'
        )
        if (pinned) continue
        Logger.dev('Speech resident-runtime cap evict', {
          runtime,
          residents: remaining,
          cap: MAX_RESIDENT_RUNTIMES
        })
        await this.host.disposeRuntime(runtime)
        this.runtimeLastUsed.delete(runtime)
        remaining -= 1
      }
    } catch (cause) {
      Logger.error('Speech resident-runtime cap enforcement failed', { cause })
    }
  }

  /**
   * Whether the machine is out of memory.
   *
   * Only a signal the platform actually reports is trusted. Linux exposes the
   * kernel's own pressure estimate and Windows exposes swap, and Electron reports
   * both. macOS reports neither there, so the kernel is asked directly instead
   * (see `darwinPressureLevel`). Its `free` figure is never used: it excludes only
   * disk cache while the kernel holds everything else as reclaimable, so it sits
   * near zero on a perfectly healthy machine and would trigger on every check.
   */
  private async underMemoryPressure(): Promise<boolean> {
    const info = systemMemory()
    if (info && info.total > 0) {
      if (typeof info.available === 'number') {
        return info.available / info.total < PRESSURE_AVAILABLE_RATIO
      }
      if (typeof info.swapTotal === 'number' && info.swapTotal > 0) {
        return (
          typeof info.swapFree === 'number' &&
          info.swapFree / info.swapTotal < PRESSURE_SWAP_FREE_RATIO
        )
      }
    }
    if (process.platform !== 'darwin') return false
    const level = await darwinPressureLevel()
    // Anything above normal means the kernel is already reclaiming, so an idle
    // model is memory the machine gets back at once.
    return level !== null && level >= DARWIN_PRESSURE_WARN
  }

  private scheduleEvict(capability: SpeechCapability): void {
    this.clearEvict(capability)
    const option = this.unloadOptions[capability]
    const delay = unloadMs(option)
    if (delay === null) return
    const last = this.lastUsed.get(capability) ?? Date.now()
    // If we already have elapsed time, shorten first delay
    const elapsed = Date.now() - last
    const remaining = Math.max(500, delay - elapsed)
    const timer = setTimeout(() => {
      void this.evictCapability(capability)
    }, remaining)
    // Don't prevent app quit
    unrefTimer(timer)
    this.unloadTimers.set(capability, timer)
  }

  private async evictCapability(capability: SpeechCapability, force = false): Promise<void> {
    this.unloadTimers.delete(capability)
    const last = this.lastUsed.get(capability)
    const option = this.unloadOptions[capability]
    const delay = unloadMs(option)
    // `keep` is an explicit request to hold the model; nothing evicts it.
    if (delay === null) return
    if (!force && last !== undefined && Date.now() - last < delay - 250) {
      // Activity happened sooner than expected, so reschedule.
      this.scheduleEvict(capability)
      return
    }
    if (this.host.isCapabilityBusy(capability)) {
      // Defer while busy; will be rescheduled on next touch
      Logger.dev('Speech auto-evict deferred: capability busy', { capability })
      return
    }
    const runtimes = CAPABILITY_RUNTIME_MAP[capability]
    const targets = runtimes.filter((runtime) => this.host.isRuntimeIdle(runtime))
    if (targets.length === 0) return
    Logger.dev(force ? 'Speech pressure evict' : 'Speech auto-evict', {
      capability,
      runtimes: targets,
      option
    })
    await Promise.all(
      targets.map(async (runtime) => {
        try {
          await this.host.disposeRuntime(runtime)
        } catch (cause) {
          Logger.error('Speech auto-evict dispose failed', { capability, runtime, cause })
        }
      })
    )
  }
}
