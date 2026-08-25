import { randomUUID } from 'node:crypto'
import { access, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { SpeechCapability } from '../../../lib/speech/types'
import type {
  SpeechBackend,
  SpeechBackendArtifact,
  SpeechSynthesisInput,
  SpeechTranscribeInput
} from '../speech-backend'
import { resolveFfmpegPath } from '../ffmpeg-path'

interface CoreMlRequest {
  id: string
  operation: 'transcribe'
  model: string
  audio: string
}

interface CoreMlResponse {
  id: string
  ok: boolean
  text?: string
  error?: string
}

interface PendingRequest {
  resolve: (response: CoreMlResponse) => void
  reject: (error: Error) => void
}

/** Apple Silicon Core ML adapter backed by the packaged FluidAudio worker. */
export class CoreMlSpeechBackend implements SpeechBackend {
  readonly runtime = 'coreml' as const
  private process: ChildProcessWithoutNullStreams | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private buffered = ''

  constructor(private readonly executablePath: string) {}

  async capabilities(): Promise<SpeechCapability[]> {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return []
    try {
      await access(this.executablePath)
      await resolveFfmpegPath()
      return ['asr']
    } catch {
      return []
    }
  }

  async transcribe(input: SpeechTranscribeInput, signal: AbortSignal): Promise<string> {
    const decodedPath = await this.decodeToWav(input.audioPath, signal)
    try {
      const response = await this.request(
        {
          id: randomUUID(),
          operation: 'transcribe',
          model: input.artifact.directory,
          audio: decodedPath
        },
        signal
      )
      if (!response.ok || typeof response.text !== 'string') {
        throw new Error(response.error ?? 'Core ML speech worker returned no transcript.')
      }
      return response.text
    } finally {
      await rm(decodedPath, { force: true }).catch(() => undefined)
    }
  }

  private async decodeToWav(sourcePath: string, signal: AbortSignal): Promise<string> {
    const decoder = await resolveFfmpegPath()
    const decodedPath = `${sourcePath}.coreml.wav`
    if (signal.aborted) throw new Error('Speech operation cancelled.')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        decoder,
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          sourcePath,
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'pcm_s16le',
          decodedPath
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      )
      let failure = ''
      const onAbort = (): void => {
        child.kill('SIGKILL')
        reject(new Error('Speech operation cancelled.'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        if (failure.length < 2000) failure += chunk
      })
      child.once('error', (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      })
      child.once('exit', (code) => {
        signal.removeEventListener('abort', onAbort)
        if (code === 0) resolve()
        else
          reject(
            new Error(failure.trim() || `Audio decoding exited with code ${code ?? 'unknown'}.`)
          )
      })
    })
    return decodedPath
  }

  async cleanup(
    _transcript: string,
    _artifact: SpeechBackendArtifact,
    signal: AbortSignal
  ): Promise<string> {
    if (signal.aborted) throw new Error('Speech operation cancelled.')
    throw new Error(
      'Core ML does not support transcript cleanup. Use MLX or sherpa-onnx cleanup models.'
    )
  }

  async synthesize(_input: SpeechSynthesisInput, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('Speech operation cancelled.')
    throw new Error('Core ML does not support speech synthesis. Use MLX or sherpa-onnx TTS models.')
  }

  async dispose(): Promise<void> {
    const child = this.process
    this.process = null
    child?.kill('SIGTERM')
    for (const pending of this.pending.values())
      pending.reject(new Error('Core ML worker stopped.'))
    this.pending.clear()
  }

  private request(request: CoreMlRequest, signal: AbortSignal): Promise<CoreMlResponse> {
    if (signal.aborted) return Promise.reject(new Error('Speech operation cancelled.'))
    const child = this.ensureProcess()
    return new Promise<CoreMlResponse>((resolve, reject) => {
      const abort = (): void => {
        this.pending.delete(request.id)
        reject(new Error('Speech operation cancelled.'))
        this.process?.kill('SIGTERM')
        this.process = null
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
      child.stdin.write(`${JSON.stringify(request)}\n`)
    })
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.process) return this.process
    const child = spawn(this.executablePath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.receive(chunk))
    child.on('error', (error) => this.rejectAll(error))
    child.on('exit', (code) => {
      this.process = null
      this.rejectAll(new Error(`Core ML speech worker exited with code ${code ?? 'unknown'}.`))
    })
    this.process = child
    return child
  }

  private receive(chunk: string): void {
    this.buffered += chunk
    while (true) {
      const newline = this.buffered.indexOf('\n')
      if (newline === -1) return
      const line = this.buffered.slice(0, newline)
      this.buffered = this.buffered.slice(newline + 1)
      let response: unknown
      try {
        response = JSON.parse(line)
      } catch {
        continue
      }
      if (!this.isResponse(response)) continue
      const pending = this.pending.get(response.id)
      if (!pending) continue
      this.pending.delete(response.id)
      if (response.ok) pending.resolve(response)
      else pending.reject(new Error(response.error ?? 'Core ML speech worker failed.'))
    }
  }

  private isResponse(value: unknown): value is CoreMlResponse {
    if (typeof value !== 'object' || value === null) return false
    const candidate = value as Record<string, unknown>
    return typeof candidate['id'] === 'string' && typeof candidate['ok'] === 'boolean'
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
