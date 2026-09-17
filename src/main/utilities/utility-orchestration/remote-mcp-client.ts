import { MCP_TIMEOUT_MS } from '../../agents/mcp-stdio-client'
import type { JsonRpcResponse, McpClient, McpTool } from '../../agents/mcp-stdio-client'
import { isRecord, recordValue } from './utility-input'

export class RemoteMcpClient implements McpClient {
  private nextId = 1
  private sessionId: string | undefined

  private constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>
  ) {}

  static async connect(url: string, headers: Record<string, string>): Promise<RemoteMcpClient> {
    const client = new RemoteMcpClient(url, headers)
    await client.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'codeinoven-utility-gateway', version: '1' }
    })
    await client.notify('notifications/initialized', {})
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
    if (this.sessionId) {
      await fetch(this.url, {
        method: 'DELETE',
        headers: { ...this.headers, 'Mcp-Session-Id': this.sessionId }
      }).catch(() => undefined)
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.send({ jsonrpc: '2.0', id: this.nextId++, method, params }, true)
  }

  private notify(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.send({ jsonrpc: '2.0', method, params }, false)
  }

  private async send(payload: Record<string, unknown>, expectsResult: boolean): Promise<unknown> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        ...this.headers,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {})
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS)
    })
    if (!response.ok) throw new Error(`Remote MCP request failed (${response.status})`)
    this.sessionId ??= response.headers.get('mcp-session-id') ?? undefined
    if (!expectsResult || response.status === 202) return undefined
    const contentType = response.headers.get('content-type') ?? ''
    const text = await response.text()
    const raw = contentType.includes('text/event-stream')
      ? text
          .split('\n')
          .find((line) => line.startsWith('data:'))
          ?.slice(5)
          .trim()
      : text
    if (!raw) throw new Error('Remote MCP returned no result')
    const result = JSON.parse(raw) as JsonRpcResponse
    if (result.error) throw new Error(result.error.message)
    return result.result
  }
}
