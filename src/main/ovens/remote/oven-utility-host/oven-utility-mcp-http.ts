/**
 * A remote MCP server (`http` or `sse`), reached from the Oven over loopback or
 * a network the Oven itself is allowed to use.
 *
 * Ported from the app's `RemoteMcpClient`: streamable-HTTP JSON-RPC, the session
 * id the server hands back on its first answer, and a `text/event-stream` reply
 * unwrapped from its single `data:` frame. What it does not carry is the app's
 * OAuth handling and its task-manager row; a bearer this server needs is not part
 * of a turn's snapshot (see the report's contract gaps), so a refusal here is a
 * transport failure and the call goes back to the app that can authenticate it.
 */
import type { OvenUtilityMcpServer } from '../../../../lib/oven-utility-host'
import {
  OVEN_MCP_CALL_TIMEOUT_MS,
  OVEN_MCP_CONNECT_TIMEOUT_MS,
  OvenUtilityMcpUnavailableError,
  OvenUtilityToolError,
  isRecord,
  ovenMcpRefusalMessage,
  ovenUtilityMcpHeaders,
  parseOvenMcpTools,
  type OvenMcpJsonRpcResponse,
  type OvenMcpTool,
  type OvenUtilityMcpClient
} from './oven-utility-mcp'

/** How long a session teardown may hold a retiring turn open. */
const CLOSE_TIMEOUT_MS = 5_000

/** One remote MCP connection: one URL, one session. */
export class OvenHttpMcpClient implements OvenUtilityMcpClient {
  private nextId = 1
  private sessionId: string | undefined
  /** Cleared the moment this session can no longer be trusted. */
  private retired = false

  private constructor(
    private readonly url: string,
    /** Headers the client resolved for this server, sent with every request. */
    private readonly configured: Record<string, string>
  ) {}

  get usable(): boolean {
    return !this.retired
  }

  static async connect(server: OvenUtilityMcpServer): Promise<OvenHttpMcpClient> {
    const url = server.url
    if (!url)
      throw new OvenUtilityMcpUnavailableError(
        `Utility \`${server.utilityId}\` has no MCP url to reach from this Oven.`
      )
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new OvenUtilityMcpUnavailableError(
        `Utility \`${server.utilityId}\` has an MCP url this Oven cannot parse.`
      )
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      throw new OvenUtilityMcpUnavailableError(
        `Utility \`${server.utilityId}\` has an MCP url this Oven cannot reach (${parsed.protocol}).`
      )
    const client = new OvenHttpMcpClient(url, ovenUtilityMcpHeaders(server))
    await client.request(
      'initialize',
      {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'codeinoven-oven-utility-host', version: '1' }
      },
      OVEN_MCP_CONNECT_TIMEOUT_MS
    )
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, false)
    return client
  }

  async listTools(): Promise<OvenMcpTool[]> {
    return parseOvenMcpTools(await this.request('tools/list', {}, OVEN_MCP_CALL_TIMEOUT_MS))
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    return await this.request('tools/call', { name, arguments: input }, OVEN_MCP_CALL_TIMEOUT_MS)
  }

  async close(): Promise<void> {
    if (this.retired) return
    this.retired = true
    if (!this.sessionId) return
    // Bounded like every other request this client makes: a server that never
    // answers the DELETE must not hold a retiring turn open.
    await fetch(this.url, {
      method: 'DELETE',
      headers: this.headers(),
      signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS)
    }).catch(() => undefined)
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    budgetMs: number
  ): Promise<unknown> {
    if (this.retired)
      throw new OvenUtilityMcpUnavailableError(
        `MCP request refused on a closed connection \`${this.url}\`: ${method}.`
      )
    try {
      return await this.send({ jsonrpc: '2.0', id: this.nextId++, method, params }, true, budgetMs)
    } catch (error) {
      // A streamable-HTTP session cannot be resumed mid-call, so a call that ran
      // out of its budget retires this connection instead of queueing the next
      // one behind work that is still running server-side.
      if (error instanceof Error && error.name === 'TimeoutError') this.retired = true
      throw error
    }
  }

  private async send(
    payload: Record<string, unknown>,
    expectsResult: boolean,
    budgetMs = OVEN_MCP_CALL_TIMEOUT_MS
  ): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: {
          ...this.headers(),
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(budgetMs)
      })
    } catch (error) {
      throw new OvenUtilityMcpUnavailableError(
        `MCP server \`${this.url}\` could not be reached: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      )
    }
    if (!response.ok) {
      throw new OvenUtilityMcpUnavailableError(
        `MCP server \`${this.url}\` refused the connection (HTTP ${response.status}).`
      )
    }
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
    if (!raw)
      throw new OvenUtilityMcpUnavailableError(`MCP server \`${this.url}\` returned no result.`)
    let answer: unknown
    try {
      answer = JSON.parse(raw)
    } catch (error) {
      throw new OvenUtilityMcpUnavailableError(
        `MCP server \`${this.url}\` returned a body this Oven cannot read.`,
        { cause: error }
      )
    }
    if (!isRecord(answer))
      throw new OvenUtilityMcpUnavailableError(`MCP server \`${this.url}\` returned no result.`)
    const result = answer as OvenMcpJsonRpcResponse
    if (result.error) throw new OvenUtilityToolError(ovenMcpRefusalMessage(result.error))
    return result.result
  }

  private headers(): Record<string, string> {
    return {
      ...this.configured,
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {})
    }
  }
}
