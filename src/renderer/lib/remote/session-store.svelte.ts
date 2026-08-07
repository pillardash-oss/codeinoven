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
import { discoverPeers, type DiscoveredPeer } from './discovery'
import { createLanTransport, type LanTransport } from './transport'
import { createRelayClient, type RelayClient } from './relay'
import { remoteLog } from './logger'
import { loadDeviceIdentity, type DeviceIdentity } from './device-identity'
import { SvelteSet } from 'svelte/reactivity'

const LAN_HANDSHAKE_TIMEOUT_MS = 3_000
const RELAY_HANDSHAKE_TIMEOUT_MS = 3_000

/** An explicit endpoint to connect to (the LAN gateway, LAN-first). */
export interface RemoteConnectionTarget {
  host: string
  port: number
  scheme: 'ws' | 'wss'
}

export class RemoteSessionStore {
  snapshot = $state<SessionSnapshot>(initialSession())

  private secret = ''
  private lanTransport: LanTransport | null = null
  private relayClient: RelayClient | null = null
  private messageListeners = new SvelteSet<(plaintext: string) => void>()
  private identity: DeviceIdentity = loadDeviceIdentity()

  dispatch(action: SessionAction): void {
    this.snapshot = applySessionAction(this.snapshot, action)
  }

  /** Register a listener for every decrypted `remote:data` message received. */
  onMessage(listener: (plaintext: string) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  /** Send a plaintext JSON payload to the desktop, encrypted at the transport. */
  async sendPayload(payload: unknown): Promise<void> {
    const data = JSON.stringify(payload)
    if (this.lanTransport) {
      await this.lanTransport.send(data)
      return
    }
    if (this.relayClient) {
      await this.relayClient.send(data)
      return
    }
    remoteLog.error('Remote session payload send attempted before the channel was open')
  }

  private routeMessage(plaintext: string): void {
    for (const listener of this.messageListeners) {
      listener(plaintext)
    }
  }

  /** Connect through the shared modules: LAN first, relay fallback. */
  async connect(secret: string, target?: RemoteConnectionTarget): Promise<void> {
    this.secret = secret
    this.closeChannels()
    const config = loadRemoteConfig()
    this.dispatch({ type: 'lanProbeStart' })

    const port = target?.port ?? config.lan.localPort
    const scheme = target?.scheme ?? 'ws'
    const manualHosts = target && target.host.length > 0 ? [target.host] : config.lan.hosts

    // Probe reachability without keeping the probe sockets: every probe is
    // closed as soon as it resolves, so no channels are orphaned.
    const peers = await discoverPeers({
      port,
      manualHosts,
      useMdns: config.lan.useMdns,
      timeoutMs: 0,
      reachable: async (peer) => {
        const probe = createLanTransport({
          peer,
          authSecret: secret,
          scheme,
          handshakeTimeoutMs: LAN_HANDSHAKE_TIMEOUT_MS,
          deviceId: this.identity.id,
          deviceName: this.identity.name,
          onEvent: () => undefined
        })
        const outcome = await probe.connect()
        probe.close()
        return outcome === 'open'
      }
    })

    const peer = peers[0]
    if (peer) {
      const accepted = await this.openLanSession(peer, secret, scheme)
      if (accepted) {
        remoteLog.info(`Remote session connected over LAN to ${peer.host}:${peer.port}`)
        this.dispatch({ type: 'lanConnected', peer: { host: peer.host, port: peer.port } })
        this.dispatch({ type: 'peerReachableChanged', reachable: true })
        return
      }
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
        if (event.kind === 'message') {
          this.routeMessage(event.data)
          return
        }
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

  /** Open the kept LAN session channel against the first reachable peer. */
  private async openLanSession(
    peer: DiscoveredPeer,
    secret: string,
    scheme: 'ws' | 'wss'
  ): Promise<boolean> {
    const session = createLanTransport({
      peer,
      authSecret: secret,
      scheme,
      handshakeTimeoutMs: LAN_HANDSHAKE_TIMEOUT_MS,
      deviceId: this.identity.id,
      deviceName: this.identity.name,
      onEvent: (event) => {
        if (event.kind === 'message') {
          this.routeMessage(event.data)
          return
        }
        if (event.kind === 'disconnected' && this.lanTransport === session) {
          this.dispatch({ type: 'disconnected', reason: 'lan-lost' })
          this.lanTransport = null
        }
      }
    })
    const outcome = await session.connect()
    if (outcome === 'open') {
      this.lanTransport = session
      return true
    }
    session.close()
    return false
  }

  /** Tear down any open channel and return to DISCONNECTED. */
  disconnect(): void {
    this.closeChannels()
    this.dispatch({ type: 'disconnected' })
  }

  private closeChannels(): void {
    this.lanTransport?.close()
    this.lanTransport = null
    this.relayClient?.close()
    this.relayClient = null
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
