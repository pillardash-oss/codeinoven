/// <reference types="electron-vite/node" />
import createSherpaWorker from '../sherpa-worker-thread.ts?nodeWorker'
import { randomUUID } from 'node:crypto'
import type { Worker } from 'node:worker_threads'
import type { SpeechCapability } from '../../../lib/speech/types'
import type {
  SpeechBackend,
  SpeechBackendArtifact,
  SpeechSynthesisInput,
  SpeechTranscribeInput
} from '../speech-backend'
import type { SpeechWorkerRequest, SpeechWorkerResponse } from '../speech-worker-protocol'

interface PendingRequest {
  resolve: (response: SpeechWorkerResponse) => void
  reject: (error: Error) => void
}

/** Portable sherpa adapter; every native call runs inside one worker thread. */
export class SherpaSpeechBackend implements SpeechBackend {
  readonly runtime = 'sherpa-onnx' as const
  private worker: Worker | null = null
  private readonly pending = new Map<string, PendingRequest>()

  async capabilities(): Promise<SpeechCapability[]> {
    this.ensureWorker()
    return ['asr', 'cleanup', 'tts']
  }

  async transcribe(input: SpeechTranscribeInput, signal: AbortSignal): Promise<string> {
    const response = await this.request(
      {
        id: randomUUID(),
        kind: 'transcribe',
        modelDirectory: input.artifact.directory,
        audioPath: input.audioPath,
        language: input.language
      },
      signal
    )
    if (!response.ok) throw new Error(response.error)
    if (response.kind !== 'transcribe') throw new Error('Unexpected sherpa transcription response.')
    return response.text
  }

  async cleanup(
    transcript: string,
    artifact: SpeechBackendArtifact,
    signal: AbortSignal
  ): Promise<string> {
    const response = await this.request(
      {
        id: randomUUID(),
        kind: 'cleanup',
        modelDirectory: artifact.directory,
        transcript
      },
      signal
    )
    if (!response.ok) throw new Error(response.error)
    if (response.kind !== 'cleanup') throw new Error('Unexpected sherpa cleanup response.')
    return response.text
  }

  async synthesize(input: SpeechSynthesisInput, signal: AbortSignal): Promise<void> {
    const speakerId = Number.parseInt(input.voiceId, 10)
    const response = await this.request(
      {
        id: randomUUID(),
        kind: 'synthesize',
        modelDirectory: input.artifact.directory,
        text: input.text,
        speakerId: Number.isSafeInteger(speakerId) ? speakerId : 0,
        outputPath: input.outputPath
      },
      signal
    )
    if (!response.ok) throw new Error(response.error)
    if (response.kind !== 'synthesize') throw new Error('Unexpected sherpa synthesis response.')
  }

  async dispose(): Promise<void> {
    const worker = this.worker
    if (!worker) return
    const request: SpeechWorkerRequest = { id: randomUUID(), kind: 'shutdown' }
    await this.request(request, new AbortController().signal).catch(() => undefined)
    await worker.terminate()
    this.worker = null
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = createSherpaWorker({ name: 'codeinoven-sherpa-speech' })
    worker.on('message', (response: SpeechWorkerResponse) => {
      const pending = this.pending.get(response.id)
      if (!pending) return
      this.pending.delete(response.id)
      pending.resolve(response)
    })
    worker.on('error', (error) =>
      this.rejectAll(error instanceof Error ? error : new Error(String(error)))
    )
    worker.on('exit', (code) => {
      this.worker = null
      if (code !== 0) this.rejectAll(new Error(`Sherpa speech worker exited with code ${code}.`))
    })
    this.worker = worker
    return worker
  }

  private request(
    request: SpeechWorkerRequest,
    signal: AbortSignal
  ): Promise<SpeechWorkerResponse> {
    if (signal.aborted) return Promise.reject(new Error('Speech operation cancelled.'))
    const worker = this.ensureWorker()
    return new Promise<SpeechWorkerResponse>((resolve, reject) => {
      const abort = (): void => {
        this.pending.delete(request.id)
        reject(new Error('Speech operation cancelled.'))
        const activeWorker = this.worker
        this.worker = null
        void activeWorker?.terminate()
      }
      signal.addEventListener('abort', abort, { once: true })
      this.pending.set(request.id, {
        resolve: (response) => {
          signal.removeEventListener('abort', abort)
          resolve(response)
        },
        reject: (error) => {
          signal.removeEventListener('abort', abort)
          reject(error)
        }
      })
      worker.postMessage(request)
    })
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
