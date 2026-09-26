import { DEFAULT_SPEECH_SETTINGS } from '../../../lib/speech/types'
import type { SpeechCapability, SpeechRuntime, SpeechUnloadOption } from '../../../lib/speech/types'
import { Logger } from '../../system/logger'

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

function unrefTimer(timer: NodeJS.Timeout): void {
  if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
    ;(timer as unknown as { unref: () => void }).unref?.()
  }
}

/** Queue and backend operations the evictor needs from the owning service. */
export interface SpeechEvictionHost {
  isCapabilityBusy(capability: SpeechCapability): boolean
  isRuntimeIdle(runtime: SpeechRuntime): boolean
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

  constructor(private readonly host: SpeechEvictionHost) {}

  updateUnloadOptions(options: Partial<Record<SpeechCapability, SpeechUnloadOption>>): void {
    let changed = false
    for (const capability of ['asr', 'cleanup', 'tts'] as const) {
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

  touch(capability: SpeechCapability): void {
    this.lastUsed.set(capability, Date.now())
    this.startPressureWatch()
    // While work is active, ensure no pending evict races; reschedule after current work settles
    this.clearEvict(capability)
    // Don't schedule while a job is actively running for this capability
    if (this.host.isCapabilityBusy(capability)) return
    this.scheduleEvict(capability)
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
    this.pressureTimer = setInterval(() => this.relieveMemoryPressure(), PRESSURE_CHECK_MS)
    unrefTimer(this.pressureTimer)
  }

  /**
   * Release every idle runtime the user has not pinned when the machine is out
   * of memory, so a resident model cannot push a tight machine into swap for the
   * rest of its unload window.
   */
  private relieveMemoryPressure(): void {
    if (!this.underMemoryPressure()) return
    for (const capability of ['asr', 'cleanup', 'tts'] as const) {
      // `keep` is an explicit request to hold the model; pressure never
      // overrides a user's own instruction.
      if (this.unloadOptions[capability] === 'keep') continue
      // A busy capability keeps its normal schedule: a forced eviction would
      // delete that timer and then defer anyway, leaving it unevicted.
      if (this.host.isCapabilityBusy(capability)) continue
      void this.evictCapability(capability, true)
    }
  }

  /**
   * Whether the machine is out of memory.
   *
   * Only a signal the platform actually reports is trusted. Linux exposes the
   * kernel's own pressure estimate and Windows exposes swap; macOS exposes
   * neither, and its `free` figure excludes only disk cache while the kernel
   * holds everything else as reclaimable, so it sits near zero on a perfectly
   * healthy machine and would trigger on every check. No signal means no
   * pressure eviction there, and the configured unload window governs.
   */
  private underMemoryPressure(): boolean {
    const info = systemMemory()
    if (!info || info.total <= 0) return false
    if (typeof info.available === 'number') {
      return info.available / info.total < PRESSURE_AVAILABLE_RATIO
    }
    if (typeof info.swapTotal === 'number' && info.swapTotal > 0) {
      return (
        typeof info.swapFree === 'number' &&
        info.swapFree / info.swapTotal < PRESSURE_SWAP_FREE_RATIO
      )
    }
    return false
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
