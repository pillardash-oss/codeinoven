/**
 * Remote route policy — the discriminated route union and LAN-first helpers.
 *
 * LAN routes are always preferred when a local peer is reachable; the cloud
 * relay is only attempted when LAN discovery found no reachable peer. This
 * module is platform-safe (no SvelteKit imports) so it can be unit-tested on
 * its own.
 */

export interface PeerRef {
  host: string
  port: number
}

export interface RelayRef {
  url: string
}

export type RemoteRoute =
  | { kind: 'LAN_PROBE' }
  | { kind: 'LAN_CONNECTED'; peer: PeerRef }
  | { kind: 'RELAY_PROBING' }
  | { kind: 'RELAY_CONNECTED'; relay: RelayRef }
  | { kind: 'DISCONNECTED'; reason?: string }

export type RemoteRouteKind = RemoteRoute['kind']

/** The route the app starts from before any connectivity work happens. */
export function initialRoute(): RemoteRoute {
  return { kind: 'DISCONNECTED' }
}

export function routeKind(route: RemoteRoute): RemoteRouteKind {
  return route.kind
}

export function isRouteConnected(route: RemoteRoute): boolean {
  return route.kind === 'LAN_CONNECTED' || route.kind === 'RELAY_CONNECTED'
}

/** True only for routes that are actually on the local network. */
export function isLanRoute(route: RemoteRoute): boolean {
  return route.kind === 'LAN_PROBE' || route.kind === 'LAN_CONNECTED'
}

export function disconnectedRoute(reason?: string): RemoteRoute {
  return { kind: 'DISCONNECTED', reason }
}

/** A short human-readable label for the route, safe for the status UI. */
export function describeRoute(route: RemoteRoute): string {
  switch (route.kind) {
    case 'LAN_PROBE':
      return 'Searching local network…'
    case 'LAN_CONNECTED':
      return 'Connected over local network'
    case 'RELAY_PROBING':
      return 'Connecting through cloud relay…'
    case 'RELAY_CONNECTED':
      return 'Connected through cloud relay'
    case 'DISCONNECTED':
      return route.reason ? `Disconnected — ${route.reason}` : 'Disconnected'
  }
}

/** Route color key used by the status UI (tokenized, theme-aware). */
export function routeTone(route: RemoteRoute): 'info' | 'success' | 'warning' | 'muted' | 'danger' {
  switch (route.kind) {
    case 'LAN_CONNECTED':
      return 'success'
    case 'RELAY_CONNECTED':
      return 'warning'
    case 'LAN_PROBE':
    case 'RELAY_PROBING':
      return 'info'
    case 'DISCONNECTED':
      return 'danger'
  }
}
