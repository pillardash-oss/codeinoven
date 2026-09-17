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
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      ;(timer as unknown as { unref: () => void }).unref?.()
    }
    this.unloadTimers.set(capability, timer)
  }

  private async evictCapability(capability: SpeechCapability): Promise<void> {
    this.unloadTimers.delete(capability)
    const last = this.lastUsed.get(capability)
    const option = this.unloadOptions[capability]
    const delay = unloadMs(option)
    if (delay === null) return
    if (last !== undefined && Date.now() - last < delay - 250) {
      // Activity happened sooner than expected   reschedule
      this.scheduleEvict(capability)
      return
    }
    if (this.host.isCapabilityBusy(capability)) {
      // Defer while busy; will be rescheduled on next touch
      Logger.dev('Speech auto-evict deferred   capability busy', { capability })
      return
    }
    const runtimes = CAPABILITY_RUNTIME_MAP[capability]
    const targets = runtimes.filter((runtime) => this.host.isRuntimeIdle(runtime))
    if (targets.length === 0) return
    Logger.dev('Speech auto-evict', { capability, runtimes: targets, option })
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
