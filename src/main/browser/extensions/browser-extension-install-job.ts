/**
 * The main-process boundary to the extension install worker.
 *
 * Main hands the worker a folder to build and gets progress and one result back;
 * the worker cannot touch Electron and main cannot unpack. The worker is spawned
 * per install and terminated when it answers, so the app holds no idle thread for
 * a feature most runs never touch, and a wedged install cannot leak a thread past
 * its own timeout.
 */

/// <reference types="electron-vite/node" />
import type { Worker } from 'node:worker_threads'
import createInstallWorker from './browser-extension-install-worker.ts?nodeWorker'
import type { BrowserExtensionProgress } from '../../../lib/ipc/browser'
import type {
  ExtensionPrepareMessage,
  ExtensionPrepareRequest,
  ExtensionPrepareResult
} from './browser-extension-install-worker'

/**
 * How long a prepare may run before it is abandoned.
 *
 * A 30 MB package on a slow disk is seconds. A worker that has not answered in
 * minutes is not going to, and leaving it running would keep a hung thread and a
 * half-written staging folder alive for the rest of the session.
 */
const PREPARE_TIMEOUT_MS = 5 * 60_000

export interface ExtensionPrepareProgress {
  phase: BrowserExtensionProgress['phase']
  detail: string
  receivedBytes: number
  totalBytes: number
}

/**
 * Build one extension source tree, off the main thread.
 *
 * The returned promise settles exactly once: a result, an error the worker
 * reported, a worker that died, or the timeout. Terminating the worker on every
 * path is what keeps a failure from leaving a thread behind.
 */
export function prepareExtensionSource(
  request: ExtensionPrepareRequest,
  onProgress: (progress: ExtensionPrepareProgress) => void
): Promise<ExtensionPrepareResult> {
  return new Promise<ExtensionPrepareResult>((resolve, reject) => {
    const worker: Worker = createInstallWorker({
      name: 'codeinoven-extension-install',
      workerData: request
    })
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      settle()
    }
    const timer = setTimeout(() => {
      finish(() => reject(new Error('The extension took too long to prepare and was abandoned')))
    }, PREPARE_TIMEOUT_MS)

    worker.on('message', (message: ExtensionPrepareMessage) => {
      if (message.type === 'progress') {
        onProgress({
          phase: message.phase,
          detail: message.detail,
          receivedBytes: message.receivedBytes,
          totalBytes: message.totalBytes
        })
        return
      }
      if (message.type === 'result') {
        finish(() => resolve(message.result))
        return
      }
      finish(() => reject(new Error(message.message)))
    })
    worker.on('error', (error: unknown) => {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))))
    })
    worker.on('exit', (code: number) => {
      if (code !== 0) {
        finish(() => reject(new Error(`The installer stopped unexpectedly (exit ${code})`)))
      }
    })
  })
}
