/// <reference types="electron-vite/node" />
import createEvidenceWorker from './video-evidence-worker.ts?nodeWorker'
export interface VideoSourceEvidence {
  sha256: string
  files: { path: string; sha256: string; bytes: number }[]
  bytes: number
}
export function snapshotVideoSource(
  folder: string,
  signal: AbortSignal
): Promise<VideoSourceEvidence> {
  return runEvidenceWorker(folder, signal)
}
export function digestVideoOutput(file: string, signal: AbortSignal): Promise<VideoSourceEvidence> {
  return runEvidenceWorker({ file }, signal)
}
function runEvidenceWorker(
  request: string | { file: string },
  signal: AbortSignal
): Promise<VideoSourceEvidence> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = createEvidenceWorker({ workerData: request })
    let settled = false
    const finish = (error?: Error, result?: VideoSourceEvidence): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      void worker.terminate()
      if (error) reject(error)
      else resolve(result!)
    }
    const abort = (): void => finish(new Error('Composition evidence cancelled'))
    const timer = setTimeout(() => finish(new Error('Composition evidence timed out')), 30000)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    worker.on('message', (message: { result?: VideoSourceEvidence; error?: string }) =>
      finish(message.error ? new Error(message.error) : undefined, message.result)
    )
    worker.on('error', (error: Error) => finish(error))
    worker.on('exit', () => finish(new Error('Composition evidence worker stopped')))
  })
}
