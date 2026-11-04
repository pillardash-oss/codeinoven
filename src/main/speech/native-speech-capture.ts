import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { buildProcessEnvironment } from '../drivers/cli-environment'
import { Logger } from '../system/logger'

interface NativeCaptureRequest {
  id: string
  operation: 'start' | 'stop' | 'prepare' | 'ping' | 'arm' | 'disarm'
  outputPath?: string
  /** The instant the user pressed record, in epoch milliseconds. */
  since?: number
}

interface NativeCaptureResponse {
  id: string
  ok: boolean
  error?: string
  /** CoreAudio's own domain and status, when the worker reported a failure. */
  errorDomain?: string
  errorCode?: number
  /** Audio frames the finished take actually wrote, when a stop reported it. */
  framesWritten?: number | null
  /** How many times the worker rebuilt its engine to keep the take alive. */
  engineRestarts?: number | null
  /** Why a finished take is known to have lost audio, if it did. */
  captureWarning?: string | null
}

/**
 * What a finished native take actually contains.
 *
 * `framesWritten` is the worker's own count of the audio it wrote, so the host
 * can compare the file with the elapsed recording instead of trusting the
 * clock. It is `null` when the worker that recorded the take is gone and only
 * the file on disk knows the answer.
 */
export interface NativeCaptureReport {
  framesWritten: number | null
  engineRestarts: number
  warning: string | null
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
  /**
   * The session whose worker exited while it was still recording.
   *
   * A worker that dies mid-take stops feeding the file, and the previous `stop`
   * silently answered from a freshly spawned worker, so a take that lost most
   * of its audio was finished and transcribed as if it were whole. The session
   * is remembered here so the stop can say what really happened.
   */
  private lostSession: { sessionId: string; reason: string } | null = null

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

  /** Best-effort CoreAudio warmup: spawns the resident worker and lets it build
   *  and prepare a throwaway engine ahead of the first real recording, so a
   *  press on the mic does not pay process and audio-unit init. Only ever called
   *  when microphone access is already granted (see `microphoneAccessGranted`),
   *  never before the TCC decision exists, because touching the input device is
   *  what makes macOS show its permission prompt. Failures are ignored: a cold
   *  start still works, just slower. */
  async warm(): Promise<void> {
    if (!(await this.available())) return
    await this.request({ id: randomUUID(), operation: 'prepare' }).catch(() => undefined)
  }

  /**
   * Spawn the worker ahead of any recording, without touching the microphone.
   *
   * Merely starting the process is what the first press used to pay: Swift
   * runtime and dyld cost up to a second, and everything said during it was
   * gone. This runs at launch and never opens CoreAudio, so it cannot show a
   * permission prompt.
   */
  async ping(): Promise<void> {
    if (!(await this.available())) return
    await this.request({ id: randomUUID(), operation: 'ping' }).catch(() => undefined)
  }

  /**
   * Open the microphone ahead of the press and buffer what it hears.
   *
   * Opening CoreAudio's input device costs 150-800 ms, so a press that opened
   * it lost the first words every time. The renderer arms the recorder as soon
   * as the pointer is over the mic, and pressing only has to open the file and
   * hand the buffered opening over.
   */
  async arm(): Promise<void> {
    if (this.currentSessionId) return
    if (!(await this.available())) return
    await this.request({ id: randomUUID(), operation: 'arm' }).catch((error: unknown) => {
      Logger.dev('Native speech capture could not arm the microphone:', error)
    })
  }

  /** Release an armed microphone the user never pressed. */
  async disarm(): Promise<void> {
    if (this.currentSessionId) return
    if (!this.process) return
    await this.request({ id: randomUUID(), operation: 'disarm' }).catch(() => undefined)
  }

  async start(sessionId: string, outputPath: string, pressedAt?: number): Promise<void> {
    if (!(await this.available())) throw new Error('Native microphone recording is unavailable.')
    // A claim that was never released (a renderer reload, a lost stop) must not
    // fail every later attempt with "a native recording is already active" and
    // strand the run on the browser recorder. The worker stops its own engine
    // on every start, so the stale claim is reclaimed rather than refused.
    if (this.currentSessionId && this.currentSessionId !== sessionId) {
      await this.stop(this.currentSessionId).catch(() => undefined)
    }
    this.lostSession = null
    try {
      await this.request({
        id: randomUUID(),
        operation: 'start',
        outputPath,
        ...(pressedAt !== undefined ? { since: pressedAt } : {})
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

  async stop(sessionId: string): Promise<NativeCaptureReport> {
    const empty: NativeCaptureReport = { framesWritten: null, engineRestarts: 0, warning: null }
    if (this.currentSessionId !== sessionId) return empty
    // The worker died during this take: its file is whatever it managed to
    // write, and a fresh worker has nothing to say about it. Reporting that
    // honestly is what stops a short take being handed on as a whole one.
    if (this.lostSession?.sessionId === sessionId) {
      const report: NativeCaptureReport = {
        framesWritten: null,
        engineRestarts: 0,
        warning: this.lostSession.reason
      }
      this.lostSession = null
      this.currentSessionId = null
      return report
    }
    try {
      const response = await this.request({ id: randomUUID(), operation: 'stop' })
      const framesWritten =
        typeof response.framesWritten === 'number' && response.framesWritten >= 0
          ? response.framesWritten
          : null
      if (response.captureWarning) {
        Logger.error('Native speech capture lost audio during the take', {
          sessionId,
          warning: response.captureWarning,
          engineRestarts: response.engineRestarts ?? 0
        })
      }
      if ((response.engineRestarts ?? 0) > 0) {
        Logger.dev('Native speech capture rebuilt its engine during the take', {
          sessionId,
          engineRestarts: response.engineRestarts ?? 0
        })
      }
      return {
        framesWritten,
        engineRestarts: response.engineRestarts ?? 0,
        warning: response.captureWarning ?? null
      }
    } catch (error) {
      // A rejected or timed-out stop means the worker is wedged with an engine
      // that may still hold the microphone. Kill it instead of reusing it.
      this.restart(error instanceof Error ? error : new Error(String(error)))
      return {
        framesWritten: null,
        engineRestarts: 0,
        warning: 'the microphone recorder stopped responding'
      }
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
      // The take is already settled by the caller, so nothing here needs a
      // graceful exit: the worker refuses polite signals during a take, which is
      // exactly right for a recording and wrong for a shutdown.
      this.process.kill('SIGKILL')
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
    child.once('exit', (code, signal) => {
      this.process = null
      const sessionId = this.currentSessionId
      const detail = `Native microphone recorder exited (code ${code ?? 'none'}, signal ${signal ?? 'none'}).`
      // Every exit is logged, clean or not: a worker that dies mid-take used to
      // leave no trace at all while the take carried on looking live.
      Logger.dev('Native speech capture worker exited', {
        code: code ?? null,
        signal: signal ?? null,
        sessionId
      })
      if (sessionId) {
        this.lostSession = {
          sessionId,
          reason: 'the microphone recorder stopped before the take ended'
        }
        Logger.error('Native microphone recorder stopped during a recording.', { sessionId })
      }
      this.failPending(new Error(detail))
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
    if (!child || child.killed) return
    // The worker ignores a polite signal while a take is live, because that is
    // what stops an external termination request from truncating a recording.
    // This path is the host recovering from a wedged recorder, where a take is
    // no longer usable, so the polite signal gets a short chance and then the
    // process is killed outright.
    child.kill('SIGTERM')
    const escalate = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 750)
    escalate.unref()
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
