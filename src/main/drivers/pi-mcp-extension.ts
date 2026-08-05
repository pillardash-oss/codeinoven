interface PiMcpServerConfig {
  command: string
  args: string[]
  env: Record<string, string>
}

/**
 * Build an ephemeral Pi extension that supplies a small MCP client surface.
 * Pi intentionally has no native MCP host, so this adapter keeps the bridge
 * app-owned and avoids writing an extension into the user's project or home.
 */
export function piMcpExtension(servers: Record<string, PiMcpServerConfig>): string {
  const serialized = JSON.stringify(servers)
  return `import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

interface ServerConfig {
  command: string
  args: string[]
  env: Record<string, string>
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
}

interface RpcRecord {
  id?: number
  result?: unknown
  error?: { message?: string }
}

type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

const servers: Record<string, ServerConfig> = ${serialized}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function jsonText(value: unknown): string {
  return JSON.stringify(value) ?? String(value)
}

function contentFrom(value: unknown): ToolContent[] {
  const result = record(value)
  const content = result?.content
  if (!Array.isArray(content)) {
    return [{ type: 'text', text: jsonText(value) }]
  }
  const normalized: ToolContent[] = []
  for (const item of content) {
    const entry = record(item)
    if (entry?.type === 'text' && typeof entry.text === 'string') {
      normalized.push({ type: 'text', text: entry.text })
    } else if (
      entry?.type === 'image' &&
      typeof entry.data === 'string' &&
      typeof entry.mimeType === 'string'
    ) {
      normalized.push({ type: 'image', data: entry.data, mimeType: entry.mimeType })
    }
  }
  return normalized.length > 0
    ? normalized
    : [{ type: 'text', text: jsonText(value) }]
}

class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private starting: Promise<void> | null = null

  constructor(private readonly config: ServerConfig) {}

  async listTools(): Promise<unknown> {
    await this.start()
    return this.request('tools/list', {})
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    await this.start()
    return this.request('tools/call', { name, arguments: input })
  }

  close(): void {
    this.child?.kill()
    this.child = null
    this.rejectPending(new Error('MCP server closed'))
  }

  private async start(): Promise<void> {
    if (this.child) return
    this.starting ??= this.startProcess()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private async startProcess(): Promise<void> {
    const child = spawn(this.config.command, this.config.args, {
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    child.stderr.resume()
    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk.toString()))
    child.on('error', (error) => this.rejectPending(error))
    child.on('exit', () => {
      if (this.child === child) this.child = null
      this.rejectPending(new Error('MCP server exited'))
    })
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'codeinoven-pi-bridge', version: '1.0.0' }
    })
    this.notify('notifications/initialized', {})
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.child
    if (!child) return Promise.reject(new Error('MCP server is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new Error('MCP request timed out'))
      }, 30_000)
      this.pending.set(id, {
        resolve(value) {
          clearTimeout(timeout)
          resolve(value)
        },
        reject(error) {
          clearTimeout(timeout)
          reject(error)
        }
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n')
    })
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\\n')
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split(/\\r?\\n/u)
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let response: RpcRecord
      try {
        response = JSON.parse(line) as RpcRecord
      } catch {
        continue
      }
      if (typeof response.id !== 'number') continue
      const pending = this.pending.get(response.id)
      if (!pending) continue
      this.pending.delete(response.id)
      if (response.error) pending.reject(new Error(response.error.message ?? 'MCP request failed'))
      else pending.resolve(response.result)
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

export default function codeInOvenMcpExtension(pi: ExtensionAPI): void {
  const clients = new Map(
    Object.entries(servers).map(([name, config]) => [name, new McpClient(config)])
  )

  pi.registerTool({
    name: 'codeinoven_mcp_list_tools',
    label: 'CodeInOven MCP tools',
    description: 'List tools exposed by a turn-scoped MCP server connected by CodeInOven.',
    parameters: Type.Object({
      server: Type.String({ description: 'Server name supplied by CodeInOven.' })
    }),
    promptSnippet: 'List tools from a CodeInOven MCP bridge.',
    promptGuidelines: [
      'Use codeinoven_mcp_list_tools to discover a connected server before calling one of its tools.'
    ],
    async execute(_toolCallId, params) {
      const client = clients.get(params.server)
      if (!client) throw new Error('Unknown CodeInOven MCP server: ' + params.server)
      const result = await client.listTools()
      return { content: [{ type: 'text', text: jsonText(result) }], details: {} }
    }
  })

  pi.registerTool({
    name: 'codeinoven_mcp_call',
    label: 'Call CodeInOven MCP tool',
    description: 'Call one tool on a turn-scoped MCP server connected by CodeInOven.',
    parameters: Type.Object({
      server: Type.String({ description: 'Server name supplied by CodeInOven.' }),
      tool: Type.String({ description: 'Exact MCP tool name returned by the list operation.' }),
      input: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
    }),
    promptSnippet: 'Call a discovered tool from a CodeInOven MCP bridge.',
    promptGuidelines: [
      'Use codeinoven_mcp_call only with an exact tool name returned by codeinoven_mcp_list_tools.'
    ],
    async execute(_toolCallId, params) {
      const client = clients.get(params.server)
      if (!client) throw new Error('Unknown CodeInOven MCP server: ' + params.server)
      const result = await client.callTool(params.tool, params.input ?? {})
      return { content: contentFrom(result), details: { server: params.server, tool: params.tool } }
    }
  })

  pi.on('session_shutdown', async () => {
    for (const client of clients.values()) client.close()
  })
}
`
}
