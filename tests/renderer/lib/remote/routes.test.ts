import { describe, expect, it } from 'vitest'
import {
  describeRoute,
  disconnectedRoute,
  initialRoute,
  isLanRoute,
  isRouteConnected,
  routeKind,
  routeTone
} from '../../../../src/renderer/lib/remote/routes'

describe('remote routes', () => {
  it('starts disconnected', () => {
    expect(initialRoute()).toEqual({ kind: 'DISCONNECTED' })
  })

  it('tracks the route kind via the discriminated union', () => {
    expect(routeKind({ kind: 'LAN_PROBE' })).toBe('LAN_PROBE')
    expect(routeKind({ kind: 'RELAY_CONNECTED', relay: { url: 'wss://relay.test' } })).toBe(
      'RELAY_CONNECTED'
    )
  })

  it('detects connected routes for both LAN and relay', () => {
    expect(
      isRouteConnected({ kind: 'LAN_CONNECTED', peer: { host: 'localhost', port: 4455 } })
    ).toBe(true)
    expect(isRouteConnected({ kind: 'RELAY_CONNECTED', relay: { url: 'wss://relay.test' } })).toBe(
      true
    )
    expect(isRouteConnected(initialRoute())).toBe(false)
    expect(isRouteConnected({ kind: 'LAN_PROBE' })).toBe(false)
    expect(isRouteConnected({ kind: 'RELAY_PROBING' })).toBe(false)
  })

  it('identifies LAN routes as the preferred family', () => {
    expect(isLanRoute({ kind: 'LAN_PROBE' })).toBe(true)
    expect(isLanRoute({ kind: 'LAN_CONNECTED', peer: { host: 'localhost', port: 4455 } })).toBe(
      true
    )
    expect(isLanRoute({ kind: 'RELAY_CONNECTED', relay: { url: 'wss://relay.test' } })).toBe(false)
  })

  it('builds disconnected routes with an optional reason', () => {
    expect(disconnectedRoute()).toEqual({ kind: 'DISCONNECTED' })
    expect(disconnectedRoute('no-lan-peer')).toEqual({
      kind: 'DISCONNECTED',
      reason: 'no-lan-peer'
    })
  })

  it('describes every route kind for the status UI', () => {
    expect(describeRoute({ kind: 'LAN_PROBE' })).toContain('local network')
    expect(
      describeRoute({ kind: 'LAN_CONNECTED', peer: { host: 'localhost', port: 4455 } })
    ).toContain('local network')
    expect(describeRoute({ kind: 'RELAY_PROBING' })).toContain('cloud relay')
    expect(
      describeRoute({ kind: 'RELAY_CONNECTED', relay: { url: 'wss://relay.test' } })
    ).toContain('cloud relay')
    expect(describeRoute(disconnectedRoute('boom'))).toContain('boom')
  })

  it('maps route kinds to theme tokens', () => {
    expect(routeTone({ kind: 'LAN_CONNECTED', peer: { host: 'localhost', port: 4455 } })).toBe(
      'success'
    )
    expect(routeTone({ kind: 'RELAY_CONNECTED', relay: { url: 'wss://relay.test' } })).toBe(
      'warning'
    )
    expect(routeTone({ kind: 'LAN_PROBE' })).toBe('info')
    expect(routeTone({ kind: 'RELAY_PROBING' })).toBe('info')
    expect(routeTone(initialRoute())).toBe('danger')
  })
})
