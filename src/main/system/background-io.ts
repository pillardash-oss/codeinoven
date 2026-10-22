/// <reference types="electron-vite/node" />
import createWorker from './background-io-worker.ts?nodeWorker'
import type { Worker } from 'node:worker_threads'

import type { BackgroundIoRequest } from './background-io-protocol'

interface Job {
  request: BackgroundIoRequest
  resolve(value: unknown): void
  reject(error: Error): void
}

function createLane() {
  // Each lane dispatches one request at a time and releases its worker when idle.
  const queue: Job[] = []
  let worker: Worker | undefined
  let active: Job | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let idle: ReturnType<typeof setTimeout> | undefined

  function stop(error?: Error): void {
    clearTimeout(deadline)
    clearTimeout(idle)
    const previous = worker
    worker = undefined
    if (error) {
      active?.reject(error)
      for (const job of queue.splice(0)) job.reject(error)
    }
    active = undefined
    void previous?.terminate()
  }

  function dispatch(): void {
    if (active) return
    clearTimeout(idle)
    if (queue.length === 0) {
      if (worker) {
        idle = setTimeout(() => stop(), 1000)
        idle.unref()
      }
      return
    }
    try {
      if (!worker) {
        const current = createWorker({ resourceLimits: { maxOldGenerationSizeMb: 128 } })
        worker = current
        current.on('message', (response: { value?: unknown; error?: string }) => {
          if (worker !== current || !active) return
          clearTimeout(deadline)
          const job = active
          active = undefined
          if (response.error) job.reject(new Error(response.error))
          else job.resolve(response.value)
          dispatch()
        })
        current.on('error', (error: Error) => {
          if (worker === current) stop(error)
        })
        current.on('exit', () => {
          if (worker === current) stop(new Error('Background I/O worker exited'))
        })
        current.unref()
      }
      active = queue.shift()
      const current = worker
      deadline = setTimeout(() => {
        if (worker === current) stop(new Error('Background I/O timed out'))
      }, 15_000)
      worker.postMessage(active?.request)
    } catch (error) {
      stop(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** The result type is selected by each internal, typed operation's caller. */
  function run<T>(request: BackgroundIoRequest): Promise<T> {
    if (queue.length >= 64) return Promise.reject(new Error('Background I/O is busy'))
    return new Promise<unknown>((resolve, reject) => {
      queue.push({ request, resolve, reject })
      dispatch()
    }) as Promise<T>
  }
  return run
}

// Parsing a document must not queue directory listings behind its CPU work.
// At most two workers exist, each with a bounded heap, queue and active deadline.
const interactive = createLane()
const processing = createLane()

export function backgroundIo<T>(request: BackgroundIoRequest): Promise<T> {
  return request.kind === 'list-directory' ||
    request.kind === 'credential-read' ||
    request.kind === 'credential-delete'
    ? interactive<T>(request)
    : processing<T>(request)
}
