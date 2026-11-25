/**
 * A stdio MCP server, run as this Oven's own child process.
 *
 * Ported from the app's `StdioMcpClient` and deliberately narrower: it carries
 * no task-manager row (the Oven has no task manager to list it in) and no
 * package-install recovery (that is the app's scratch directory, not this
 * machine's). What it keeps is the part that makes a stdio server usable at all:
 * newline-delimited JSON-RPC, a bounded budget per request, the child's stderr
 * kept so a startup failure can say why, and a close that always ends the
 * process instead of leaving it behind for the life of the Oven.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { OvenUtilityMcpServer } from '../../../../lib/oven-utility-host'
import {
  OVEN_MCP_CALL_TIMEOUT_MS,
  OVEN_MCP_CONNECT_TIMEOUT_MS,
  OvenUtilityMcpUnavailableError,
  OvenUtilityToolError,
  isRecord,
  ovenMcpRefusalMessage,
  ovenUtilityMcpEnvironment,
  ovenUtilityMcpTarget,
  parseOvenMcpTools,
  type OvenMcpJsonRpcResponse,
  type OvenMcpTool,
  type OvenUtilityMcpClient
} from './oven-utility-mcp'

/**
 * How long a closed server gets to read the EOF on its stdin and stop by itself
 * before it is signalled.
 *
 * An EOF-aware server exits on its own, which is the difference between a clean
 * cancellation and a process killed before it could flush. The wait is short
 * because the turn is already over.
 */
const STOP_GRACE_MS = 300

/** How long a signalled server may take to go before it is killed outright. */
const KILL_GRACE_MS = 1_000

/** How much child stderr is kept so a startup failure can say why it failed. */
const STDERR_TAIL_LIMIT = 2_000

/** Share of the retained stderr one error message carries, head and tail. */
const STDERR_REPORT_LIMIT = 1_600

interface OvenMcpPending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** One stdio MCP connection: one client, one child process. */
export class OvenStdioMcpClient implements OvenUtilityMcpClient {
  private nextId = 1
  private buffer = ''
  private stderrTail = ''
  /** Cleared the moment this connection can no longer be trusted. */
  private retired = false
  private closed = false
  private readonly pending = new Map<number, OvenMcpPending>()

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly target: string
  ) {
    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk.toString()))
    // An unread stderr pipe eventually fills and blocks the child, so it is
    // always drained; keeping a bounded tail is what turns "the process died"
    // into the reason it died, which for a stdio server arrives on stderr alone.
    child.stderr.on('data', (chunk: Buffer) => this.recordStderr(chunk.toString()))
    // A write to a server that has already exited surfaces as an asynchronous
    // EPIPE. Without a listener that is an uncaught exception in the Oven host,
    // and the writes that reach it are the ones sent while a server is dying.
    child.stdin.on('error', () => undefined)
    child.on('close', (code, signal) => {
      this.retired = true
      this.rejectPending(this.exitError(code, signal))
    })
    child.on('error', (error) => {
      this.retired = true
      this.rejectPending(
        new OvenUtilityMcpUnavailableError(
          `MCP server \`${this.target}\` could not start: ${error.message}`,
          { cause: error }
        )
      )
    })
  }

  get usable(): boolean {
    return !this.retired && !this.closed
  }

  /**
   * Start one server and complete its handshake.
   *
   * A server that cannot be spawned, or that dies before answering
   * `initialize`, leaves no child behind: the connection is closed on the way
   * out, so an unavailable server never costs the Oven a process.
   */
  static async connect(server: OvenUtilityMcpServer): Promise<OvenStdioMcpClient> {
    const command = server.command
    const target = ovenUtilityMcpTarget(server)
    if (!command)
      throw new OvenUtilityMcpUnavailableError(
        `Utility \`${server.utilityId}\` has no stdio MCP command to run on this Oven.`
      )
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(command, server.args ?? [], {
        env: ovenUtilityMcpEnvironment(server),
        ...(server.cwd ? { cwd: server.cwd } : {}),
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      throw new OvenUtilityMcpUnavailableError(
        `MCP server \`${target}\` could not start: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      )
    }
    const client = new OvenStdioMcpClient(child, target)
    try {
      await client.request(
        'initialize',
        {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'codeinoven-oven-utility-host', version: '1' }
        },
        OVEN_MCP_CONNECT_TIMEOUT_MS
      )
    } catch (error) {
      await client.close()
      throw error instanceof OvenUtilityMcpUnavailableError
        ? error
        : new OvenUtilityMcpUnavailableError(
            `MCP server \`${target}\` did not complete its handshake: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: error }
          )
    }
    client.notify('notifications/initialized', {})
    return client
  }

  async listTools(): Promise<OvenMcpTool[]> {
    return parseOvenMcpTools(await this.request('tools/list', {}, OVEN_MCP_CALL_TIMEOUT_MS))
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    return await this.request('tools/call', { name, arguments: input }, OVEN_MCP_CALL_TIMEOUT_MS)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.retired = true
    this.rejectPending(new OvenUtilityMcpUnavailableError('The MCP connection was closed.'))
    this.child.stdin.end()
    if (!(await waitForExit(this.child, STOP_GRACE_MS))) {
      this.child.kill()
      if (!(await waitForExit(this.child, KILL_GRACE_MS))) this.child.kill('SIGKILL')
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    budgetMs: number
  ): Promise<unknown> {
    if (!this.usable) {
      // A retired connection has no child left to answer, so this fails now
      // instead of spending a request budget waiting for nothing.
      return Promise.reject(
        new OvenUtilityMcpUnavailableError(
          `MCP request refused on a closed connection \`${this.target}\`: ${method}`
        )
      )
    }
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // The server is still working on a call nobody waits for any more, and
        // whatever it is running is already delaying every later call on this
        // child, so the connection is retired rather than reused.
        this.notify('notifications/cancelled', {
          requestId: id,
          reason: `\`${method}\` exceeded the ${budgetMs} ms request budget`
        })
        void this.close()
        reject(
          new OvenUtilityMcpUnavailableError(
            `MCP server \`${this.target}\` did not answer ${method} within ${budgetMs} ms.`
          )
        )
      }, budgetMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private write(value: Record<string, unknown>): void {
    try {
      this.child.stdin.write(`${JSON.stringify(value)}\n`)
    } catch {
      // A server that is gone cannot be written to; its `close` handler reports
      // that, so a failed write stays silent here.
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    let boundary = this.buffer.indexOf('\n')
    while (boundary >= 0) {
      const line = this.buffer.slice(0, boundary).trim()
      this.buffer = this.buffer.slice(boundary + 1)
      if (line) this.consumeLine(line)
      boundary = this.buffer.indexOf('\n')
    }
  }

  private consumeLine(line: string): void {
    let response: OvenMcpJsonRpcResponse
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed)) return
      response = parsed
    } catch {
      // Ignore non-protocol stdout from third-party MCP processes.
      return
    }
    if (typeof response.id !== 'number') return
    const pending = this.pending.get(response.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(response.id)
    if (response.error)
      pending.reject(new OvenUtilityToolError(ovenMcpRefusalMessage(response.error)))
    else pending.resolve(response.result)
  }

  private recordStderr(text: string): void {
    const combined = this.stderrTail + text
    this.stderrTail =
      combined.length > STDERR_TAIL_LIMIT ? combined.slice(-STDERR_TAIL_LIMIT) : combined
  }

  /** The failure an agent can act on: how the process died, and what it said. */
  private exitError(code: number | null, signal: NodeJS.Signals | null): Error {
    if (this.closed) return new OvenUtilityMcpUnavailableError('The MCP connection was closed.')
    const how = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
    const detail = this.stderrTail.trim()
    const reported =
      detail.length > STDERR_REPORT_LIMIT
        ? `${detail.slice(0, STDERR_REPORT_LIMIT / 2)}\n…\n${detail.slice(-STDERR_REPORT_LIMIT / 2)}`
        : detail
    return new OvenUtilityMcpUnavailableError(
      `MCP server \`${this.target}\` exited with ${how}${reported ? `: ${reported}` : ''}`
    )
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

/** Whether one child has gone, waiting up to `timeoutMs` for it. */
function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let settled = false
    function finish(gone: boolean): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('close', onClosed)
      resolve(gone)
    }
    function onClosed(): void {
      finish(true)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref()
    child.once('close', onClosed)
  })
}
