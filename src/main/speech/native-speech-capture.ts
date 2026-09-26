import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { buildProcessEnvironment } from '../drivers/cli-environment'
import { Logger } from '../system/logger'

interface NativeCaptureRequest {
  id: string
  operation: 'start' | 'stop' | 'prepare'
  outputPath?: string
}

interface NativeCaptureResponse {
  id: string
  ok: boolean
  error?: string
  /** CoreAudio's own domain and status, when the worker reported a failure. */
  errorDomain?: string
  errorCode?: number
}

interface PendingRequest {
  resolve: (response: NativeCaptureResponse) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

/** Main-process adapter for the macOS lossless PCM capture worker. */
export class NativeSpeechCapture {
  private process: ChildProcessWithoutNullStreams | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private buffered = ''
  private currentSessionId: string | null = null
  /**
   * The worker's recent stderr.
   *
   * The worker reports every CoreAudio failure with its OSStatus on stderr, and
   * it used to be discarded, which left "error 2003329396" with no record of
   * which call or which device reported it. Kept bounded so a chatty worker
   * cannot grow the buffer.
   */
  private stderrTail = ''

  constructor(private readonly executablePath: string) {}

  get activeSessionId(): string | null {
    return this.currentSessionId
  }

  async available(): Promise<boolean> {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return false
    try {
      await access(this.executablePath)
      return true
    } catch {
      return false
    }
  }

  /** Best-effort startup warmup: spawns the resident worker and lets it
   *  initialize CoreAudio ahead of the first real recording, so double-press
   *  (or click) starts capture without paying process and audio-unit init
   *  latency. Failures are ignored — a cold start still works, just slower. */
  async warm(): Promise<void> {
    if (!(await this.available())) return
    await this.request({ id: randomUUID(), operation: 'prepare' }).catch(() => undefined)
  }

  async start(sessionId: string, outputPath: string): Promise<void> {
    if (!(await this.available())) throw new Error('Native microphone recording is unavailable.')
    // A claim that was never released (a renderer reload, a lost stop) must not
    // fail every later attempt with "a native recording is already active" and
    // strand the run on the browser recorder. The worker stops its own engine
    // on every start, so the stale claim is reclaimed rather than refused.
    if (this.currentSessionId && this.currentSessionId !== sessionId) {
      await this.stop(this.currentSessionId).catch(() => undefined)
    }
    try {
      await this.request({
        id: randomUUID(),
        operation: 'start',
        outputPath
      })
    } catch (error) {
      // A failed or unresponsive start leaves a worker whose engine may be
      // half-built with the microphone open. Nothing can reuse it safely, so it
      // is killed and the next attempt gets a fresh CoreAudio state.
      this.restart(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
    this.currentSessionId = sessionId
  }

  async stop(sessionId: string): Promise<void> {
    if (this.currentSessionId !== sessionId) return
    try {
      await this.request({ id: randomUUID(), operation: 'stop' })
    } catch (error) {
      // A rejected or timed-out stop means the worker is wedged with an engine
      // that may still hold the microphone. Kill it instead of reusing it.
      this.restart(error instanceof Error ? error : new Error(String(error)))
    } finally {
      // A rejected stop (the worker exited or wedged) still ends this session's
      // claim on the microphone. Leaving the claim set would fail every later
      // `start()` with "a native recording is already active" and strand the
      // renderer on its browser capture path, where the microphone is held by
      // `getUserMedia` and a reconfigured audio device revokes the track, for
      // the rest of the run. The worker stops its own previous engine on every
      // `start`, so clearing here can never leave two recordings running.
      this.currentSessionId = null
    }
  }

  async dispose(): Promise<void> {
    if (this.currentSessionId) {
      await this.request({ id: randomUUID(), operation: 'stop' }).catch(() => undefined)
      this.currentSessionId = null
    }
    if (this.process) {
      this.process.kill()
      this.process = null
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Native microphone recording stopped.'))
      this.pending.delete(id)
    }
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.process && !this.process.killed) return this.process
    const child = spawn(this.executablePath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildProcessEnvironment()
    })
    this.process = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.read(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.recordStderr(chunk))
    child.once('error', (error) => this.failPending(error))
    child.once('exit', (code) => {
      this.process = null
      if (code !== 0)
        this.failPending(
          new Error(`Native microphone recorder exited with code ${code ?? 'unknown'}.`)
        )
    })
    return child
  }

  /**
   * Kill the worker and drop everything that refers to it.
   *
   * A worker left alive after a failed start keeps its engine and tap, so the
   * microphone stays claimed by a process nothing will stop. Killing it here is
   * what makes the next attempt a fresh start rather than a reuse.
   */
  private restart(reason: Error): void {
    const child = this.process
    this.process = null
    this.buffered = ''
    this.currentSessionId = null
    this.failPending(reason)
    if (child && !child.killed) child.kill()
  }

  private recordStderr(chunk: string): void {
    this.stderrTail = (this.stderrTail + chunk).slice(-2_000)
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) Logger.dev(`Native speech capture: ${trimmed}`)
    }
  }

  private request(request: NativeCaptureRequest): Promise<NativeCaptureResponse> {
    const child = this.ensureProcess()
    return new Promise<NativeCaptureResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.id)
        reject(new Error('Native microphone recorder did not respond.'))
      }, 10_000)
      this.pending.set(request.id, { resolve, reject, timeout })
      child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return
        clearTimeout(timeout)
        this.pending.delete(request.id)
        reject(error)
      })
    }).then((response) => {
      if (!response.ok) {
        if (response.errorDomain) {
          Logger.dev('Native speech capture failed', {
            domain: response.errorDomain,
            code: response.errorCode ?? null,
            detail: response.error ?? ''
          })
        }
        if (this.stderrTail) {
          Logger.dev('Native speech capture stderr:', this.stderrTail.trim())
        }
        throw new Error(response.error ?? 'Native microphone recorder failed.')
      }
      return response
    })
  }

  private read(chunk: string): void {
    this.buffered += chunk
    while (true) {
      const newline = this.buffered.indexOf('\n')
      if (newline < 0) return
      const line = this.buffered.slice(0, newline).trim()
      this.buffered = this.buffered.slice(newline + 1)
      if (!line) continue
      let response: NativeCaptureResponse
      try {
        response = JSON.parse(line) as NativeCaptureResponse
      } catch {
        continue
      }
      const pending = this.pending.get(response.id)
      if (!pending) continue
      this.pending.delete(response.id)
      clearTimeout(pending.timeout)
      pending.resolve(response)
    }
  }

  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}
