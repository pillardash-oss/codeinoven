/// <reference types="node" />

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { buildProcessEnvironment } from '../drivers/cli-environment'

export const MCP_TIMEOUT_MS = 30_000

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

export interface McpClient {
  listTools(): Promise<McpTool[]>
  callTool(name: string, input: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
}

/**
 * Minimal JSON-over-stdio MCP client shared by the per-turn utility gateway
 * and long-lived services (e.g. the computer-use PiP monitor). One instance
 * owns one spawned child process.
 */
export class StdioMcpClient implements McpClient {
  private nextId = 1
  private buffer = ''
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk.toString()))
    child.on('exit', () => this.rejectPending(new Error('MCP process exited')))
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
        stdio: ['pipe', 'pipe', 'pipe']
      })
    )
    await client.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'codeinoven-utility-gateway', version: '1' }
    })
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
