/// <reference types="electron-vite/node" />
import sherpaEnginePath from '../sherpa-engine-process.ts?modulePath'
import { utilityProcess, type UtilityProcess } from 'electron'
import { randomUUID } from 'node:crypto'
import type { SpeechCapability } from '../../../lib/speech/types'
import { Logger } from '../../system/logger'
import { broadcastAppToast } from '../../ipc/app-toast'
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
  engine: UtilityProcess
}

/**
 * Speech pipeline stage an engine process is dedicated to. Each stage gets at
 * most one engine, so a TTS synthesis can run while an ASR transcription is in
 * flight without either stage growing unbounded native threads.
 */
type SpeechWorkerStage = 'asr' | 'tts'

/** How long an engine gets to leave on its own before it is killed. */
const ENGINE_DRAIN_GRACE_MS = 2_000

/** Bounded stderr tail kept for the crash report (mirrors the stdio MCP client). */
const ENGINE_STDERR_TAIL_CHARS = 2_000

function stageForRequest(request: SpeechWorkerRequest): SpeechWorkerStage {
  return request.kind === 'synthesize' ? 'tts' : 'asr'
}

/**
 * Portable sherpa adapter; native calls run inside stage-dedicated
 * `utilityProcess` children (at most one ASR engine plus one TTS engine per
 * backend instance). Together with the llama.cpp cleanup server this keeps the
 * app at a maximum of three concurrent speech processes.
 *
 * The engine is a process, never a worker thread, and that is a correctness
 * requirement rather than a preference. `sherpa-onnx-node` is a native addon:
 * when it throws from an async completion during environment teardown (a
 * cancelled warmup that was mid model load did exactly that), the exception
 * cannot become a JavaScript error, `std::terminate` runs, and whatever process
 * hosted the addon dies. In a worker thread that was the whole app; here the
 * worst case is one engine process, which this backend reports as a toast and
 * replaces on the next request.
 */
export class SherpaSpeechBackend implements SpeechBackend {
  readonly runtime = 'sherpa-onnx' as const
  private readonly engines = new Map<SpeechWorkerStage, UtilityProcess>()
  private readonly pending = new Map<string, PendingRequest>()
  /** Engines this backend asked to stop, whose exit must not read as a crash. */
  private readonly stopping = new WeakSet<UtilityProcess>()
  private readonly stderrTails = new WeakMap<UtilityProcess, string>()

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

  isResident(): boolean {
    return this.engines.size > 0
  }

  async dispose(): Promise<void> {
    const engines = [...new Set(this.engines.values())]
    this.engines.clear()
    for (const pending of this.pending.values()) {
      pending.reject(new Error('Sherpa speech engine stopped.'))
    }
    this.pending.clear()
    for (const engine of engines) this.stopEngine(engine)
  }

  private ensureEngine(stage: SpeechWorkerStage): UtilityProcess {
    const existing = this.engines.get(stage)
    if (existing) return existing
    const engine = utilityProcess.fork(sherpaEnginePath, [], {
      // Only stderr is kept, and only as a bounded tail: an engine that dies
      // silently is diagnosable exactly to the point of what it printed.
      stdio: ['ignore', 'ignore', 'pipe'],
      serviceName: `CodeInOven speech ${stage}`
    })
    engine.on('message', (response: SpeechWorkerResponse) => {
      const pending = this.pending.get(response.id)
      if (!pending) return
      this.pending.delete(response.id)
      pending.resolve(response)
    })
    engine.stderr?.on('data', (chunk: Buffer | string) => {
      this.recordStderr(engine, chunk.toString())
    })
    engine.on('error', (type, location, report) => {
      // A V8 fatal error still ends in an exit event, which is where the user
      // is told about it; this line exists so the report itself is not lost.
      Logger.error('Speech engine reported a fatal error', { stage, type, location, report })
    })
    engine.on('exit', (code) => this.onEngineExit(stage, engine, code))
    this.engines.set(stage, engine)
    return engine
  }

  private recordStderr(engine: UtilityProcess, chunk: string): void {
    if (chunk.length === 0) return
    const combined = (this.stderrTails.get(engine) ?? '') + chunk
    this.stderrTails.set(
      engine,
      combined.length > ENGINE_STDERR_TAIL_CHARS
        ? combined.slice(combined.length - ENGINE_STDERR_TAIL_CHARS)
        : combined
    )
  }

  /**
   * Account for one engine process ending.
   *
   * Every request still waiting on it is failed here, because an exit is the
   * only answer a dead process can give. An exit nobody asked for is a crash:
   * it is logged with the engine's stderr tail and shown to the user as a
   * toast, and the next request forks a fresh engine.
   */
  private onEngineExit(stage: SpeechWorkerStage, engine: UtilityProcess, code: number): void {
    if (this.engines.get(stage) === engine) this.engines.delete(stage)
    const intentional = this.stopping.delete(engine)
    const message = intentional
      ? 'The speech engine was stopped.'
      : 'The speech engine stopped unexpectedly.'
    for (const [id, pending] of this.pending) {
      if (pending.engine !== engine) continue
      this.pending.delete(id)
      pending.reject(new Error(message))
    }
    if (intentional) return
    const stderr = this.stderrTails.get(engine)?.trim() ?? ''
    Logger.error('Speech engine exited unexpectedly', {
      stage,
      code,
      ...(stderr ? { stderr } : {})
    })
    broadcastAppToast({
      message: 'The speech engine crashed. It restarts automatically, so you can try again.',
      type: 'error',
      ...(stderr ? { details: stderr } : {})
    })
  }

  /**
   * Ask one engine to leave, and kill it if it has not.
   *
   * The shutdown request is answered immediately and lets the engine exit once
   * its native call settles, which keeps a cancellation from tearing a live
   * native call down (the child can survive that, but it would fill the crash
   * log with aborts). The kill is the guarantee for an engine stuck in a call
   * that will never settle, and it is safe here: this process is the engine's
   * neighbor, not its host.
   */
  private stopEngine(engine: UtilityProcess): void {
    if (this.stopping.has(engine)) return
    this.stopping.add(engine)
    for (const [stage, candidate] of this.engines) {
      if (candidate === engine) this.engines.delete(stage)
    }
    const shutdown: SpeechWorkerRequest = { id: randomUUID(), kind: 'shutdown' }
    try {
      engine.postMessage(shutdown)
    } catch {
      // The engine died between the last call and this one.
    }
    const killer = setTimeout(() => {
      engine.kill()
    }, ENGINE_DRAIN_GRACE_MS)
    killer.unref()
    engine.once('exit', () => clearTimeout(killer))
  }

  private request(
    request: SpeechWorkerRequest,
    signal: AbortSignal
  ): Promise<SpeechWorkerResponse> {
    if (signal.aborted) return Promise.reject(new Error('Speech operation cancelled.'))
    const engine = this.ensureEngine(stageForRequest(request))
    return new Promise<SpeechWorkerResponse>((resolve, reject) => {
      const abort = (): void => {
        this.pending.delete(request.id)
        reject(new Error('Speech operation cancelled.'))
        this.stopEngine(engine)
      }
      signal.addEventListener('abort', abort, { once: true })
      this.pending.set(request.id, {
        engine,
        resolve: (response) => {
          signal.removeEventListener('abort', abort)
          resolve(response)
        },
        reject: (error) => {
          signal.removeEventListener('abort', abort)
          reject(error)
        }
      })
      try {
        engine.postMessage(request)
      } catch (cause) {
        this.pending.delete(request.id)
        signal.removeEventListener('abort', abort)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    })
  }
}
