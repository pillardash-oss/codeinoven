/**
 * Reactive remote-session store.
 *
 * Wraps the pure `session-state.ts` reducer in Svelte 5 reactivity and wires
 * the shared connection modules (config, discovery, transport, relay) into an
 * end-to-end connect flow: LAN first, relay fallback. The reducer itself is
 * unit-tested via `session-state` (see `session-store.test.ts`).
 */

import {
  applySessionAction,
  initialSession,
  type KeepAlivePhase,
  type SessionAction,
  type SessionSnapshot
} from './session-state'
import { loadRemoteConfig } from './config'
import { discoverPeers } from './discovery'
import { createLanTransport, type LanTransport } from './transport'
import { createRelayClient, type RelayClient } from './relay'
import { remoteLog } from './logger'

const LAN_HANDSHAKE_TIMEOUT_MS = 3_000
const RELAY_HANDSHAKE_TIMEOUT_MS = 3_000

export class RemoteSessionStore {
  snapshot = $state<SessionSnapshot>(initialSession())

  private secret = ''
  private lanTransport: LanTransport | null = null
  private relayClient: RelayClient | null = null

  dispatch(action: SessionAction): void {
    this.snapshot = applySessionAction(this.snapshot, action)
  }

  /** Connect through the shared modules: LAN first, relay fallback. */
  async connect(secret: string): Promise<void> {
    this.secret = secret
    const config = loadRemoteConfig()
    this.dispatch({ type: 'lanProbeStart' })

    const peers = await discoverPeers({
      port: config.lan.port,
      manualHosts: config.lan.hosts,
      useMdns: config.lan.useMdns,
      timeoutMs: 0,
      reachable: async (peer) => {
        const probe = createLanTransport({
          peer,
          authSecret: secret,
          handshakeTimeoutMs: LAN_HANDSHAKE_TIMEOUT_MS,
          onEvent: () => undefined
        })
        const outcome = await probe.connect()
        if (outcome === 'open') {
          this.lanTransport = probe
          return true
        }
        return false
      }
    })

    const peer = peers[0]
    if (peer) {
      remoteLog.info(`Remote session connected over LAN to ${peer.host}:${peer.port}`)
      this.dispatch({ type: 'lanConnected', peer: { host: peer.host, port: peer.port } })
      this.dispatch({ type: 'peerReachableChanged', reachable: true })
      return
    }

    if (!config.relay.enabled) {
      this.dispatch({ type: 'disconnected', reason: 'no-lan-peer' })
      return
    }

    this.dispatch({ type: 'relayProbeStart' })
    const relayClient = createRelayClient({
      url: config.relay.url,
      token: config.relay.token,
      authSecret: secret,
      mqtt: config.relay.mqtt,
      handshakeTimeoutMs: RELAY_HANDSHAKE_TIMEOUT_MS,
      onEvent: (event) => {
        if (event.kind === 'handshake:ok') {
          remoteLog.info('Remote session connected through the cloud relay')
        }
      }
    })
    this.relayClient = relayClient
    const outcome = await relayClient.connect()
    if (outcome === 'open') {
      this.dispatch({ type: 'relayConnected', relay: { url: config.relay.url } })
    } else if (outcome === 'rejected') {
      this.dispatch({ type: 'disconnected', reason: 'relay-auth-failed' })
    } else {
      this.dispatch({ type: 'disconnected', reason: 'unreachable' })
    }
  }

  /** Tear down any open channel and return to DISCONNECTED. */
  disconnect(): void {
    this.lanTransport?.close()
    this.lanTransport = null
    this.relayClient?.close()
    this.relayClient = null
    this.dispatch({ type: 'disconnected' })
  }

  /** Update the desktop keep-alive phase surfaced to the phone client. */
  setKeepAlive(phase: KeepAlivePhase): void {
    this.dispatch({ type: 'keepAliveChanged', phase })
  }

  get secretValue(): string {
    return this.secret
  }
}

export const remoteSession = new RemoteSessionStore()
