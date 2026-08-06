import { describe, expect, it } from 'vitest'
import { lanPreferred, resolveRoute, shouldProbeRelay, type RouteDecisionState } from './policy'

function state(overrides: Partial<RouteDecisionState>): RouteDecisionState {
  return {
    lanPeers: [],
    relayAvailable: true,
    relayEstablished: false,
    relayUrl: null,
    ...overrides
  }
}

describe('resolveRoute', () => {
  it('wins LAN over an established relay when a LAN peer is reachable', () => {
    const route = resolveRoute(
      state({
        lanPeers: [{ host: '192.168.1.5', port: 4455 }],
        relayEstablished: true,
        relayUrl: 'wss://relay.example.test'
      })
    )

    expect(route).toEqual({
      kind: 'LAN_CONNECTED',
      peer: { host: '192.168.1.5', port: 4455 }
    })
  })

  it('reports RELAY_PROBING when LAN is unreachable and the relay is available', () => {
    const route = resolveRoute(state({ lanPeers: [] }))
    expect(route).toEqual({ kind: 'RELAY_PROBING' })
  })

  it('reports RELAY_CONNECTED once the relay handshake establishes', () => {
    const route = resolveRoute(
      state({ relayEstablished: true, relayUrl: 'wss://relay.example.test' })
    )
    expect(route).toEqual({
      kind: 'RELAY_CONNECTED',
      relay: { url: 'wss://relay.example.test' }
    })
  })

  it('disconnects when no LAN peer exists and the relay is unavailable', () => {
    const route = resolveRoute(state({ relayAvailable: false }))
    expect(route).toEqual({ kind: 'DISCONNECTED', reason: 'no-lan-peer' })
  })
})

describe('lanPreferred / shouldProbeRelay', () => {
  it('prefers LAN whenever a peer exists', () => {
    expect(lanPreferred(state({ lanPeers: [{ host: 'a', port: 4455 }] }))).toBe(true)
    expect(lanPreferred(state({ lanPeers: [] }))).toBe(false)
  })

  it('probes the relay only when LAN is empty and the relay is available', () => {
    expect(shouldProbeRelay(state({ lanPeers: [], relayAvailable: true }))).toBe(true)
    expect(shouldProbeRelay(state({ lanPeers: [], relayAvailable: false }))).toBe(false)
    expect(
      shouldProbeRelay(state({ lanPeers: [{ host: 'a', port: 4455 }], relayAvailable: true }))
    ).toBe(false)
  })
})
