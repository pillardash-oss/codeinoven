/**
 * Remote-session state machine.
 *
 * Pure, typed reducer over the session snapshot (route + keep-alive phase +
 * peer reachability). This module is platform-safe and unit-tested directly;
 * `session-store.svelte.ts` wraps it in Svelte 5 reactivity.
 */

import type { PeerRef, RelayRef, RemoteRoute } from './routes'

/** Desktop keep-alive phase, shared with the tray controller. */
export type KeepAlivePhase =
  'IDLE' | 'KEEP_ALIVE_ARMED' | 'KEEP_ALIVE_ACTIVE' | 'REMOTE_SESSION_LIVE'

export interface SessionSnapshot {
  route: RemoteRoute
  keepAlive: KeepAlivePhase
  peerReachable: boolean
  lastError: string | null
  connectedAt: number | null
  peer: PeerRef | null
  relay: RelayRef | null
}

export type SessionAction =
  | { type: 'lanProbeStart' }
  | { type: 'lanConnected'; peer: PeerRef }
  | { type: 'relayProbeStart' }
  | { type: 'relayConnected'; relay: RelayRef }
  | { type: 'disconnected'; reason?: string }
  | { type: 'peerReachableChanged'; reachable: boolean }
  | { type: 'keepAliveChanged'; phase: KeepAlivePhase }
  | { type: 'error'; message: string }

export function initialSession(): SessionSnapshot {
  return {
    route: { kind: 'DISCONNECTED' },
    keepAlive: 'IDLE',
    peerReachable: false,
    lastError: null,
    connectedAt: null,
    peer: null,
    relay: null
  }
}

export function applySessionAction(prev: SessionSnapshot, action: SessionAction): SessionSnapshot {
  switch (action.type) {
    case 'lanProbeStart':
      return { ...prev, route: { kind: 'LAN_PROBE' }, lastError: null }
    case 'lanConnected':
      return {
        ...prev,
        route: { kind: 'LAN_CONNECTED', peer: action.peer },
        peer: action.peer,
        peerReachable: true,
        lastError: null,
        connectedAt: Date.now()
      }
    case 'relayProbeStart':
      return { ...prev, route: { kind: 'RELAY_PROBING' }, lastError: null }
    case 'relayConnected':
      return {
        ...prev,
        route: { kind: 'RELAY_CONNECTED', relay: action.relay },
        relay: action.relay,
        peerReachable: false,
        lastError: null,
        connectedAt: Date.now()
      }
    case 'disconnected':
      return {
        ...prev,
        route: action.reason
          ? { kind: 'DISCONNECTED', reason: action.reason }
          : { kind: 'DISCONNECTED' },
        peerReachable: false,
        connectedAt: null
      }
    case 'peerReachableChanged':
      return { ...prev, peerReachable: action.reachable }
    case 'keepAliveChanged':
      return { ...prev, keepAlive: action.phase }
    case 'error':
      return { ...prev, lastError: action.message }
  }
}

/** Status label used by the phone client UI. */
export function sessionStatusLabel(snapshot: SessionSnapshot): string {
  switch (snapshot.route.kind) {
    case 'LAN_PROBE':
      return 'Searching local network…'
    case 'LAN_CONNECTED':
      return 'Connected over local network'
    case 'RELAY_PROBING':
      return 'Connecting through cloud relay…'
    case 'RELAY_CONNECTED':
      return 'Connected through cloud relay'
    case 'DISCONNECTED':
      return snapshot.route.reason ? `Disconnected — ${snapshot.route.reason}` : 'Disconnected'
  }
}
