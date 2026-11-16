/// <reference types="electron-vite/node" />
import createWorker from './storage-usage-worker-thread.ts?nodeWorker'
import type { Worker } from 'node:worker_threads'
import type { StorageUsageWorkerRequest } from './storage-usage-protocol'

/**
 * How long one request may take before the lane gives up.
 *
 * Measuring a data root is proportional to the files on disk, not to anything
 * the app controls: a machine with a browser cache holding hundreds of
 * thousands of files can legitimately spend minutes on the first measurement.
 * The deadline only exists so a wedged thread releases its worker instead of
 * leaving a request pending for the rest of the session.
 */
const DEADLINE_MS = 10 * 60_000

/** How long the thread is kept after its queue drains. */
const IDLE_STOP_MS = 2_000

/** Most requests a lane will hold before it refuses more. */
const MAX_QUEUED = 8

interface PendingJob {
  request: StorageUsageWorkerRequest
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/**
 * The typed boundary to the storage usage worker.
 *
 * The thread is spawned by the first request and released once the lane has
 * been idle for a moment, so an installation that never opens the Storage
 * manager never pays for a worker at all, and one that does open it pays for
 * exactly one thread while it is in use. Requests are serialized: measuring and
 * clearing both walk the same folders, so running them at the same time would
 * only make each one slower.
 */
export class StorageUsageWorker {
  private worker: Worker | null = null
  private active: PendingJob | null = null
  private readonly queue: PendingJob[] = []
  private deadline: ReturnType<typeof setTimeout> | undefined
  private idle: ReturnType<typeof setTimeout> | undefined

  /** Run one request on the thread, waiting for the request ahead of it. */
  run<T>(request: StorageUsageWorkerRequest): Promise<T> {
    if (this.queue.length >= MAX_QUEUED) {
      return Promise.reject(new Error('The storage worker is busy'))
    }
    return new Promise<unknown>((resolve, reject) => {
      this.queue.push({ request, resolve, reject })
      this.dispatch()
    }) as Promise<T>
  }

  /** Release the thread now (app shutdown). Nothing queued survives this call. */
  stop(): void {
    this.shutdown(new Error('The storage worker was stopped'))
  }

  private dispatch(): void {
    if (this.active) return
    clearTimeout(this.idle)
    if (this.queue.length === 0) {
      if (this.worker) {
        this.idle = setTimeout(() => this.shutdown(), IDLE_STOP_MS)
        this.idle.unref?.()
      }
      return
    }
    try {
      if (!this.worker) this.spawn()
      const worker = this.worker
      const job = this.queue.shift()
      if (!worker || !job) return
      this.active = job
      this.deadline = setTimeout(
        () => this.shutdown(new Error('Measuring the data folder timed out')),
        DEADLINE_MS
      )
      this.deadline.unref?.()
      worker.postMessage(job.request)
    } catch (error: unknown) {
      this.shutdown(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private spawn(): void {
    const worker = createWorker({ resourceLimits: { maxOldGenerationSizeMb: 128 } })
    this.worker = worker
    worker.on('message', (response: { value?: unknown; error?: string }) => {
      if (this.worker !== worker) return
      clearTimeout(this.deadline)
      const job = this.active
      this.active = null
      if (response.error) job?.reject(new Error(response.error))
      else job?.resolve(response.value)
      this.dispatch()
    })
    worker.on('error', (error: Error) => {
      if (this.worker === worker) this.shutdown(error)
    })
    worker.on('exit', () => {
      if (this.worker === worker) this.shutdown(new Error('The storage worker exited'))
    })
    // A worker must never be the reason the app cannot quit.
    worker.unref()
  }

  private shutdown(error?: Error): void {
    clearTimeout(this.deadline)
    clearTimeout(this.idle)
    const worker = this.worker
    this.worker = null
    if (error) {
      this.active?.reject(error)
      for (const job of this.queue.splice(0)) job.reject(error)
    }
    this.active = null
    void worker?.terminate()
  }
}
