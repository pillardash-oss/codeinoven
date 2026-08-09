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
import { createAccountRelayClient, type AccountRelayClient } from './account-relay'
import { remoteLog } from './logger'
import {
  handshakeTranscript,
  loadOrCreateDeviceKeyMaterial,
  saveAssignedDeviceId,
  saveDeviceAuthVersion,
  signTranscript,
  type DeviceKeyMaterial
} from './device-identity'
import { SvelteSet } from 'svelte/reactivity'

const LAN_HANDSHAKE_TIMEOUT_MS = 3_000
const RELAY_HANDSHAKE_TIMEOUT_MS = 3_000

/** An explicit endpoint to connect to (the LAN gateway, LAN-first). */
export interface RemoteConnectionTarget {
  host: string
  port: number
  scheme: 'ws' | 'wss'
}

/** Options controlling which transport authenticates the phone session. */
export interface RemoteConnectOptions {
  /**
   * True for the phone PWA: the LAN handshake proves possession of the
   * device's signing key (and presents the pairing bootstrap on first use).
   * The desktop renderer's own loopback session keeps the legacy secret path.
   */
  deviceCredentials?: boolean
}

interface AccountDesktopRoute {
  desktopId: string
  mobileDeviceId: string
  controlSecret: string
  relayPath?: string
  lanTarget?: RemoteConnectionTarget
}

export class RemoteSessionStore {
  snapshot = $state<SessionSnapshot>(initialSession())

  private secret = ''
  private lanTransport: LanTransport | null = null
  private relayClient: RelayClient | null = null
  private accountRelayClient: AccountRelayClient | null = null
  private accountRoute: AccountDesktopRoute | null = null
  private lanUpgradeTimer: number | null = null
  private accountReconnectTimer: number | null = null
  private accountReconnectAttempt = 0
  private messageListeners = new SvelteSet<(plaintext: string) => void>()
  private keyMaterial: DeviceKeyMaterial | null = null
  /** Resolves once the phone has authenticated as a device over the relay. */
  private relayDeviceAuth: Promise<void> | null = null

  private async ensureKeyMaterial(): Promise<DeviceKeyMaterial> {
    if (this.keyMaterial) return this.keyMaterial
    this.keyMaterial = await loadOrCreateDeviceKeyMaterial()
    return this.keyMaterial
  }

  /** Persist the desktop-assigned device id from the enrollment handshake. */
  private async applyAssignedDevice(deviceId: string, authVersion?: number): Promise<void> {
    await saveAssignedDeviceId(deviceId)
    if (this.keyMaterial) {
      this.keyMaterial.deviceId = deviceId
      if (typeof authVersion === 'number') {
        this.keyMaterial.authVersion = authVersion
        await saveDeviceAuthVersion(authVersion)
      }
    }
  }

  /**
   * Begin the relay device challenge-response: the desktop issues a fresh
   * single-use nonce, the phone signs it with its proof-of-possession key, and
   * the desktop binds the enrolled device to the session. The returned promise
   * resolves only on `remote:device:ok`; it rejects on `remote:device:error`
   * or timeout so queued RPC is never released against an unauthenticated
   * session.
   */
  private beginRelayDeviceAuth(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error('Relay device authentication timed out'))
      }, 12_000) as unknown as number
      const off = this.onMessage((plaintext) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(plaintext)
        } catch {
          return
        }
        if (typeof parsed !== 'object' || parsed === null) return
        const record = parsed as Record<string, unknown>
        if (record['type'] === 'remote:device:challenge' && typeof record['nonce'] === 'string') {
          void this.respondToRelayChallenge(record['nonce'] as string).catch((error) => {
            remoteLog.error(`Could not respond to the relay device challenge: ${String(error)}`)
            clearTimeout(timer)
            off()
            reject(error instanceof Error ? error : new Error(String(error)))
          })
          return
        }
        if (record['type'] === 'remote:device:ok') {
          const assigned = record['device'] as { id?: unknown; authVersion?: unknown } | undefined
          if (assigned && typeof assigned.id === 'string') {
            void this.applyAssignedDevice(
              assigned.id,
              typeof assigned.authVersion === 'number' ? assigned.authVersion : undefined
            )
          }
          clearTimeout(timer)
          off()
          resolve()
          return
        }
        if (record['type'] === 'remote:device:error') {
          clearTimeout(timer)
          off()
          reject(new Error(`Relay device authentication failed: ${String(record['reason'] ?? '')}`))
        }
      })
    })
  }

  /** Sign the desktop-issued relay challenge nonce and prove possession. */
  private async respondToRelayChallenge(nonce: string): Promise<void> {
    const keyMaterial = await this.ensureKeyMaterial()
    const transcript = handshakeTranscript({
      nonce,
      deviceId: keyMaterial.deviceId,
      authVersion: keyMaterial.authVersion,
      bootstrap: this.secret || null,
      context: 'relay'
    })
    const signature = await signTranscript(keyMaterial.signingKey, transcript)
    const authFrame: Record<string, unknown> = {
      type: 'remote:device:auth',
      nonce,
      signature,
      deviceName: keyMaterial.deviceName
    }
    if (keyMaterial.deviceId) {
      authFrame['deviceId'] = keyMaterial.deviceId
      authFrame['authVersion'] = keyMaterial.authVersion
    } else {
      authFrame['bootstrap'] = this.secret
      authFrame['signingPublicJwk'] = keyMaterial.signingPublicJwk
      authFrame['agreementPublicJwk'] = keyMaterial.agreementPublicJwk
    }
    await this.sendRaw(authFrame)
  }

  /** Send a frame without waiting for relay device authentication. */
  private async sendRaw(payload: unknown): Promise<void> {
    const data = JSON.stringify(payload)
    if (this.accountRelayClient) {
      await this.accountRelayClient.send(data)
      return
    }
    if (this.relayClient) {
      await this.relayClient.send(data)
      return
    }
    if (this.lanTransport) {
      await this.lanTransport.send(data)
    }
  }

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
    // Over the relay, RPC must wait until this phone has authenticated as a
    // device; the desktop (fail-closed) rejects every invocation otherwise.
    // A failed or timed-out authentication releases nothing and surfaces the
    // connection failure instead of sending queued RPC into the void.
    if (this.relayDeviceAuth) {
      try {
        await this.relayDeviceAuth
      } catch (error) {
        const message = error instanceof Error ? error.message : 'device not authenticated'
        remoteLog.error(`Remote session RPC blocked: ${message}`)
        return
      }
    }
    await this.sendRaw(payload)
  }

  /** Connect to one account-owned desktop through the hosted same-origin relay. */
  async connectCloud(input: {
    desktopId: string
    mobileDeviceId: string
    controlSecret: string
    relayPath?: string
  }): Promise<void> {
    this.secret = input.controlSecret
    this.closeChannels()
    this.dispatch({ type: 'relayProbeStart' })
    // Register the relay device challenge-response before connecting so no
    // desktop-issued challenge is missed, and surface a human-readable failure
    // if the phone cannot authenticate as an enrolled device.
    this.relayDeviceAuth = this.beginRelayDeviceAuth()
    this.relayDeviceAuth.catch(() => {
      if (this.snapshot.route.kind === 'RELAY_CONNECTED') {
        this.dispatch({ type: 'disconnected', reason: 'device-auth-failed' })
      }
    })
    // The account-relay client owns reconnection (full-jitter backoff that
    // preserves its bounded queue across socket drops), so the store never
    // spawns a duplicate client per disconnect.
    const client = createAccountRelayClient({
      desktopId: input.desktopId,
      mobileDeviceId: input.mobileDeviceId,
      controlSecret: input.controlSecret,
      relayPath: input.relayPath,
      reconnect: {
        initialDelayMs: 1_000,
        maxDelayMs: 30_000
      },
      onEvent: (event) => {
        if (event.kind === 'message') {
          this.routeMessage(event.data)
          return
        }
        if (event.kind === 'connected' && this.accountRelayClient === client) {
          this.accountReconnectAttempt = 0
          this.dispatch({ type: 'relayConnected', relay: { url: window.location.origin } })
          this.relayDeviceAuth = this.beginRelayDeviceAuth()
          this.relayDeviceAuth.catch(() => {
            if (this.snapshot.route.kind === 'RELAY_CONNECTED') {
              this.dispatch({ type: 'disconnected', reason: 'device-auth-failed' })
            }
          })
          this.scheduleLanUpgrade()
          return
        }
        if (event.kind === 'offline' && this.accountRelayClient === client) {
          this.dispatch({ type: 'disconnected', reason: 'desktop-offline' })
          return
        }
        if (event.kind === 'disconnected' && this.accountRelayClient === client) {
          // The client keeps retrying on its own; surface the state only.
          this.dispatch({ type: 'disconnected', reason: event.reason })
        }
      }
    })
    this.accountRelayClient = client
    const outcome = await client.connect()
    if (outcome === 'open') {
      this.accountReconnectAttempt = 0
      this.dispatch({ type: 'relayConnected', relay: { url: window.location.origin } })
      this.scheduleLanUpgrade()
      return
    }
    // The client self-reconnects; reflect the transient failure only.
    this.dispatch({
      type: 'disconnected',
      reason: outcome === 'offline' ? 'desktop-offline' : 'relay-unreachable'
    })
  }

  /** Prefer an authenticated direct LAN route, then use the account relay. */
  async connectAccountDesktop(input: AccountDesktopRoute): Promise<void> {
    this.accountRoute = input
    if (input.lanTarget) {
      await this.connect(input.controlSecret, input.lanTarget, { deviceCredentials: true })
      this.accountRoute = input
      if (this.snapshot.route.kind === 'LAN_CONNECTED') return
    }
    await this.connectCloud(input)
  }

  private routeMessage(plaintext: string): void {
    for (const listener of this.messageListeners) {
      listener(plaintext)
    }
  }

  /** Connect through the shared modules: LAN first, relay fallback. */
  async connect(
    secret: string,
    target?: RemoteConnectionTarget,
    options: RemoteConnectOptions = {}
  ): Promise<void> {
    this.secret = secret
    this.closeChannels()
    const config = loadRemoteConfig()
    const keyMaterial = options.deviceCredentials ? await this.ensureKeyMaterial() : null
    const device = keyMaterial
      ? {
          deviceId: keyMaterial.deviceId,
          deviceName: keyMaterial.deviceName,
          authVersion: keyMaterial.authVersion,
          signingKey: keyMaterial.signingKey,
          signingPublicJwk: keyMaterial.signingPublicJwk,
          agreementPublicJwk: keyMaterial.agreementPublicJwk
        }
      : undefined
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
          device,
          pairingBootstrap: keyMaterial ? secret : null,
          onEvent: () => undefined
        })
        const outcome = await probe.connect()
        probe.close()
        return outcome === 'open'
      }
    })

    const peer = peers[0]
    if (peer) {
      const accepted = await this.openLanSession(
        peer,
        secret,
        scheme,
        device,
        keyMaterial ? secret : null
      )
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
    this.relayDeviceAuth = this.beginRelayDeviceAuth()
    this.relayDeviceAuth.catch(() => {
      if (this.snapshot.route.kind === 'RELAY_CONNECTED') {
        this.dispatch({ type: 'disconnected', reason: 'device-auth-failed' })
      }
    })
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
    scheme: 'ws' | 'wss',
    device?: import('./transport').LanDeviceCredentials,
    pairingBootstrap?: string | null
  ): Promise<boolean> {
    const session = createLanTransport({
      peer,
      authSecret: secret,
      scheme,
      handshakeTimeoutMs: LAN_HANDSHAKE_TIMEOUT_MS,
      device,
      pairingBootstrap,
      onAssignedDevice: (deviceId) => {
        const authVersion = this.keyMaterial?.authVersion
        this.applyAssignedDevice(deviceId, authVersion)
      },
      onEvent: (event) => {
        if (event.kind === 'message') {
          this.routeMessage(event.data)
          return
        }
        if (event.kind === 'disconnected' && this.lanTransport === session) {
          this.dispatch({ type: 'disconnected', reason: 'lan-lost' })
          this.lanTransport = null
          if (this.accountRoute) void this.connectCloud(this.accountRoute)
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
    this.accountRoute = null
    this.closeChannels()
    this.dispatch({ type: 'disconnected' })
  }

  private closeChannels(): void {
    this.relayDeviceAuth = null
    if (this.lanUpgradeTimer !== null) window.clearTimeout(this.lanUpgradeTimer)
    this.lanUpgradeTimer = null
    if (this.accountReconnectTimer !== null) window.clearTimeout(this.accountReconnectTimer)
    this.accountReconnectTimer = null
    this.lanTransport?.close()
    this.lanTransport = null
    this.relayClient?.close()
    this.relayClient = null
    this.accountRelayClient?.close()
    this.accountRelayClient = null
  }

  private scheduleLanUpgrade(): void {
    if (!this.accountRoute?.lanTarget || this.lanUpgradeTimer !== null) return
    this.lanUpgradeTimer = window.setTimeout(() => {
      this.lanUpgradeTimer = null
      void this.tryLanUpgrade()
    }, 30_000)
  }

  private async tryLanUpgrade(): Promise<void> {
    const route = this.accountRoute
    const target = route?.lanTarget
    if (!route || !target || this.snapshot.route.kind !== 'RELAY_CONNECTED') return
    const keyMaterial = await this.ensureKeyMaterial()
    const peer: DiscoveredPeer = { host: target.host, port: target.port, source: 'manual' }
    const probe = createLanTransport({
      peer,
      authSecret: route.controlSecret,
      scheme: target.scheme,
      handshakeTimeoutMs: LAN_HANDSHAKE_TIMEOUT_MS,
      device: {
        deviceId: keyMaterial.deviceId,
        deviceName: keyMaterial.deviceName,
        authVersion: keyMaterial.authVersion,
        signingKey: keyMaterial.signingKey,
        signingPublicJwk: keyMaterial.signingPublicJwk,
        agreementPublicJwk: keyMaterial.agreementPublicJwk
      },
      pairingBootstrap: route.controlSecret,
      onEvent: () => undefined
    })
    const reachable = (await probe.connect()) === 'open'
    probe.close()
    if (!reachable) {
      this.scheduleLanUpgrade()
      return
    }
    this.accountRelayClient?.close()
    this.accountRelayClient = null
    if (await this.openLanSession(peer, route.controlSecret, target.scheme)) {
      this.dispatch({ type: 'lanConnected', peer })
      this.dispatch({ type: 'peerReachableChanged', reachable: true })
      remoteLog.info('Remote session upgraded from cloud relay to LAN')
      return
    }
    await this.connectCloud(route)
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
