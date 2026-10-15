/// <reference types="electron-vite/node" />
import { relative } from 'node:path'
import { rm } from 'node:fs/promises'
import type { Worker } from 'node:worker_threads'
import { utilityProcess, type UtilityProcess } from 'electron'
import { buildProcessEnvironment } from '../drivers/cli-environment'
import createTrackingWorker from './video-tracking-worker.ts?nodeWorker'
import mattingProcessPath from './video-matting-process.ts?modulePath'
import type { VideoJobContext } from './video-jobs'

export async function videoWorkerJob(
  kind: 'track' | 'remove-background',
  root: string,
  workerData: Record<string, unknown>,
  context: VideoJobContext
): Promise<{ files: string[]; result?: unknown }> {
  context.signal.throwIfAborted()
  const worker: Worker | UtilityProcess =
    kind === 'track'
      ? createTrackingWorker({ workerData })
      : utilityProcess.fork(mattingProcessPath, [], {
          env: buildProcessEnvironment(),
          serviceName: 'Video background removal',
          stdio: 'pipe'
        })
  const terminate = async (): Promise<void> => {
    if ('terminate' in worker) await worker.terminate()
    else worker.kill()
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
      if ('terminate' in worker) {
        worker.on('error', (error) =>
          finish(error instanceof Error ? error : new Error(String(error)))
        )
        worker.on('exit', () =>
          finish(new Error('Tracking worker stopped before returning a result'))
        )
      } else {
        worker.stdout?.resume()
        worker.stderr?.resume()
        worker.on('error', (type) =>
          finish(new Error(`Background removal process failed: ${type}`))
        )
        worker.on('exit', () =>
          finish(new Error('Background removal process stopped before returning a result'))
        )
        worker.postMessage(workerData)
      }
    })
    context.signal.throwIfAborted()
    return result
  } finally {
    await terminate()
    if (!result && typeof workerData.output === 'string')
      await rm(workerData.output, { recursive: true, force: true })
  }
}
