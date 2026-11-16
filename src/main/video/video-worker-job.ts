/// <reference types="electron-vite/node" />
import { relative } from 'node:path'
import { rm } from 'node:fs/promises'
import createTrackingWorker from './video-tracking-worker.ts?nodeWorker'
import { trackQuitWorker } from '../system/quit-worker-sweep'
import type { VideoJobContext } from './video-jobs'

/**
 * Run one isolated video worker as a cancellable job.
 *
 * Tracking is the only worker the app ships. Background removal used to fork a
 * second process that imported a GPU matting stack from a runtime-installed
 * package; that stack is not shipped any more and an agent provisions whatever
 * it needs in project scratch at task time, so nothing here can resolve it.
 */
export async function videoWorkerJob(
  kind: 'track',
  root: string,
  workerData: Record<string, unknown>,
  context: VideoJobContext
): Promise<{ files: string[]; result?: unknown }> {
  context.signal.throwIfAborted()
  if (kind !== 'track') throw new Error(`Unsupported video worker: ${String(kind)}`)
  const worker = trackQuitWorker(createTrackingWorker({ workerData }))
  const terminate = async (): Promise<void> => {
    await worker.terminate()
  }
  let result: { files: string[]; result?: unknown } | undefined
  try {
    result = await new Promise<{ files: string[]; result?: unknown }>((resolve, reject) => {
      let settled = false
      let grace: ReturnType<typeof setTimeout> | undefined
      const abort = (): void => {
        worker.postMessage('cancel')
        grace = setTimeout(() => {
          void terminate().catch(() => undefined)
          finish(new Error('Video worker cancelled'))
        }, 2000)
      }
      context.signal.addEventListener('abort', abort, { once: true })
      if (context.signal.aborted) abort()
      function finish(error?: Error, value?: { files: string[]; result?: unknown }): void {
        if (settled) return
        settled = true
        clearTimeout(grace)
        context.signal.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve(value!)
      }
      worker.on('message', (raw: unknown) => {
        if (!raw || typeof raw !== 'object') return
        const message = raw as {
          type: string
          progress?: number
          stage?: string
          message?: string
          files?: string[]
          result?: unknown
        }
        if (message.type === 'progress')
          context.update(message.progress ?? 0, message.stage ?? 'Processing')
        else if (message.type === 'error')
          finish(new Error(message.message ?? 'Video worker failed'))
        else if (message.type === 'result')
          finish(undefined, {
            files: (message.files ?? []).map((file) => relative(root, file).replaceAll('\\', '/')),
            result: message.result
          })
      })
      worker.on('error', (error) =>
        finish(error instanceof Error ? error : new Error(String(error)))
      )
      worker.on('exit', () => finish(new Error('Tracking worker stopped before returning a result')))
    })
    context.signal.throwIfAborted()
    return result
  } finally {
    await terminate()
    if (!result && typeof workerData.output === 'string')
      await rm(workerData.output, { recursive: true, force: true })
  }
}
