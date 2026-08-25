import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { buildProcessEnvironment } from '../drivers/cli-environment'

interface NativeCaptureRequest {
  id: string
  operation: 'start' | 'stop'
  outputPath?: string
}

interface NativeCaptureResponse {
  id: string
  ok: boolean
  error?: string
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

  async start(sessionId: string, outputPath: string): Promise<void> {
    if (!(await this.available())) throw new Error('Native microphone recording is unavailable.')
    if (this.currentSessionId) throw new Error('A native recording is already active.')
    await this.request({
      id: randomUUID(),
      operation: 'start',
      outputPath
    })
    this.currentSessionId = sessionId
  }

  async stop(sessionId: string): Promise<void> {
    if (this.currentSessionId !== sessionId) return
    await this.request({ id: randomUUID(), operation: 'stop' })
    this.currentSessionId = null
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
    child.stderr.on('data', () => undefined)
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
      if (!response.ok) throw new Error(response.error ?? 'Native microphone recorder failed.')
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
