import { randomUUID } from 'node:crypto'
import type {
  SpeechCapability,
  SpeechError,
  SpeechJobState,
  SpeechRuntime
} from '../../lib/speech/types'
import { MAX_SPEECH_QUEUE_DEPTH } from '../../lib/speech/types'

export interface SpeechQueueTask<T> {
  capability: SpeechCapability
  runtime: SpeechRuntime
  run: (signal: AbortSignal) => Promise<T>
}

export interface SpeechQueuedJob<T> {
  id: string
  result: Promise<T>
}

interface QueueEntry<T> {
  id: string
  task: SpeechQueueTask<T>
  controller: AbortController
  resolve: (value: T) => void
  reject: (reason: SpeechQueueError) => void
}

export class SpeechQueueError extends Error {
  constructor(readonly speechError: SpeechError) {
    super(speechError.message)
    this.name = 'SpeechQueueError'
  }
}

/**
 * Keeps expensive speech work outside request handlers and caps both running
 * and retained jobs. Each runtime gets one lane, and within a lane one job per
 * capability (pipeline stage) may run at a time: sherpa ASR and sherpa TTS run
 * concurrently on their own worker threads, while duplicate stage jobs queue
 * behind each other. An MLX task can still never increase sherpa's native
 * concurrency (or vice versa).
 */
export class SpeechJobQueue {
  private readonly pending = new Map<SpeechRuntime, QueueEntry<unknown>[]>([
    ['mlx', []],
    ['sherpa-onnx', []],
    ['coreml', []],
    ['gguf', []]
  ])
  private readonly active = new Map<string, QueueEntry<unknown>>()
  private readonly states = new Map<string, SpeechJobState>()
  private disposed = false

  constructor(private readonly maxDepth = MAX_SPEECH_QUEUE_DEPTH) {}

  enqueue<T>(task: SpeechQueueTask<T>): SpeechQueuedJob<T> {
    if (this.disposed) throw this.error('cancelled', 'The speech queue is shutting down.')
    const lane = this.pending.get(task.runtime)
    if (!lane) throw this.error('runtime-unsupported', `Unsupported runtime: ${task.runtime}`)
    if (lane.length + this.activeCountForRuntime(task.runtime) >= this.maxDepth) {
      throw this.error('queue-full', 'The speech queue is full. Try again when a job finishes.')
    }

    const id = randomUUID()
    const controller = new AbortController()
    let resolveResult!: (value: T) => void
    let rejectResult!: (reason: SpeechQueueError) => void
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    // A backend can fail before the caller finishes recording the job metadata.
    // Attach a rejection observer immediately; callers still receive the original
    // rejected promise, but Electron never treats the expected failure as global.
    void result.catch(() => undefined)
    const entry: QueueEntry<T> = {
      id,
      task,
      controller,
      resolve: resolveResult,
      reject: rejectResult
    }
    lane.push(entry as QueueEntry<unknown>)
    this.refreshQueuedPositions(task.runtime)
    void this.drain(task.runtime)
    return { id, result }
  }

  state(jobId: string): SpeechJobState | undefined {
    return this.states.get(jobId)
  }

  hasActive(runtime: SpeechRuntime): boolean {
    for (const entry of this.active.values()) {
      if (entry.task.runtime === runtime) return true
    }
    return false
  }

  hasPending(runtime: SpeechRuntime): boolean {
    const lane = this.pending.get(runtime)
    return Boolean(lane && lane.length > 0)
  }

  isIdle(runtime: SpeechRuntime): boolean {
    return !this.hasActive(runtime) && !this.hasPending(runtime)
  }

  cancel(jobId: string): boolean {
    for (const [runtime, lane] of this.pending) {
      const index = lane.findIndex((entry) => entry.id === jobId)
      if (index !== -1) {
        const [entry] = lane.splice(index, 1)
        const completedAt = Date.now()
        this.states.set(jobId, { state: 'cancelled', completedAt })
        entry.reject(this.error('cancelled', 'The speech job was cancelled.'))
        this.refreshQueuedPositions(runtime)
        return true
      }
    }
    const active = [...this.active.values()].find((entry) => entry.id === jobId)
    if (!active) return false
    active.controller.abort()
    return true
  }

  private stageKey(runtime: SpeechRuntime, capability: SpeechCapability): string {
    return `${runtime}:${capability}`
  }

  private activeCountForRuntime(runtime: SpeechRuntime): number {
    let count = 0
    for (const entry of this.active.values()) {
      if (entry.task.runtime === runtime) count += 1
    }
    return count
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const lane of this.pending.values()) {
      for (const entry of lane.splice(0)) {
        this.states.set(entry.id, { state: 'cancelled', completedAt: Date.now() })
        entry.reject(this.error('cancelled', 'The application is shutting down.'))
      }
    }
    for (const entry of this.active.values()) entry.controller.abort()
    await Promise.allSettled(
      [...this.active.values()].map(
        (entry) =>
          new Promise<void>((resolve) => {
            const stage = this.stageKey(entry.task.runtime, entry.task.capability)
            const poll = setInterval(() => {
              if (this.active.get(stage) !== entry) {
                clearInterval(poll)
                resolve()
              }
            }, 10)
          })
      )
    )
  }

  private async drain(runtime: SpeechRuntime): Promise<void> {
    if (this.disposed) return
    const lane = this.pending.get(runtime)
    if (!lane) return
    // Pick the oldest queued entry whose pipeline stage is not already running;
    // per-stage order stays FIFO while other stages drain around it.
    const index = lane.findIndex(
      (entry) => !this.active.has(this.stageKey(runtime, entry.task.capability))
    )
    if (index === -1) return
    const [entry] = lane.splice(index, 1)
    const stage = this.stageKey(runtime, entry.task.capability)
    this.active.set(stage, entry)
    this.states.set(entry.id, { state: 'running', startedAt: Date.now() })
    this.refreshQueuedPositions(runtime)
    try {
      const value = await entry.task.run(entry.controller.signal)
      this.states.set(entry.id, { state: 'succeeded', completedAt: Date.now() })
      entry.resolve(value)
    } catch (cause) {
      if (entry.controller.signal.aborted) {
        const error = this.error('cancelled', 'The speech job was cancelled.')
        this.states.set(entry.id, { state: 'cancelled', completedAt: Date.now() })
        entry.reject(error)
      } else {
        const error =
          cause instanceof SpeechQueueError
            ? cause
            : this.error('backend-failed', cause instanceof Error ? cause.message : String(cause))
        this.states.set(entry.id, {
          state: 'failed',
          completedAt: Date.now(),
          error: error.speechError
        })
        entry.reject(error)
      }
    } finally {
      this.active.delete(stage)
      void this.drain(runtime)
    }
  }

  private refreshQueuedPositions(runtime: SpeechRuntime): void {
    this.pending.get(runtime)?.forEach((entry, index) => {
      this.states.set(entry.id, { state: 'queued', position: index + 1 })
    })
  }

  private error(code: SpeechError['code'], message: string): SpeechQueueError {
    return new SpeechQueueError({ code, message, retryable: code !== 'runtime-unsupported' })
  }
}
