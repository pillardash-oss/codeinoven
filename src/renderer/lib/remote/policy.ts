/**
 * Route-policy decision logic.
 *
 * Reusable LAN-over-relay ordering shared by the client and the integration
 * tests: LAN is always preferred while a reachable peer exists; the cloud
 * relay is only probed/used when LAN discovery found no reachable peer.
 */

import { type CandidatePeer, type RemoteRoute, disconnectedRoute } from './routes'

export interface RouteDecisionState {
  /** Reachable LAN peers from discovery, ordered by preference. */
  lanPeers: readonly CandidatePeer[]
  /** Whether the relay is enabled and configured (env-provided). */
  relayAvailable: boolean
  /** Whether the relay handshake has established a data channel. */
  relayEstablished: boolean
  /** The relay URL used for the established channel. */
  relayUrl: string | null
}

/** True when LAN is available and should win over the relay. */
export function lanPreferred(state: RouteDecisionState): boolean {
  return state.lanPeers.length > 0
}

/** True when the relay should be probed because no LAN peer is reachable. */
export function shouldProbeRelay(state: RouteDecisionState): boolean {
  return state.lanPeers.length === 0 && state.relayAvailable
}

/**
 * Resolve the active route from discovery and relay state. A reachable LAN
 * peer always wins over the relay; the relay only enters when LAN is
 * unavailable, and it is reported `RELAY_CONNECTED` once established.
 */
export function resolveRoute(state: RouteDecisionState): RemoteRoute {
  const peer = state.lanPeers[0]
  if (peer) {
    return { kind: 'LAN_CONNECTED', peer: { host: peer.host, port: peer.port } }
  }
  if (state.relayAvailable) {
    if (state.relayEstablished && state.relayUrl) {
      return { kind: 'RELAY_CONNECTED', relay: { url: state.relayUrl } }
    }
    return { kind: 'RELAY_PROBING' }
  }
  return disconnectedRoute('no-lan-peer')
}
