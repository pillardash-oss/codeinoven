/**
 * Reactive remote-session store.
 *
 * Wraps the pure `session-state.ts` reducer in Svelte 5 reactivity and owns one
 * account-backed connection flow: try the account-provided LAN endpoint first,
 * then use the account relay and periodically upgrade back to LAN.
 */

import {
  applySessionAction,
  initialSession,
  type KeepAlivePhase,
  type SessionAction,
  type SessionSnapshot
} from './session-state'
import { createLanTransport, type LanTransport } from './transport'
import { createAccountRelayClient, type AccountRelayClient } from './account-relay'
import { remoteLog } from './logger'
import type { PeerRef } from './routes'
import {
  handshakeTranscript,
  clearAssignedDesktop,
  loadOrCreateDeviceKeyMaterial,
  saveAssignedDeviceId,
  saveDeviceAuthVersion,
  signTranscript,
  type DeviceKeyMaterial
} from './device-identity'
import { SvelteSet } from 'svelte/reactivity'

const LAN_HANDSHAKE_TIMEOUT_MS = 3_000

/** An explicit endpoint to connect to (the LAN gateway, LAN-first). */
export interface RemoteConnectionTarget {
  host: string
  port: number
  scheme: 'ws' | 'wss'
}

interface AccountDesktopRoute {
  desktopId: string
  mobileDeviceId: string
  controlSecret: string
  relayPath?: string
  lanTargets?: RemoteConnectionTarget[]
  /** Legacy single-candidate route retained for restored clients during rollout. */
  lanTarget?: RemoteConnectionTarget
}

function lanTargets(route: AccountDesktopRoute): RemoteConnectionTarget[] {
  const candidates = [...(route.lanTargets ?? []), ...(route.lanTarget ? [route.lanTarget] : [])]
  return candidates.filter(
    (candidate, index) =>
      candidates.findIndex(
        (entry) =>
          entry.scheme === candidate.scheme &&
          entry.host === candidate.host &&
          entry.port === candidate.port
      ) === index
  )
}

export class RemoteSessionStore {
  snapshot = $state<SessionSnapshot>(initialSession())
  /** Keeps the mounted workspace visible while a suspended relay reconnects. */
  recovering = $state(false)

  private secret = ''
  private lanTransport: LanTransport | null = null
  private accountRelayClient: AccountRelayClient | null = null
  private accountRoute: AccountDesktopRoute | null = null
  private lanUpgradeTimer: number | null = null
  private accountReconnectTimer: number | null = null
  private accountReconnectAttempt = 0
  private messageListeners = new SvelteSet<(plaintext: string) => void>()
  private stateListeners = new SvelteSet<(snapshot: SessionSnapshot) => void>()
  private keyMaterial: DeviceKeyMaterial | null = null
  private keyMaterialDesktopId: string | null = null
  /** Resolves once the phone has authenticated as a device over the relay. */
  private relayDeviceAuth: Promise<void> | null = null
  private relayChallengeReceived = false
  private relayBootstrapFallbackAttempted = false
  /** Unique identity for the current browser relay WebSocket connection. */
  private relayConnectionId = ''
  private resumeTask: Promise<void> | null = null

  private async ensureKeyMaterial(desktopId: string | null = null): Promise<DeviceKeyMaterial> {
    if (this.keyMaterial && this.keyMaterialDesktopId === desktopId) return this.keyMaterial
    this.keyMaterial = await loadOrCreateDeviceKeyMaterial({ desktopId: desktopId ?? undefined })
    this.keyMaterialDesktopId = desktopId
    return this.keyMaterial
  }

  /** Persist the desktop-assigned device id from the enrollment handshake. */
  private async applyAssignedDevice(deviceId: string, authVersion?: number): Promise<void> {
    await saveAssignedDeviceId(deviceId, undefined, this.keyMaterialDesktopId ?? undefined)
    if (this.keyMaterial) {
      this.keyMaterial.deviceId = deviceId
      if (typeof authVersion === 'number') {
        this.keyMaterial.authVersion = authVersion
        await saveDeviceAuthVersion(authVersion, undefined, this.keyMaterialDesktopId ?? undefined)
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
    this.relayBootstrapFallbackAttempted = false
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
          this.relayChallengeReceived = true
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
          clearTimeout(timer)
          off()
          if (!assigned || typeof assigned.id !== 'string') {
            resolve()
            return
          }
          void this.applyAssignedDevice(
            assigned.id,
            typeof assigned.authVersion === 'number' ? assigned.authVersion : undefined
          ).then(resolve, (error: unknown) => {
            reject(error instanceof Error ? error : new Error(String(error)))
          })
          return
        }
        if (record['type'] === 'remote:device:error') {
          if (this.keyMaterial?.deviceId && !this.relayBootstrapFallbackAttempted) {
            this.relayBootstrapFallbackAttempted = true
            this.keyMaterial.deviceId = null
            this.keyMaterial.authVersion = 1
            const desktopId = this.keyMaterialDesktopId
            void (desktopId ? clearAssignedDesktop(desktopId) : Promise.resolve())
              .then(() => this.sendRaw({ type: 'remote:device:challenge-request' }))
              .catch((error) => {
                clearTimeout(timer)
                off()
                reject(error instanceof Error ? error : new Error(String(error)))
              })
            return
          }
          clearTimeout(timer)
          off()
          reject(new Error(`Relay device authentication failed: ${String(record['reason'] ?? '')}`))
        }
      })
    })
  }

  /** Sign the desktop-issued relay challenge nonce and prove possession. */
  private async respondToRelayChallenge(nonce: string): Promise<void> {
    const keyMaterial = await this.ensureKeyMaterial(this.keyMaterialDesktopId)
    const cloudMobileDeviceId = this.accountRoute?.mobileDeviceId ?? null
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
      deviceName: keyMaterial.deviceName,
      connectionId: this.relayConnectionId
    }
    // The cloud grant installation id is distinct from the credential id the
    // desktop assigns below. Return it over this encrypted authenticated frame
    // so the desktop can finish only the pairing code this installation claimed.
    if (cloudMobileDeviceId) authFrame['cloudMobileDeviceId'] = cloudMobileDeviceId
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
    if (this.lanTransport) {
      await this.lanTransport.send(data)
    }
  }

  dispatch(action: SessionAction): void {
    this.snapshot = applySessionAction(this.snapshot, action)
    for (const listener of this.stateListeners) listener(this.snapshot)
  }

  /** Register a listener for every decrypted `remote:data` message received. */
  onMessage(listener: (plaintext: string) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  /** Register a listener for transport/session state changes. */
  onStateChange(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
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
        throw error
      }
    }
    await this.sendRaw(payload)
  }

  /** Tell the desktop whether the user opened or left its remote workspace. */
  async setWorkspaceActive(active: boolean): Promise<void> {
    if (this.relayDeviceAuth) await this.relayDeviceAuth
    await this.sendRaw({ type: 'remote:workspace:active', active })
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
    await this.ensureKeyMaterial(input.desktopId)
    this.dispatch({ type: 'relayProbeStart' })
    this.relayChallengeReceived = false
    this.relayConnectionId = globalThis.crypto.randomUUID()
    // Install the first listener before opening the socket so a challenge
    // replayed from the relay buffer cannot arrive before the phone is ready.
    this.relayDeviceAuth = this.beginRelayDeviceAuth()
    let awaitingInitialConnection = true
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
          if (awaitingInitialConnection) {
            awaitingInitialConnection = false
          } else {
            this.relayChallengeReceived = false
            this.relayConnectionId = globalThis.crypto.randomUUID()
            const deviceAuth = this.beginRelayDeviceAuth()
            this.relayDeviceAuth = deviceAuth
            void deviceAuth
              .then(() => {
                if (this.accountRelayClient !== client) return
                this.recovering = false
                this.dispatch({ type: 'relayConnected', relay: { url: window.location.origin } })
                this.scheduleLanUpgrade()
              })
              .catch(() => {
                if (this.accountRelayClient === client) {
                  this.recovering = false
                  this.dispatch({ type: 'disconnected', reason: 'device-auth-failed' })
                }
              })
          }
          // The desktop relay socket may outlive many mobile reconnects, so a
          // new mobile connection explicitly requests its own one-time device
          // challenge after its listener is installed.
          if (!this.relayChallengeReceived) {
            void this.sendRaw({
              type: 'remote:device:challenge-request',
              connectionId: this.relayConnectionId
            })
          }
          return
        }
        if (event.kind === 'offline' && this.accountRelayClient === client) {
          this.recovering = this.recovering || this.snapshot.route.kind === 'RELAY_CONNECTED'
          this.dispatch({ type: 'disconnected', reason: 'desktop-offline' })
          return
        }
        if (event.kind === 'disconnected' && this.accountRelayClient === client) {
          // The client keeps retrying on its own; surface the state only.
          this.recovering = this.recovering || this.snapshot.route.kind === 'RELAY_CONNECTED'
          this.dispatch({ type: 'disconnected', reason: event.reason })
        }
      }
    })
    this.accountRelayClient = client
    const outcome = await client.connect()
    awaitingInitialConnection = false
    if (outcome === 'open') {
      this.accountReconnectAttempt = 0
      try {
        const deviceAuth = this.relayDeviceAuth
        if (!deviceAuth) throw new Error('Relay device authentication did not start')
        await deviceAuth
      } catch (error) {
        if (this.accountRelayClient === client) {
          this.dispatch({ type: 'disconnected', reason: 'device-auth-failed' })
        }
        throw error
      }
      if (this.accountRelayClient !== client) return
      this.recovering = false
      this.dispatch({ type: 'relayConnected', relay: { url: window.location.origin } })
      this.scheduleLanUpgrade()
      return
    }
    // The first socket can legitimately report the desktop offline. Mark the
    // current authentication waiter as observed; the reconnect event replaces
    // it with a fresh challenge and timeout when the desktop appears.
    void this.relayDeviceAuth?.catch(() => undefined)
    // The client self-reconnects; reflect the transient failure only.
    this.dispatch({
      type: 'disconnected',
      reason: outcome === 'offline' ? 'desktop-offline' : 'relay-unreachable'
    })
  }

  /** Prefer the authenticated account LAN route, then use the account relay. */
  async connectAccountDesktop(
    input: AccountDesktopRoute,
    preserveWorkspace = false
  ): Promise<void> {
    if (!preserveWorkspace) this.recovering = false
    this.accountRoute = input
    // Initial connections have no useful channel to preserve. Resume and
    // upgrade flows keep the current transport alive until a LAN candidate has
    // authenticated, preventing a probe from ejecting in-flight workspace RPC.
    if (!preserveWorkspace) this.closeChannels()
    for (const target of lanTargets(input)) {
      try {
        await this.connectLan(input.controlSecret, target, input.desktopId, preserveWorkspace)
        this.accountRoute = input
        if (this.snapshot.route.kind === 'LAN_CONNECTED') return
      } catch (error) {
        remoteLog.info(
          `Account LAN route ${target.host}:${target.port} unavailable: ${String(error)}`
        )
      }
    }
    await this.connectCloud(input)
  }

  private routeMessage(plaintext: string): void {
    for (const listener of this.messageListeners) {
      listener(plaintext)
    }
  }

  /** Try the exact LAN endpoint supplied by the account connection response. */
  private async connectLan(
    secret: string,
    target: RemoteConnectionTarget,
    desktopId: string | null = null,
    preserveExistingChannel = false
  ): Promise<void> {
    this.secret = secret
    const previousLan = this.lanTransport
    const previousRelay = this.accountRelayClient
    if (!preserveExistingChannel) this.closeChannels()
    const keyMaterial = await this.ensureKeyMaterial(desktopId)
    const device = {
      deviceId: keyMaterial.deviceId,
      deviceName: keyMaterial.deviceName,
      authVersion: keyMaterial.authVersion,
      signingKey: keyMaterial.signingKey,
      signingPublicJwk: keyMaterial.signingPublicJwk,
      agreementPublicJwk: keyMaterial.agreementPublicJwk
    }
    this.dispatch({ type: 'lanProbeStart' })
    const peer: PeerRef = { host: target.host, port: target.port }
    const session = await this.openLanSession(
      peer,
      secret,
      target.scheme,
      device,
      keyMaterial.deviceId ? null : secret
    )
    if (session && this.lanTransport === session) {
      if (preserveExistingChannel) {
        if (previousLan && previousLan !== session) previousLan.close()
        previousRelay?.close()
        if (this.accountRelayClient === previousRelay) this.accountRelayClient = null
      }
      remoteLog.info(`Remote session connected over LAN to ${peer.host}:${peer.port}`)
      this.recovering = false
      this.dispatch({ type: 'lanConnected', peer })
      this.dispatch({ type: 'peerReachableChanged', reachable: true })
      return
    }
    this.dispatch({ type: 'disconnected', reason: 'no-lan-peer' })
  }

  /** Open the kept LAN session channel against the first reachable peer. */
  private async openLanSession(
    peer: PeerRef,
    secret: string,
    scheme: 'ws' | 'wss',
    device?: import('./transport').LanDeviceCredentials,
    pairingBootstrap?: string | null
  ): Promise<LanTransport | null> {
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
          this.lanTransport = null
          // A candidate used for a make-before-break upgrade can disappear
          // before it becomes the active route. Do not tear down the healthy
          // relay in that case.
          if (this.snapshot.route.kind !== 'LAN_CONNECTED') return
          this.recovering = true
          this.dispatch({ type: 'disconnected', reason: 'lan-lost' })
          if (this.accountRoute) void this.connectCloud(this.accountRoute)
        }
      }
    })
    const outcome = await session.connect()
    if (outcome === 'open') {
      this.lanTransport = session
      return session
    }
    session.close()
    return null
  }

  /** Tear down any open channel and return to DISCONNECTED. */
  disconnect(): void {
    this.accountRoute = null
    this.recovering = false
    this.closeChannels()
    this.dispatch({ type: 'disconnected' })
  }

  private closeChannels(): void {
    this.relayDeviceAuth = null
    this.relayConnectionId = ''
    if (this.lanUpgradeTimer !== null) window.clearTimeout(this.lanUpgradeTimer)
    this.lanUpgradeTimer = null
    if (this.accountReconnectTimer !== null) window.clearTimeout(this.accountReconnectTimer)
    this.accountReconnectTimer = null
    this.lanTransport?.close()
    this.lanTransport = null
    this.accountRelayClient?.close()
    this.accountRelayClient = null
  }

  /**
   * Re-establish a selected desktop after a phone browser resumes from
   * suspension. Mobile operating systems may silently discard the WebSocket
   * while the page is frozen, so waiting only for its close callback can leave
   * the installed PWA stranded indefinitely.
   */
  async resume(): Promise<void> {
    if (this.resumeTask) return this.resumeTask
    const route = this.accountRoute
    if (!route || !this.recovering) return
    this.resumeTask = this.connectAccountDesktop(route, true).finally(() => {
      this.resumeTask = null
    })
    await this.resumeTask
  }

  /** Mark an account route for verification when the browser is foregrounded. */
  suspend(): void {
    if (!this.accountRoute) return
    if (
      this.snapshot.route.kind === 'LAN_CONNECTED' ||
      this.snapshot.route.kind === 'RELAY_CONNECTED'
    ) {
      this.recovering = true
    }
  }

  private scheduleLanUpgrade(): void {
    if (!this.accountRoute || lanTargets(this.accountRoute).length === 0) return
    if (this.lanUpgradeTimer !== null) return
    this.lanUpgradeTimer = window.setTimeout(() => {
      this.lanUpgradeTimer = null
      void this.tryLanUpgrade()
    }, 30_000)
  }

  private async tryLanUpgrade(): Promise<void> {
    const route = this.accountRoute
    if (!route || this.snapshot.route.kind !== 'RELAY_CONNECTED') return
    const keyMaterial = await this.ensureKeyMaterial(route.desktopId)
    const device = {
      deviceId: keyMaterial.deviceId,
      deviceName: keyMaterial.deviceName,
      authVersion: keyMaterial.authVersion,
      signingKey: keyMaterial.signingKey,
      signingPublicJwk: keyMaterial.signingPublicJwk,
      agreementPublicJwk: keyMaterial.agreementPublicJwk
    }
    for (const target of lanTargets(route)) {
      const peer: PeerRef = { host: target.host, port: target.port }
      const session = await this.openLanSession(
        peer,
        route.controlSecret,
        target.scheme,
        device,
        keyMaterial.deviceId ? null : route.controlSecret
      )
      if (!session || this.lanTransport !== session) continue
      this.accountRelayClient?.close()
      this.accountRelayClient = null
      this.dispatch({ type: 'lanConnected', peer })
      this.dispatch({ type: 'peerReachableChanged', reachable: true })
      remoteLog.info(
        `Remote session upgraded from cloud relay to LAN via ${peer.host}:${peer.port}`
      )
      return
    }
    this.scheduleLanUpgrade()
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
