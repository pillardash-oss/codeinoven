import { Worker } from 'node:worker_threads'
import {
  buildChangeBreakdown,
  type ChangeBreakdown,
  type ChangeBreakdownFile
} from '../../../lib/change-breakdown'
import { Logger } from '../../system/logger'

let pending = 0
let lane: Promise<unknown> = Promise.resolve()

/** One short-lived worker, bounded path chunks, and no historical backfill. */
export async function snapshotChangeBreakdown(
  changes: readonly ChangeBreakdownFile[]
): Promise<ChangeBreakdown | undefined> {
  if (changes.length === 0) return { totalFiles: 0, additions: 0, deletions: 0, areas: [] }
  if (pending >= 8) return undefined
  pending += 1
  const job = lane.then(
    () =>
      new Promise<ChangeBreakdown | undefined>((resolve) => {
        let worker: Worker | undefined
        let settled = false
        let index = 0
        const finish = (breakdown?: ChangeBreakdown): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (worker) void worker.terminate()
          resolve(breakdown)
        }
        const timer = setTimeout(() => finish(), 10_000)
        try {
          // The grouping has no module dependencies. Serializing it keeps Node and
          // browser workers on exactly the same rules without a second implementation.
          worker = new Worker(
            `
        const { parentPort } = require('node:worker_threads');
        const group = (${buildChangeBreakdown.toString()});
        const files = new Map();
        let chars = 0;
        parentPort.on('message', (batch) => {
          if (batch === null) { parentPort.postMessage({ breakdown: group([...files.values()]) }); return; }
          for (const file of batch) {
            if (files.has(file.path)) continue;
            chars += file.path.length;
            if (files.size >= 65536 || chars > 8 * 1024 * 1024) { parentPort.postMessage({ error: true }); return; }
            files.set(file.path, file);
          }
          parentPort.postMessage({});
        });
        parentPort.postMessage({});
      `,
            { eval: true, resourceLimits: { maxOldGenerationSizeMb: 64 } }
          )
          worker.on('message', (reply: { breakdown?: ChangeBreakdown; error?: boolean }) => {
            if (settled) return
            if (reply.error) finish()
            else if (reply.breakdown) finish(reply.breakdown)
            else {
              const batch = changes.slice(index, index + 256).map((change) => ({
                path: change.path,
                additions: change.additions,
                deletions: change.deletions
              }))
              index += batch.length
              worker?.postMessage(batch.length ? batch : null)
            }
          })
          worker.on('error', (error: Error) => {
            Logger.dev('Checkpoint area breakdown unavailable', { error: error.message })
            finish()
          })
          worker.on('exit', () => finish())
        } catch (error) {
          Logger.dev('Checkpoint area breakdown unavailable', { error: String(error) })
          finish()
        }
      })
  )
  lane = job.catch(() => undefined)
  try {
    return await job
  } finally {
    pending -= 1
  }
}
