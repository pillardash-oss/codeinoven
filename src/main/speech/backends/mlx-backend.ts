import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { rm } from 'node:fs/promises'
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

type MlxRequest =
  | { id: string; operation: 'transcribe'; model: string; audio: string; language: string }
  | { id: string; operation: 'cleanup'; model: string; transcript: string }
  | {
      id: string
      operation: 'synthesize'
      model: string
      text: string
      voice: string
      output: string
    }

interface MlxResponse {
  id: string
  ok: boolean
  text?: string
  error?: string
}

interface PendingMlxRequest {
  resolve: (response: MlxResponse) => void
  reject: (error: Error) => void
}

/**
 * Apple Silicon adapter for a signed, packaged JSON-lines worker. Development
 * never searches PATH and unsupported installations remain a typed capability
 * failure rather than switching to sherpa.
 */
export class MlxSpeechBackend implements SpeechBackend {
  readonly runtime = 'mlx' as const
  private process: ChildProcessWithoutNullStreams | null = null
  private readonly pending = new Map<string, PendingMlxRequest>()
  private buffered = ''

  constructor(private readonly executablePath: string) {}

  async capabilities(): Promise<SpeechCapability[]> {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return []
    try {
      await access(this.executablePath)
      await resolveFfmpegPath()
      return ['asr', 'cleanup', 'tts']
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
          audio: decodedPath,
          language: input.language
        },
        signal
      )
      return this.text(response)
    } finally {
      await rm(decodedPath, { force: true }).catch(() => undefined)
    }
  }

  private async decodeToWav(sourcePath: string, signal: AbortSignal): Promise<string> {
    const decoder = await resolveFfmpegPath()
    const decodedPath = `${sourcePath}.decoded.wav`
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
      child.once('error', (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      })
      child.once('exit', (code: number | null) => {
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
    transcript: string,
    artifact: SpeechBackendArtifact,
    signal: AbortSignal
  ): Promise<string> {
    const response = await this.request(
      { id: randomUUID(), operation: 'cleanup', model: artifact.directory, transcript },
      signal
    )
    return this.text(response)
  }

  async synthesize(input: SpeechSynthesisInput, signal: AbortSignal): Promise<void> {
    await this.request(
      {
        id: randomUUID(),
        operation: 'synthesize',
        model: input.artifact.directory,
        text: input.text,
        voice: input.voiceId,
        output: input.outputPath
      },
      signal
    )
  }

  async dispose(): Promise<void> {
    const child = this.process
    this.process = null
    child?.kill('SIGTERM')
    for (const pending of this.pending.values()) pending.reject(new Error('MLX worker stopped.'))
    this.pending.clear()
  }

  private request(request: MlxRequest, signal: AbortSignal): Promise<MlxResponse> {
    if (signal.aborted) return Promise.reject(new Error('Speech operation cancelled.'))
    const child = this.ensureProcess()
    return new Promise<MlxResponse>((resolve, reject) => {
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
      this.rejectAll(new Error(`MLX speech worker exited with code ${code ?? 'unknown'}.`))
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
      else pending.reject(new Error(response.error ?? 'MLX speech worker failed.'))
    }
  }

  private text(response: MlxResponse): string {
    if (!response.ok || typeof response.text !== 'string') {
      throw new Error(response.error ?? 'MLX speech worker returned no text.')
    }
    return response.text
  }

  private isResponse(value: unknown): value is MlxResponse {
    if (typeof value !== 'object' || value === null) return false
    const candidate = value as Record<string, unknown>
    return typeof candidate['id'] === 'string' && typeof candidate['ok'] === 'boolean'
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
