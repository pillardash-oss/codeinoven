/// <reference types="node" />

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { buildProcessEnvironment } from '../drivers/cli-environment'
import { getConfigRoot } from '../../lib/utils'

export const MCP_TIMEOUT_MS = 30_000

/** How much child stderr is kept so a startup failure can say why it failed. */
const STDERR_TAIL_LIMIT = 2_000

/** Share of the retained stderr that one error message carries. */
const STDERR_REPORT_LIMIT = 600

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** What a server reported about itself while answering `initialize`. */
export interface McpServerInfo {
  name?: string
  version?: string
}

export interface McpClient {
  listTools(): Promise<McpTool[]>
  callTool(name: string, input: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
  /** Filled once the handshake completes; a connection test reports it back. */
  readonly serverInfo?: McpServerInfo
}

/** Read `result.serverInfo` from an `initialize` response, ignoring a malformed one. */
export function parseMcpServerInfo(result: unknown): McpServerInfo {
  if (!isRecord(result)) return {}
  const info = result['serverInfo']
  if (!isRecord(info)) return {}
  return {
    ...(typeof info['name'] === 'string' ? { name: info['name'] } : {}),
    ...(typeof info['version'] === 'string' ? { version: info['version'] } : {})
  }
}

/**
 * The directory an MCP child process runs in: app-owned, and deliberately empty
 * of any `package.json` or `.npmrc`.
 *
 * An `npx`-launched server resolves its package against the working directory,
 * and the Electron process's own cwd is whatever launched the app. When that cwd
 * is a source checkout, npm reads that project's `overrides` and `.npmrc`: a
 * single conflicting override then aborts the install with `EOVERRIDE` before
 * the MCP server ever starts (the community Slack server died exactly this way
 * inside CodeInOven's own checkout). A neutral directory keeps the server's
 * install independent of whichever project the app happens to be sitting in.
 */
function mcpWorkingDirectory(): string | undefined {
  const directory = join(getConfigRoot(), 'runtime', 'mcp-servers')
  try {
    mkdirSync(directory, { recursive: true })
    return directory
  } catch {
    // A cwd is an optimization, never a reason an MCP server cannot start.
    return undefined
  }
}

/**
 * Minimal JSON-over-stdio MCP client shared by the per-turn utility gateway
 * and long-lived services (e.g. the computer-use PiP monitor). One instance
 * owns one spawned child process.
 */
export class StdioMcpClient implements McpClient {
  serverInfo: McpServerInfo = {}

  private nextId = 1
  private buffer = ''
  private stderrTail = ''
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly command: string
  ) {
    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk.toString()))
    // An unread stderr pipe eventually fills and blocks the child, so always drain it.
    // Keeping a bounded tail is what turns "the process died" into the reason it died:
    // a stdio MCP that exits over a missing credential reports that on stderr alone.
    child.stderr.on('data', (chunk: Buffer) => this.recordStderr(chunk.toString()))
    // `close` rather than `exit`: it fires once the stdio streams are drained, so the
    // tail above is complete by the time the failure is reported.
    child.on('close', (code, signal) => this.rejectPending(this.exitError(code, signal)))
    child.on('error', (error) => this.rejectPending(error))
  }

  static async connect(
    command: string,
    args: string[],
    environment: Record<string, string>
  ): Promise<StdioMcpClient> {
    const client = new StdioMcpClient(
      spawn(command, args, {
        env: { ...buildProcessEnvironment(), ...environment },
        cwd: mcpWorkingDirectory(),
        stdio: ['pipe', 'pipe', 'pipe']
      }),
      command
    )
    client.serverInfo = parseMcpServerInfo(
      await client.request('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'codeinoven-utility-gateway', version: '1' }
      })
    )
    client.notify('notifications/initialized', {})
    return client
  }

  async listTools(): Promise<McpTool[]> {
    const result = recordValue(await this.request('tools/list', {}))
    const tools = Array.isArray(result['tools']) ? result['tools'] : []
    return tools.flatMap((value) => {
      if (!isRecord(value) || typeof value['name'] !== 'string') return []
      return [
        {
          name: value['name'],
          ...(typeof value['description'] === 'string'
            ? { description: value['description'] }
            : {}),
          ...(isRecord(value['inputSchema']) ? { inputSchema: value['inputSchema'] } : {})
        }
      ]
    })
  }

  callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    return this.request('tools/call', { name, arguments: input })
  }

  async close(): Promise<void> {
    this.rejectPending(new Error('MCP client closed'))
    this.child.kill()
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request timed out: ${method}`))
      }, MCP_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private write(value: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`)
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
    try {
      const response = JSON.parse(line) as JsonRpcResponse
      if (response.jsonrpc !== '2.0' || typeof response.id !== 'number') return
      const pending = this.pending.get(response.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(response.id)
      if (response.error) pending.reject(new Error(response.error.message))
      else pending.resolve(response.result)
    } catch {
      // Ignore non-protocol stdout from third-party MCP processes.
    }
  }

  private recordStderr(text: string): void {
    const combined = this.stderrTail + text
    this.stderrTail =
      combined.length > STDERR_TAIL_LIMIT ? combined.slice(-STDERR_TAIL_LIMIT) : combined
  }

  /** The failure an agent can act on: how the process died, and what it said first. */
  private exitError(code: number | null, signal: NodeJS.Signals | null): Error {
    const how = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
    const detail = this.stderrTail.trim()
    const reported =
      detail.length > STDERR_REPORT_LIMIT ? `...${detail.slice(-STDERR_REPORT_LIMIT)}` : detail
    return new Error(
      `MCP server \`${this.command}\` exited with ${how}${reported ? `: ${reported}` : ''}`
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

function recordValue(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('Expected an object')
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
