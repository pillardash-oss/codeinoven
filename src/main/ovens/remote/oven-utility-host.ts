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
 * the `local` executor's job; this host only decides who may call, how the answer
 * travels, and when a turn's local machinery is closed.
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
import { OvenUtilitySecrets } from './oven-utility-host/oven-utility-secrets'
import type {
  OvenUtilityLocalRunner,
  OvenUtilityLocalHost
} from './oven-utility-host/oven-utility-host-forward'

export type { OvenUtilityLocalRunner, OvenUtilityLocalHost }

/** How often the registry sweeps turns left behind by a client that never came back. */
const PRUNE_INTERVAL_MS = 60_000

export interface StartOvenUtilityHostOptions {
  /** The Oven account's home; the state file lives under its app data root. */
  home: string
  /** Revision of the service bundle starting the host, reported to clients. */
  revision: string
  /**
   * Answers granted routes on the Oven itself.
   *
   * Returning `undefined` from `run` forwards the call to the turn's relay, which
   * is what every app-owned route needs. The host tells this executor whenever a
   * turn ends and once more when it closes, so nothing a local execution started
   * (an MCP server child above all) outlives the capability that started it.
   */
  local?: OvenUtilityLocalHost
  /**
   * This machine's at-rest credential store.
   *
   * The host owns one when its caller does not hand one in. The caller passes
   * the same instance to its local executor, so a secret written through a route
   * is the one the next turn's servers run with, and a forgotten one is gone.
   */
  secrets?: OvenUtilitySecrets
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
  const local = options.local
  // Every path that ends a turn ends here, so this is the one place local work is
  // torn down: a replaced turn, a retired one, an idle one, and the host's own
  // close all pass through it.
  const turns = new OvenUtilityTurns((turnId) => {
    void local?.retireTurn(turnId)
  })
  const prune = setInterval(() => turns.pruneStale(), PRUNE_INTERVAL_MS)
  prune.unref()
  const hostToken = randomBytes(32).toString('hex')
  const secrets = options.secrets ?? new OvenUtilitySecrets({ home: options.home })
  let port = 0
  const server = createServer(
    createOvenUtilityHostListener({
      port: () => port,
      revision: options.revision,
      hostToken,
      turns,
      secrets,
      ...(local ? { localRunner: local.run } : {})
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
      await local?.close()
      await removeOvenUtilityHostState(options.home, hostToken)
    }
  }
}
