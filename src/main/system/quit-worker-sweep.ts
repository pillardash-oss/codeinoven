import type { Worker } from 'node:worker_threads'
import { Logger } from './logger'

/**
 * Workers that must never outlive the app.
 *
 * A `worker_threads` worker is a referenced libuv handle: while it runs, it keeps
 * the process's event loop alive, and Node's exit waits for it. The shutdown
 * pipeline has already run every disposal step by the time the process hands
 * itself to Electron, so a job worker still in flight there is a teardown that
 * cannot finish, and no JavaScript remains afterwards to notice.
 *
 * Only job workers register here. The persistent service workers (database,
 * background I/O, IDE, project index, media server) are `unref()`ed, so they
 * cannot hold the loop, and the database one is stopped by `database.close()`
 * after the pipeline's own steps. Terminating them early would race that.
 */
const tracked = new Set<Worker>()

/**
 * Track a job worker for the quit sweep. Registration releases itself when the
 * worker exits, so a site that terminates it on completion leaves nothing behind.
 */
export function trackQuitWorker(worker: Worker): Worker {
  tracked.add(worker)
  worker.once('exit', () => {
    tracked.delete(worker)
  })
  return worker
}

/**
 * Terminate every worker still running, so none of them can hold the process in
 * its exit. Bounded and best-effort: a worker that refuses to stop is logged and
 * left to the teardown watchdog rather than holding the pipeline open.
 */
export async function terminateQuitWorkers(): Promise<void> {
  const running = [...tracked]
  tracked.clear()
  if (running.length === 0) return
  await Promise.all(
    running.map(async (worker) => {
      try {
        await worker.terminate()
      } catch (error) {
        Logger.dev('A quit-time worker did not stop', { error: String(error) })
      }
    })
  )
}
