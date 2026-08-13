import { describe, expect, it } from 'vitest'
import {
  applySessionAction,
  initialSession,
  sessionStatusLabel,
  type SessionSnapshot
} from './session-state'

const LAN_PEER = { host: '192.168.1.5', port: 4455 }
const RELAY = { url: 'wss://relay.example.test' }

describe('remote session state transitions', () => {
  it('starts disconnected with idle keep-alive', () => {
    const snapshot = initialSession()
    expect(snapshot.route).toEqual({ kind: 'DISCONNECTED' })
    expect(snapshot.keepAlive).toBe('IDLE')
    expect(snapshot.peerReachable).toBe(false)
    expect(snapshot.peer).toBeNull()
  })

  it('moves DISCONNECTED -> LAN_PROBE -> LAN_CONNECTED', () => {
    let snapshot = initialSession()
    snapshot = applySessionAction(snapshot, { type: 'lanProbeStart' })
    expect(snapshot.route.kind).toBe('LAN_PROBE')

    snapshot = applySessionAction(snapshot, { type: 'lanConnected', peer: LAN_PEER })
    expect(snapshot.route).toEqual({ kind: 'LAN_CONNECTED', peer: LAN_PEER })
    expect(snapshot.peer).toEqual(LAN_PEER)
    expect(snapshot.peerReachable).toBe(true)
    expect(snapshot.connectedAt).not.toBeNull()
    expect(snapshot.lastError).toBeNull()
  })

  it('moves LAN_PROBE -> RELAY_PROBING -> RELAY_CONNECTED', () => {
    let snapshot = initialSession()
    snapshot = applySessionAction(snapshot, { type: 'lanProbeStart' })
    snapshot = applySessionAction(snapshot, { type: 'relayProbeStart' })
    expect(snapshot.route.kind).toBe('RELAY_PROBING')

    snapshot = applySessionAction(snapshot, { type: 'relayConnected', relay: RELAY })
    expect(snapshot.route).toEqual({ kind: 'RELAY_CONNECTED', relay: RELAY })
    expect(snapshot.relay).toEqual(RELAY)
    expect(snapshot.peerReachable).toBe(false)
    expect(snapshot.connectedAt).not.toBeNull()
  })

  it('returns to DISCONNECTED with a reason on failure', () => {
    let snapshot = initialSession()
    snapshot = applySessionAction(snapshot, { type: 'lanProbeStart' })
    snapshot = applySessionAction(snapshot, { type: 'disconnected', reason: 'auth-failed' })

    expect(snapshot.route).toEqual({ kind: 'DISCONNECTED', reason: 'auth-failed' })
    expect(snapshot.peerReachable).toBe(false)
    expect(snapshot.connectedAt).toBeNull()
  })

  it('tracks peer reachability independently of the route', () => {
    let snapshot = initialSession()
    snapshot = applySessionAction(snapshot, { type: 'peerReachableChanged', reachable: true })
    expect(snapshot.peerReachable).toBe(true)
  })

  it('tracks the desktop keep-alive phase', () => {
    let snapshot = initialSession()
    snapshot = applySessionAction(snapshot, {
      type: 'keepAliveChanged',
      phase: 'REMOTE_SESSION_LIVE'
    })
    expect(snapshot.keepAlive).toBe('REMOTE_SESSION_LIVE')
  })

  it('records errors without changing the route', () => {
    const before = applySessionAction(initialSession(), { type: 'lanProbeStart' })
    const after = applySessionAction(before, { type: 'error', message: 'handshake timeout' })
    expect(after.lastError).toBe('handshake timeout')
    expect(after.route).toEqual(before.route)
  })

  it('keeps previous fields when applying an unrelated transition', () => {
    let snapshot = initialSession()
    snapshot = applySessionAction(snapshot, { type: 'lanConnected', peer: LAN_PEER })
    snapshot = applySessionAction(snapshot, { type: 'keepAliveChanged', phase: 'KEEP_ALIVE_ARMED' })
    expect(snapshot.peer).toEqual(LAN_PEER)
    expect(snapshot.route.kind).toBe('LAN_CONNECTED')
  })
})

describe('sessionStatusLabel', () => {
  it('describes every route state for the UI', () => {
    const label = (snapshot: SessionSnapshot): string => sessionStatusLabel(snapshot)
    expect(label(initialSession())).toContain('Disconnected')
    expect(label(applySessionAction(initialSession(), { type: 'lanProbeStart' }))).toContain(
      'local network'
    )
    expect(
      label(applySessionAction(initialSession(), { type: 'lanConnected', peer: LAN_PEER }))
    ).toContain('local network')
    expect(
      label(applySessionAction(initialSession(), { type: 'relayConnected', relay: RELAY }))
    ).toContain('cloud relay')
  })
})
