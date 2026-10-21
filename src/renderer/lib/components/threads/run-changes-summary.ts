import type { TurnCheckpointSummary } from '$shared/types'

export interface ChangeCardSummary {
  additions: number
  deletions: number
  edited: boolean
  partial: boolean
  remaining: boolean
  restored: Uint8Array<ArrayBuffer>
}
export interface ChangeCardItem {
  path: string
  additions: number
  deletions: number
  edited: boolean
  partial: boolean
}
export type ChangeCardMessage =
  | { totalChanges: number }
  | { restored: string[] }
  | { changes: ChangeCardItem[] }
  | { finish: true }

const BATCH_SIZE = 512
interface SummaryJob {
  checkpoint: TurnCheckpointSummary
  signal: AbortSignal
  resolve: (summary: ChangeCardSummary) => void
  reject: (reason: unknown) => void
  cancel: () => void
}
const pending: SummaryJob[] = []
let running = false

/** Serialize scans, transferring only a small chunk of metadata per acknowledgement. */
export function summarizeChanges(
  checkpoint: TurnCheckpointSummary,
  signal: AbortSignal
): Promise<ChangeCardSummary> {
  if (signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'))
  if (pending.length >= 128)
    return Promise.reject(new Error('Change summary is busy. Reopen the card to retry.'))
  return new Promise((resolve, reject) => {
    const cancel = (): void => {
      const index = pending.indexOf(job)
      if (index < 0) return
      pending.splice(index, 1)
      signal.removeEventListener('abort', cancel)
      reject(new DOMException('Cancelled', 'AbortError'))
    }
    const job: SummaryJob = { checkpoint, signal, resolve, reject, cancel }
    pending.push(job)
    signal.addEventListener('abort', cancel, { once: true })
    pump()
  })
}

function pump(): void {
  if (running) return
  const job = pending.shift()
  if (!job) return
  running = true
  job.signal.removeEventListener('abort', job.cancel)
  // Begin outside Svelte dependency tracking and yield between cards.
  void Promise.resolve()
    .then(() => {
      job.signal.throwIfAborted()
      return scan(job.checkpoint, job.signal)
    })
    .then(job.resolve, job.reject)
    .finally(() => {
      running = false
      if (pending.length > 0) setTimeout(pump, 0)
    })
}

function scan(checkpoint: TurnCheckpointSummary, signal: AbortSignal): Promise<ChangeCardSummary> {
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let initialized = false
    let restoredIndex = 0
    let changeIndex = 0
    const restored = checkpoint.rolledBackPaths ?? []
    const finish = (error?: Error, summary?: ChangeCardSummary): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      worker?.terminate()
      if (error) reject(error)
      else if (summary) resolve(summary)
    }
    const abort = (): void => finish(new DOMException('Cancelled', 'AbortError'))
    const send = (): void => {
      if (settled || !worker) return
      try {
        let message: ChangeCardMessage
        if (!initialized) {
          message = { totalChanges: checkpoint.changes.length }
          initialized = true
        } else if (restoredIndex < restored.length) {
          message = { restored: restored.slice(restoredIndex, restoredIndex + BATCH_SIZE) }
          restoredIndex += BATCH_SIZE
        } else if (changeIndex < checkpoint.changes.length) {
          message = {
            changes: checkpoint.changes
              .slice(changeIndex, changeIndex + BATCH_SIZE)
              .map((change) => ({
                path: change.path,
                additions: change.additions ?? 0,
                deletions: change.deletions ?? 0,
                edited: Boolean(change.sources?.length),
                partial: Boolean(change.lineCountsTruncated)
              }))
          }
          changeIndex += BATCH_SIZE
        } else message = { finish: true }
        worker.postMessage(message)
        clearTimeout(timer)
        timer = setTimeout(() => finish(new Error('Change summary worker timed out.')), 10_000)
      } catch (reason) {
        finish(reason instanceof Error ? reason : new Error('Change summary failed.'))
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      worker = new Worker(new URL('./run-changes-summary-worker.ts', import.meta.url), {
        type: 'module'
      })
      worker.onmessage = (
        event: MessageEvent<{ summary?: ChangeCardSummary; error?: string }>
      ): void => {
        if (event.data.error) finish(new Error(event.data.error))
        else if (event.data.summary) finish(undefined, event.data.summary)
        else send()
      }
      worker.onerror = (): void => finish(new Error('Change summary worker failed.'))
      worker.onmessageerror = (): void =>
        finish(new Error('Change summary worker returned an unreadable result.'))
      send()
    } catch (reason) {
      finish(reason instanceof Error ? reason : new Error('Change summary worker could not start.'))
    }
  })
}
