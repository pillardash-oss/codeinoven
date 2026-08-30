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
  worker: Worker
}

/**
 * Speech pipeline stage a worker thread is dedicated to. Each stage gets at
 * most one worker thread, so a TTS synthesis can run while an ASR transcription
 * is in flight without either stage growing unbounded native threads.
 */
type SpeechWorkerStage = 'asr' | 'tts'

function stageForRequest(request: SpeechWorkerRequest): SpeechWorkerStage {
  return request.kind === 'synthesize' ? 'tts' : 'asr'
}

/**
 * Portable sherpa adapter; native calls run inside stage-dedicated worker
 * threads (at most one ASR worker plus one TTS worker per backend instance).
 * Together with the llama.cpp cleanup server this keeps the app at a maximum
 * of three concurrent speech threads.
 */
export class SherpaSpeechBackend implements SpeechBackend {
  readonly runtime = 'sherpa-onnx' as const
  private readonly workers = new Map<SpeechWorkerStage, Worker>()
  private readonly pending = new Map<string, PendingRequest>()

  async capabilities(): Promise<SpeechCapability[]> {
    return ['asr', 'cleanup', 'tts']
  }

  async warmup(artifact: SpeechBackendArtifact, signal: AbortSignal): Promise<void> {
    const response = await this.request(
      {
        id: randomUUID(),
        kind: 'warmup',
        modelDirectory: artifact.directory,
        ...(artifact.modelFamily ? { modelFamily: artifact.modelFamily } : {})
      },
      signal
    )
    if (!response.ok) throw new Error(response.error)
    if (response.kind !== 'warmup') throw new Error('Unexpected sherpa warmup response.')
  }

  async transcribe(input: SpeechTranscribeInput, signal: AbortSignal): Promise<string> {
    const response = await this.request(
      {
        id: randomUUID(),
        kind: 'transcribe',
        modelDirectory: input.artifact.directory,
        audioPath: input.audioPath,
        language: input.language,
        ...(input.artifact.modelFamily ? { modelFamily: input.artifact.modelFamily } : {})
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
    const workers = [...this.workers.values()]
    this.workers.clear()
    for (const pending of this.pending.values()) {
      pending.reject(new Error('Sherpa speech worker stopped.'))
    }
    this.pending.clear()
    await Promise.all(workers.map((worker) => worker.terminate()))
  }

  private ensureWorker(stage: SpeechWorkerStage): Worker {
    const existing = this.workers.get(stage)
    if (existing) return existing
    const worker = createSherpaWorker({ name: `codeinoven-sherpa-${stage}` })
    worker.on('message', (response: SpeechWorkerResponse) => {
      const pending = this.pending.get(response.id)
      if (!pending) return
      this.pending.delete(response.id)
      pending.resolve(response)
    })
    worker.on('error', (error) =>
      this.rejectWorker(worker, error instanceof Error ? error : new Error(String(error)))
    )
    worker.on('exit', (code) => {
      for (const [key, candidate] of this.workers) {
        if (candidate === worker) this.workers.delete(key)
      }
      if (code !== 0) {
        this.rejectWorker(worker, new Error(`Sherpa ${stage} worker exited with code ${code}.`))
      }
    })
    this.workers.set(stage, worker)
    return worker
  }

  private request(
    request: SpeechWorkerRequest,
    signal: AbortSignal
  ): Promise<SpeechWorkerResponse> {
    if (signal.aborted) return Promise.reject(new Error('Speech operation cancelled.'))
    const worker = this.ensureWorker(stageForRequest(request))
    return new Promise<SpeechWorkerResponse>((resolve, reject) => {
      const abort = (): void => {
        this.pending.delete(request.id)
        reject(new Error('Speech operation cancelled.'))
        void worker.terminate()
        for (const [stage, candidate] of this.workers) {
          if (candidate === worker) this.workers.delete(stage)
        }
      }
      signal.addEventListener('abort', abort, { once: true })
      this.pending.set(request.id, {
        worker,
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

  private rejectWorker(worker: Worker, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.worker !== worker) continue
      this.pending.delete(id)
      pending.reject(error)
    }
  }
}
