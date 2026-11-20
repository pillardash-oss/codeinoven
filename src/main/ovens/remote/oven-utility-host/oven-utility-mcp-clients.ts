/**
 * The MCP connections one turn holds on this Oven.
 *
 * Two rules live here, both learned from the app's client:
 *
 * 1. A transport is chosen from the turn's snapshot alone, and a transport this
 *    Oven cannot run is a plain "unavailable" rather than a crash: the host then
 *    forwards the call to the app, which may be able to reach it.
 * 2. One utility opens one connection, however many calls ask for it at once.
 *    Activation, docs and invocation can all arrive before the handshake
 *    finished, and a second `initialize` on the same server would start a second
 *    process for a server the turn only needs once.
 */
import type { OvenUtilityMcpServer } from '../../../../lib/oven-utility-host'
import {
  OvenUtilityMcpUnavailableError,
  ovenUtilityMcpTarget,
  type OvenUtilityMcpClient
} from './oven-utility-mcp'
import { OvenStdioMcpClient } from './oven-utility-mcp-stdio'
import { OvenHttpMcpClient } from './oven-utility-mcp-http'

/** Open one connection to the transport a turn's server snapshot names. */
export async function openOvenUtilityMcpServer(
  server: OvenUtilityMcpServer
): Promise<OvenUtilityMcpClient> {
  switch (server.transport) {
    case 'stdio':
      return await OvenStdioMcpClient.connect(server)
    case 'http':
    case 'sse':
      return await OvenHttpMcpClient.connect(server)
    default:
      // A turn is JSON from another process, so a transport this build does not
      // know is possible even though the contract's union has no room for it.
      throw new OvenUtilityMcpUnavailableError(
        `Utility \`${server.utilityId}\` asks for an MCP transport this Oven cannot run (${String(
          server.transport
        )}: ${ovenUtilityMcpTarget(server)}).`
      )
  }
}

/** The live MCP connections of one turn, keyed by utility id. */
export class OvenUtilityMcpClients {
  private readonly clients = new Map<string, OvenUtilityMcpClient>()
  /** The handshake in flight per utility, so concurrent callers share one child. */
  private readonly connecting = new Map<string, Promise<OvenUtilityMcpClient>>()

  /**
   * The connection for one utility, opening it only when none can answer.
   *
   * A connection that is no longer usable is never handed out again: a stdio
   * server that stopped answering has already run out of its budget, and its
   * abandoned work waits inside the child, so the replacement is a new one.
   */
  async open(server: OvenUtilityMcpServer): Promise<OvenUtilityMcpClient> {
    const existing = this.clients.get(server.utilityId)
    if (existing?.usable) return existing
    if (existing) {
      this.clients.delete(server.utilityId)
      void existing.close()
    }
    const inFlight = this.connecting.get(server.utilityId)
    if (inFlight) return await inFlight
    const connecting = openOvenUtilityMcpServer(server)
    this.connecting.set(server.utilityId, connecting)
    try {
      const client = await connecting
      this.clients.set(server.utilityId, client)
      return client
    } finally {
      if (this.connecting.get(server.utilityId) === connecting)
        this.connecting.delete(server.utilityId)
    }
  }

  /** Close every connection this turn opened, and everything still opening. */
  async closeAll(): Promise<void> {
    const opening = [...this.connecting.values()]
    const open = [...this.clients.values()]
    this.connecting.clear()
    this.clients.clear()
    await Promise.allSettled([
      ...open.map(async (client) => await client.close()),
      ...opening.map(async (pending) => {
        const client = await pending.catch(() => null)
        await client?.close()
      })
    ])
  }
}
