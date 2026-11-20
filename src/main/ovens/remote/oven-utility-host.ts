/**
 * The utility host every Oven runs for itself.
 *
 * A remote turn runs on the Oven, so the app's loopback gateway is not
 * reachable from it: `127.0.0.1:<app port>` names the Oven's own loopback,
 * where nothing listens. This host is what listens there. It holds the turns a
 * client minted, answers the routes each turn was granted, and publishes the
 * port and credential in its data root for that client's relay to find.
 *
 * It is a thin composition root: the state file, the turn registry, the routes,
 * and the forwarding seam each own one concern in `oven-utility-host/`.
 *
 * Deliberately *not* here: MCP servers. Where a call is served on the Oven is
 * the `localRunner` seam; this host only decides who may call and how the answer
 * travels.
 */
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  OVEN_UTILITY_HOST_PROTOCOL,
  type OvenUtilityHostState
} from '../../../lib/oven-utility-host'
import {
  removeOvenUtilityHostState,
  writeOvenUtilityHostState
} from './oven-utility-host/oven-utility-host-state'
import { closeOvenUtilityServer } from './oven-utility-http'
import { createOvenUtilityHostListener } from './oven-utility-host/oven-utility-host-routes'
import { OvenUtilityTurns } from './oven-utility-host/oven-utility-host-turns'
import type { OvenUtilityLocalRunner } from './oven-utility-host/oven-utility-host-forward'

export type { OvenUtilityLocalRunner }

/** How often the registry sweeps turns left behind by a client that never came back. */
const PRUNE_INTERVAL_MS = 60_000

export interface StartOvenUtilityHostOptions {
  /** The Oven account's home; the state file lives under its app data root. */
  home: string
  /** Revision of the service bundle starting the host, reported to clients. */
  revision: string
  /**
   * Answers a granted route on the Oven itself.
   *
   * The seam the next phase's MCP servers plug into. Returning `undefined`
   * forwards the call to the turn's relay, which is what every route does today.
   */
  localRunner?: OvenUtilityLocalRunner
}

export interface OvenUtilityHostHandle {
  /** The loopback port the host is listening on. */
  port: number
  /** Retire every turn, stop listening, and withdraw the state file. Idempotent. */
  close(): Promise<void>
}

/**
 * Start one Oven's utility host on a free loopback port and publish it.
 *
 * The state file is written only after the listener is bound, so a client that
 * finds the file always finds a host that can answer on the port it names.
 */
export async function startOvenUtilityHost(
  options: StartOvenUtilityHostOptions
): Promise<OvenUtilityHostHandle> {
  const turns = new OvenUtilityTurns()
  const prune = setInterval(() => turns.pruneStale(), PRUNE_INTERVAL_MS)
  prune.unref()
  const hostToken = randomBytes(32).toString('hex')
  let port = 0
  const server = createServer(
    createOvenUtilityHostListener({
      port: () => port,
      revision: options.revision,
      hostToken,
      turns,
      ...(options.localRunner ? { localRunner: options.localRunner } : {})
    })
  )
  // One client, one relay, one host per Oven: a handful of sockets, never a horde.
  server.maxConnections = 64
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    clearInterval(prune)
    await closeOvenUtilityServer(server)
    throw new Error('The Oven utility host could not resolve its loopback port.')
  }
  port = (address as AddressInfo).port
  const state: OvenUtilityHostState = {
    protocolVersion: OVEN_UTILITY_HOST_PROTOCOL,
    revision: options.revision,
    port,
    hostToken,
    pid: process.pid,
    startedAt: Date.now()
  }
  try {
    await writeOvenUtilityHostState(options.home, state)
  } catch (error) {
    clearInterval(prune)
    await closeOvenUtilityServer(server)
    throw error
  }
  let closed = false
  return {
    port,
    close: async () => {
      if (closed) return
      closed = true
      clearInterval(prune)
      turns.retireAll()
      await closeOvenUtilityServer(server)
      await removeOvenUtilityHostState(options.home, hostToken)
    }
  }
}
