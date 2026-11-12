import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { Logger } from '../../system/logger'
import { stopProcessGroup } from '../../system/process-group-stop'
import {
  ACP_METHOD_NOT_FOUND,
  acpRecord,
  acpString,
  type AcpErrorObject,
  type AcpRequestId
} from './acp-protocol'

/** One JSON-RPC failure reported by the agent. */
export class AcpError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'AcpError'
  }
}

export interface AcpClientOptions {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Called for every agent notification (`method` without an `id`). */
  onNotification: (method: string, params: unknown) => void
  /** Called for every agent request (`method` with an `id`); return its result. */
  onRequest: (method: string, params: unknown) => Promise<unknown>
  /** Called once the agent process is gone; `expected` marks a driver-initiated stop. */
  onExit: (info: {
    code: number | null
    signal: NodeJS.Signals | null
    stderrTail: string
    expected: boolean
  }) => void
  /** Per-request timeout, in milliseconds. */
  requestTimeoutMs?: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60 * 1000
/** Time the agent group gets to exit on its own before the helpers are killed. */
const GROUP_EXIT_GRACE_MS = 1_500
const STDERR_TAIL_LIMIT = 8_000

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Newline-delimited JSON-RPC 2.0 over one agent process's stdio.
 *
 * The client owns framing, request correlation, timeouts and teardown. It knows
 * nothing about ACP semantics: the driver maps methods to app behaviour, so a
 * newer protocol revision can be adopted by changing that mapping only.
 */
export class AcpClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private stdoutBuffer = ''
  private stderrTail = ''
  private readonly pending = new Map<string, PendingRequest>()
  private nextId = 1
  private closed = false
  private expectedStop = false

  constructor(private readonly options: AcpClientOptions) {}

  /** Spawn the agent. Resolves once the process exists; ACP starts on `initialize`. */
  start(): void {
    if (this.child) return
    const child = spawn(this.options.command, [...this.options.args], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // The agent forks helpers of its own (cursor-agent starts a
      // `worker-server`), so it leads its own process group and a stop reaches
      // all of them instead of leaking the helpers to launchd.
      detached: process.platform !== 'win32'
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.readStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT)
    })
    child.on('error', (error) => {
      this.failAll(new Error(`${this.options.command} could not start: ${error.message}`))
    })
    child.on('close', (code, signal) => {
      this.closed = true
      this.failAll(
        new Error(
          `${this.options.command} exited${code === null ? '' : ` with code ${code}`}${
            this.stderrTail.trim() ? `: ${this.stderrTail.trim().slice(-600)}` : ''
          }`
        )
      )
      this.options.onExit({
        code,
        signal,
        stderrTail: this.stderrTail,
        expected: this.expectedStop
      })
    })
    child.stdin.on('error', (error) => {
      Logger.dev('ACP stdin closed', error)
    })
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  get alive(): boolean {
    return this.child !== null && !this.closed
  }

  /** Last bytes the agent wrote to stderr, for a diagnostic error card. */
  get diagnostics(): string {
    return this.stderrTail
  }

  async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    const child = this.child
    if (!child || this.closed) throw new Error('The ACP agent process is not running')
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(String(id))
          reject(new AcpError(method, -32000, `ACP request "${method}" timed out`))
        },
        timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
      )
      timer.unref?.()
      this.pending.set(String(id), { method, resolve, reject, timer })
      child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return
        const entry = this.pending.get(String(id))
        if (!entry) return
        this.pending.delete(String(id))
        clearTimeout(entry.timer)
        reject(new Error(`Could not write "${method}" to the ACP agent: ${error.message}`))
      })
    })
  }

  notify(method: string, params: unknown): void {
    const child = this.child
    if (!child || this.closed) return
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  /** Stop the agent. Pending requests reject; the exit is marked as expected. */
  stop(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.expectedStop = true
    const child = this.child
    if (!child) return
    this.closed = true
    this.failAll(new Error('The ACP agent process was stopped'))
    this.child = null
    const pid = child.pid
    child.kill(signal)
    if (!pid) return
    // Signal the group as well: the leader exiting on its own leaves the helpers
    // it forked running, and one daemon per agent restart is how orphans pile up.
    stopProcessGroup(pid, signal)
    setTimeout(() => stopProcessGroup(pid, 'SIGKILL'), GROUP_EXIT_GRACE_MS).unref?.()
  }

  private readStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    const lines = this.stdoutBuffer.split('\n')
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        Logger.dev('ACP emitted a non-JSON line', trimmed.slice(0, 400))
        continue
      }
      this.dispatch(parsed)
    }
  }

  private dispatch(message: unknown): void {
    const record = acpRecord(message)
    if (!record) return
    const id = record['id'] as AcpRequestId | undefined
    const method = acpString(record['method'])
    if (method === undefined && id !== undefined) {
      this.settleResponse(id, record)
      return
    }
    if (method === undefined) return
    if (id === undefined) {
      this.options.onNotification(method, record['params'])
      return
    }
    void this.answerRequest(id, method, record['params'])
  }

  private settleResponse(id: AcpRequestId, record: Record<string, unknown>): void {
    const entry = this.pending.get(String(id))
    if (!entry) return
    this.pending.delete(String(id))
    clearTimeout(entry.timer)
    const error = acpRecord(record['error'])
    if (error) {
      entry.reject(
        new AcpError(
          entry.method,
          typeof error['code'] === 'number' ? error['code'] : -32000,
          acpString(error['message']) ?? 'ACP request failed',
          error['data']
        )
      )
      return
    }
    entry.resolve(record['result'])
  }

  private async answerRequest(id: AcpRequestId, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.options.onRequest(method, params)
      this.writeResult({ jsonrpc: '2.0', id, result: result ?? {} })
    } catch (error) {
      const code = error instanceof AcpError ? error.code : ACP_METHOD_NOT_FOUND
      const failure: AcpErrorObject = {
        code,
        message: error instanceof Error ? error.message : 'ACP request failed'
      }
      this.writeResult({ jsonrpc: '2.0', id, error: failure })
    }
  }

  private writeResult(message: Record<string, unknown>): void {
    const child = this.child
    if (!child || this.closed) return
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }
}
