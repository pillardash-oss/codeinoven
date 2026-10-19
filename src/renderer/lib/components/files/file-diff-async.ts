import type { DiffDetails } from './file-diff'

export interface DiffWorkerInput {
  before?: string
  after?: string
  beforeStartLine?: number
  afterStartLine?: number
}

export type DiffWorkerReply = { details: DiffDetails } | { error: string }

const MAX_SOURCE_CHARS = 1024 * 1024
const MAX_PENDING_JOBS = 16
const MAX_PENDING_CHARS = 4 * 1024 * 1024
interface DiffJob {
  input: DiffWorkerInput
  chars: number
  signal?: AbortSignal
  resolve: (details: DiffDetails) => void
  reject: (error: Error) => void
  cancel: () => void
}
const pending: DiffJob[] = []
let pendingChars = 0
let running = false

/** One worker at a time, with bounded waiting payloads and no idle worker/cache. */
export function diffDetailsAsync(
  input: DiffWorkerInput,
  signal?: AbortSignal
): Promise<DiffDetails> {
  if (signal?.aborted) return Promise.reject(new DOMException('Diff cancelled', 'AbortError'))
  const chars = (input.before?.length ?? 0) + (input.after?.length ?? 0)
  if (chars > MAX_SOURCE_CHARS) {
    return Promise.reject(
      new Error('This file exceeds the diff preview size limit. Open the file to inspect it.')
    )
  }
  if (pending.length >= MAX_PENDING_JOBS || pendingChars + chars > MAX_PENDING_CHARS) {
    return Promise.reject(new Error('Diff preview is busy. Reopen the preview to retry.'))
  }
  return new Promise<DiffDetails>((resolve, reject) => {
    const cancel = (): void => {
      const index = pending.indexOf(job)
      if (index < 0) return
      pending.splice(index, 1)
      pendingChars -= chars
      signal?.removeEventListener('abort', cancel)
      reject(new DOMException('Diff cancelled', 'AbortError'))
    }
    const job: DiffJob = { input, chars, signal, resolve, reject, cancel }
    pending.push(job)
    pendingChars += chars
    signal?.addEventListener('abort', cancel, { once: true })
    pump()
  })
}

function pump(): void {
  if (running) return
  const job = pending.shift()
  if (!job) return
  pendingChars -= job.chars
  job.signal?.removeEventListener('abort', job.cancel)
  running = true
  let worker: Worker | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  const finish = (error?: Error, details?: DiffDetails): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    job.signal?.removeEventListener('abort', abort)
    worker?.terminate()
    if (error) job.reject(error)
    else if (details) job.resolve(details)
    // Keep the slot until the next task, giving rendering/input time between jobs.
    setTimeout(() => {
      running = false
      pump()
    }, 0)
  }
  const abort = (): void => finish(new DOMException('Diff cancelled', 'AbortError'))
  job.signal?.addEventListener('abort', abort, { once: true })
  try {
    worker = new Worker(new URL('./file-diff-worker.ts', import.meta.url), { type: 'module' })
    timer = setTimeout(() => finish(new Error('Diff preview timed out.')), 10_000)
    worker.onmessage = (event: MessageEvent<DiffWorkerReply>): void => {
      if ('error' in event.data) finish(new Error(event.data.error))
      else finish(undefined, event.data.details)
    }
    worker.onerror = (): void => finish(new Error('Diff worker failed.'))
    worker.onmessageerror = (): void =>
      finish(new Error('Diff worker returned an unreadable result.'))
    worker.postMessage(job.input)
    // The worker owns its copy now. Release source references during computation.
    job.input = {}
  } catch (reason) {
    finish(reason instanceof Error ? reason : new Error('Diff worker could not start.'))
  }
}
