/**
 * Remote-mode controller (main process).
 *
 * Owns the keep-alive session, the LAN gateway, and the system Tray, and wires
 * quit interception so the desktop stays alive while the user is away. This is
 * the production `TrayHost`/`KeepAliveSession` wiring for the renderer-side
 * modules: the plain `keep-alive.ts` state machine is shared with the renderer
 * via `src/renderer/lib/remote/keep-alive.ts`.
 */

import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { hostname, platform } from 'node:os'
import { Logger } from '../logger'
import { SecretVault } from '../secret-vault'
import { CloudRelayClient } from './cloud-relay-client'
import { createDesktopControlGrant } from './control-grant'
import { RemoteGateway } from './remote-gateway'
import { createRemoteTray, type RemoteTray } from './remote-tray'
import type { RemoteCloudStatus, RemoteDeviceInfo, RemoteModeStatus } from './remote-types'
import { createKeepAliveSession, type KeepAliveSession } from '../../renderer/lib/remote/keep-alive'
import { loadOrCreatePeerSecret } from './peer-secret'
import { RemoteRpcDispatcher } from './remote-rpc'
import { setRemoteEventForwarder } from './remote-event-forwarder'
import {
  readRemoteDeviceNames,
  readRemoteModeState,
  writeRemoteDeviceName,
  writeRemoteModeState
} from './remote-state'

declare global {
  /** Public remote-service origin injected by the Electron production build. */
  const __CODEINOVEN_REMOTE_API_ORIGIN__: string | undefined
}

export interface RemoteModeOptions {
  lanPort: number
  localPort: number
  peerSecret: string | null
  staticRoot: string
  iconPath: string
  /** Optional remote RPC dispatcher that serves the phone chat client. */
  rpc?: RemoteRpcDispatcher | null
  /** Optional storage used to persist the remote-mode flag across restarts. */
  storage?: import('../storage-engine').StorageEngine | null
  /**
   * Called whenever the live remote-session state changes (a phone connects or
   * disconnects). Lets the host keep the device awake while a session is live.
   */
  onSessionActiveChange?: (active: boolean) => void
}

export const DEFAULT_LAN_PORT = 4455
const CLOUD_CONFIG_PATH = 'remote/cloud-access.json'

interface CloudAccessConfig {
  apiOrigin: string
  desktopId: string
  enrollmentId: string
  tokenRef: string
  enrollmentExpiresAt: number
}

interface EnrollmentResponse {
  enrollmentId: string
  desktopId: string
  deviceToken: string | null
  code: string
  expiresAt: number
}

/** Read a positive integer env var, falling back to `fallback`. */
export function remoteEnvInt(name: string, fallback: number): number {
  const value = process.env[name]
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const CLOUD_REQUEST_TIMEOUT_MS = 15_000

/**
 * Fetch with an application-level deadline and external cancellation. The
 * request aborts when the timeout elapses or the owning controller shuts the
 * cloud access down (remote mode disabled / app dispose), so stale polls can
 * never outlive a config change.
 */
async function fetchWithDeadline(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal | null
): Promise<Response> {
  const controller = new AbortController()
  const onExternalAbort = (): void => controller.abort()
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs) as unknown as number
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}

/** Resolve the shared peer auth secret for the gateway, if configured. */
export function remotePeerSecret(): string | null {
  return process.env['PEER_SECRET_AUTH'] ?? process.env['VITE_PEER_SECRET_AUTH'] ?? null
}

function resolveCloudApiOrigin(): string | null {
  const baked =
    typeof __CODEINOVEN_REMOTE_API_ORIGIN__ === 'string'
      ? __CODEINOVEN_REMOTE_API_ORIGIN__
      : undefined
  const value = (process.env['REMOTE_API_ORIGIN'] ?? baked ?? '').trim()
  if (!value) return null
  try {
    const url = new URL(value)
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function parseEnrollmentResponse(value: unknown): EnrollmentResponse | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    typeof record['enrollmentId'] !== 'string' ||
    typeof record['desktopId'] !== 'string' ||
    (record['deviceToken'] !== null && typeof record['deviceToken'] !== 'string') ||
    typeof record['code'] !== 'string' ||
    typeof record['expiresAt'] !== 'number'
  ) {
    return null
  }
  return {
    enrollmentId: record['enrollmentId'],
    desktopId: record['desktopId'],
    deviceToken: record['deviceToken'] as string | null,
    code: record['code'],
    expiresAt: record['expiresAt']
  }
}

export class RemoteModeController {
  private readonly keepAlive: KeepAliveSession = createKeepAliveSession()
  private gateway: RemoteGateway | null = null
  private tray: RemoteTray | null = null
  private readonly lanPort: number
  private readonly localPort: number
  private readonly peerSecret: string | null
  private resolvedPeerSecret: string | null = null
  private readonly staticRoot: string
  private readonly iconPath: string
  private readonly rpc: RemoteRpcDispatcher | null
  private readonly storage: import('../storage-engine').StorageEngine | null
  private readonly onSessionActiveChange?: (active: boolean) => void
  private readonly cloudApiOrigin: string | null = resolveCloudApiOrigin()
  private readonly vault: SecretVault | null
  private cloudConfig: CloudAccessConfig | null = null
  private cloudRelay: CloudRelayClient | null = null
  private cloudPollTimer: ReturnType<typeof setTimeout> | null = null
  private cloudAbortController: AbortController | null = null
  private cloudStatus: RemoteCloudStatus
  /** Connected devices, newest first (source of truth = the gateway). */
  private devices: RemoteDeviceInfo[] = []
  /** Persisted device-name overrides, keyed by device id. */
  private deviceNames: Record<string, string> = {}

  constructor(options: RemoteModeOptions) {
    this.lanPort = options.lanPort
    this.localPort = options.localPort
    this.peerSecret = options.peerSecret
    this.staticRoot = options.staticRoot
    this.iconPath = options.iconPath
    this.rpc = options.rpc ?? null
    this.storage = options.storage ?? null
    this.vault = this.storage ? new SecretVault(this.storage) : null
    this.onSessionActiveChange = options.onSessionActiveChange
    this.cloudStatus = {
      configured: this.cloudApiOrigin !== null,
      state: 'disabled',
      apiOrigin: this.cloudApiOrigin,
      desktopId: null,
      enrollmentCode: null,
      enrollmentExpiresAt: null,
      lastError: null
    }
  }

  /** Load persisted device names so renames survive restarts. */
  private async loadDeviceNames(): Promise<void> {
    if (!this.storage) return
    try {
      this.deviceNames = await readRemoteDeviceNames(this.storage)
    } catch (error) {
      Logger.error('Could not load remote device names:', error)
    }
  }

  /**
   * Restore remote mode at startup if it was enabled before the app quit, so a
   * desktop restart never silently breaks the phone connection. Only starts the
   * gateway + keep-alive (and Tray); it never hides the freshly opened window.
   */
  async restoreRemoteMode(): Promise<void> {
    if (this.remoteModeActive) return
    const enabled = await this.readPersistedEnabled()
    if (!enabled) return
    await this.loadDeviceNames()
    this.keepAlive.dispatch({ type: 'arm' })
    await this.startGateway()
    await this.restoreCloudAccess()
    this.ensureTray()
    this.syncTray()
    this.broadcast()
    Logger.info('Remote mode restored from previous session')
  }

  /** Persist the enabled flag so a restart restores the gateway. */
  private async persistEnabled(enabled: boolean): Promise<void> {
    try {
      if (this.storage) await writeRemoteModeState(this.storage, enabled)
    } catch (error) {
      Logger.error('Could not persist remote-mode state:', error)
    }
  }

  private async readPersistedEnabled(): Promise<boolean> {
    if (!this.storage) return false
    return readRemoteModeState(this.storage)
  }

  /**
   * Resolve the peer auth secret used by the gateway.
   *
   * A `PEER_SECRET_AUTH` environment value always wins. When none is supplied
   * (the human-friendly LAN case), a random secret is generated once and
   * persisted under the app user-data dir so pairing stays stable across
   * restarts. The QR pairing URL embeds this secret.
   */
  private async resolvePeerSecret(): Promise<string | null> {
    if (this.peerSecret) {
      this.resolvedPeerSecret = this.peerSecret
      return this.peerSecret
    }
    if (this.resolvedPeerSecret !== null) return this.resolvedPeerSecret
    try {
      this.resolvedPeerSecret = await loadOrCreatePeerSecret(
        join(app.getPath('userData'), 'remote-gateway')
      )
      return this.resolvedPeerSecret
    } catch (error) {
      Logger.error('Could not load or create the remote peer secret:', error)
      return null
    }
  }

  get status(): RemoteModeStatus {
    return {
      remoteMode: this.keepAlive.phase !== 'IDLE',
      phase: this.keepAlive.phase,
      blockedQuit: this.keepAlive.blockedQuit,
      gateway: this.gateway?.info() ?? {
        listening: false,
        port: this.lanPort,
        url: null,
        pairingUrl: null
      },
      cloud: { ...this.cloudStatus },
      devices: this.devices
    }
  }

  get remoteModeActive(): boolean {
    return this.keepAlive.phase !== 'IDLE'
  }

  /** Start remote mode: arm keep-alive, launch the gateway, show the Tray. */
  toggleRemoteMode(enabled: boolean): RemoteModeStatus {
    if (enabled && !this.remoteModeActive) {
      this.keepAlive.dispatch({ type: 'arm' })
      void this.startGateway().then(() => this.restoreCloudAccess())
      this.ensureTray()
      void this.persistEnabled(true)
      Logger.info('Remote mode enabled')
    } else if (!enabled && this.remoteModeActive) {
      this.keepAlive.dispatch({ type: 'disarm' })
      void this.gateway?.stop()
      this.gateway = null
      this.tray?.destroy()
      this.tray = null
      this.onSessionActiveChange?.(false)
      this.stopCloudAccess()
      void this.persistEnabled(false)
      Logger.info('Remote mode disabled')
    }
    this.syncTray()
    this.broadcast()
    return this.status
  }

  /**
   * Ensure the LAN gateway is listening, without toggling the keep-alive/Tray
   * remote-mode behavior. Called when the user opens Settings → Remote so the
   * QR pairing code is immediately scannable. Idempotent.
   */
  async ensureGateway(): Promise<RemoteModeStatus> {
    if (!this.gateway && this.staticRoot) {
      await this.startGateway()
    }
    this.syncTray()
    this.broadcast()
    return this.status
  }

  /** Called by the gateway whenever the connected device set changes. */
  onDevicesChange(devices: RemoteDeviceInfo[]): void {
    const wasLive = this.devices.length > 0
    this.devices = devices.map((device) => ({
      ...device,
      name: this.deviceNames[device.id] ?? device.name
    }))
    const isLive = this.devices.length > 0
    if (isLive && !wasLive) {
      this.keepAlive.dispatch({ type: 'sessionStart' })
      this.tray?.notify('Remote session started', 'Your phone is connected to this desktop.')
      this.installEventForwarder()
      this.onSessionActiveChange?.(true)
    } else if (!isLive && wasLive) {
      this.keepAlive.dispatch({ type: 'sessionEnd' })
      this.tray?.notify('Remote session ended', 'The phone disconnected from this desktop.')
      if (this.cloudStatus.state !== 'online') setRemoteEventForwarder(null)
      this.onSessionActiveChange?.(false)
    }
    this.syncTray()
    this.broadcast()
  }

  /** Rename a connected device; the override is persisted for reconnects. */
  async renameDevice(deviceId: string, name: string): Promise<RemoteModeStatus> {
    const trimmed = name.trim().slice(0, 100)
    if (trimmed.length === 0) throw new TypeError('Device name cannot be empty')
    this.deviceNames = { ...this.deviceNames, [deviceId]: trimmed }
    if (this.storage) {
      await writeRemoteDeviceName(this.storage, deviceId, trimmed)
    }
    this.devices = this.devices.map((device) =>
      device.id === deviceId ? { ...device, name: trimmed } : device
    )
    this.syncTray()
    this.broadcast()
    return this.status
  }

  /** Disconnect a connected device by id. */
  disconnectDevice(deviceId: string): void {
    this.gateway?.disconnectDevice(deviceId)
  }

  /** Forward live desktop events to every connected phone peer. */
  private installEventForwarder(): void {
    setRemoteEventForwarder((channel, payload) => {
      this.gateway?.sendToPeer({ rpc: 'event', channel, payload })
      void this.cloudRelay?.send({ rpc: 'event', channel, payload })
    })
  }

  /**
   * Tear everything down when the user closes the app: disconnect peers, stop
   * the gateway, destroy the Tray, disarm keep-alive, and release the
   * device-awake blocker. Closing the app must leave nothing alive.
   */
  async dispose(): Promise<void> {
    this.keepAlive.dispatch({ type: 'disarm' })
    setRemoteEventForwarder(null)
    this.stopCloudAccess()
    this.onSessionActiveChange?.(false)
    if (this.gateway) {
      const gateway = this.gateway
      this.gateway = null
      try {
        await gateway.stop()
      } catch (error) {
        Logger.error('Remote gateway stop failed during shutdown:', error)
      }
    }
    try {
      this.tray?.destroy()
    } catch (error) {
      Logger.error('Remote tray destroy failed during shutdown:', error)
    }
    this.tray = null
    this.devices = []
    Logger.info('Remote mode disposed')
  }

  registerIpc(): void {
    ipcMain.handle('remote:getStatus', (): RemoteModeStatus => this.status)
    ipcMain.handle('remote:ensureGateway', (): Promise<RemoteModeStatus> => this.ensureGateway())
    ipcMain.handle(
      'remote:toggle',
      (_event: IpcMainInvokeEvent, enabled: boolean): RemoteModeStatus => {
        return this.toggleRemoteMode(Boolean(enabled))
      }
    )
    ipcMain.handle(
      'remote:listDevices',
      (): RemoteDeviceInfo[] => this.gateway?.listDevices() ?? []
    )
    ipcMain.handle(
      'remote:disconnectDevice',
      (_event: IpcMainInvokeEvent, deviceId: string): void => {
        this.disconnectDevice(typeof deviceId === 'string' ? deviceId : '')
      }
    )
    ipcMain.handle(
      'remote:renameDevice',
      (_event: IpcMainInvokeEvent, deviceId: string, name: string): Promise<RemoteModeStatus> => {
        return this.renameDevice(typeof deviceId === 'string' ? deviceId : '', String(name))
      }
    )
    ipcMain.handle('remote:beginCloudEnrollment', (): Promise<RemoteModeStatus> => {
      return this.beginCloudEnrollment()
    })
    ipcMain.handle('remote:resetCloudEnrollment', (): Promise<RemoteModeStatus> => {
      return this.resetCloudEnrollment()
    })
  }

  async beginCloudEnrollment(): Promise<RemoteModeStatus> {
    if (!this.cloudApiOrigin) throw new Error('REMOTE_API_ORIGIN is not configured')
    if (!this.storage || !this.vault) throw new Error('Secure desktop storage is unavailable')
    if (!this.vault.isAvailable()) throw new Error('OS credential encryption is unavailable')
    if (!(await this.resolvePeerSecret())) throw new Error('Remote control secret is unavailable')

    const previous =
      this.cloudConfig ?? (await this.storage.read<CloudAccessConfig>(CLOUD_CONFIG_PATH))
    const existingToken = previous?.tokenRef ? await this.vault.resolve(previous.tokenRef) : null

    this.stopCloudAccess()
    this.cloudAbortController = new AbortController()
    this.cloudStatus = {
      ...this.cloudStatus,
      state: 'connecting',
      lastError: null,
      enrollmentCode: null,
      enrollmentExpiresAt: null
    }
    this.broadcast()

    const response = await fetchWithDeadline(
      new URL('/v1/device-enrollments', this.cloudApiOrigin),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(existingToken ? { Authorization: `Bearer ${existingToken}` } : {})
        },
        body: JSON.stringify({
          name: hostname(),
          platform: platform(),
          lanEndpoint: this.gateway?.info().url ?? null
        })
      },
      CLOUD_REQUEST_TIMEOUT_MS,
      this.cloudAbortController?.signal
    )
    if (!response.ok) {
      this.cloudStatus = { ...this.cloudStatus, state: 'error', lastError: 'Enrollment failed' }
      this.broadcast()
      throw new Error('Cloud desktop enrollment failed')
    }
    const payload = parseEnrollmentResponse(await response.json())
    if (!payload) throw new Error('Cloud service returned an invalid enrollment response')

    const deviceToken = payload.deviceToken ?? existingToken
    if (!deviceToken) throw new Error('Cloud service did not issue a desktop credential')
    const tokenRef = await this.vault.save(deviceToken, previous?.tokenRef)
    this.cloudConfig = {
      apiOrigin: this.cloudApiOrigin,
      desktopId: payload.desktopId,
      enrollmentId: payload.enrollmentId,
      tokenRef,
      enrollmentExpiresAt: payload.expiresAt
    }
    await this.storage.write(CLOUD_CONFIG_PATH, this.cloudConfig)
    if (!this.remoteModeActive) this.toggleRemoteMode(true)
    this.cloudStatus = {
      configured: true,
      state: 'enrollment-pending',
      apiOrigin: this.cloudApiOrigin,
      desktopId: payload.desktopId,
      enrollmentCode: payload.code,
      enrollmentExpiresAt: payload.expiresAt,
      lastError: null
    }
    this.scheduleEnrollmentPoll(0)
    this.broadcast()
    return this.status
  }

  async resetCloudEnrollment(): Promise<RemoteModeStatus> {
    const config =
      this.cloudConfig ?? (await this.storage?.read<CloudAccessConfig>(CLOUD_CONFIG_PATH)) ?? null
    if (config && this.vault) {
      const token = await this.vault.resolve(config.tokenRef)
      const response = await fetchWithDeadline(
        new URL(`/v1/device-enrollments/${encodeURIComponent(config.desktopId)}`, config.apiOrigin),
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
        CLOUD_REQUEST_TIMEOUT_MS,
        this.cloudAbortController?.signal
      )
      if (!response.ok && response.status !== 404) {
        throw new Error('Could not revoke desktop access from the remote service')
      }
    }
    this.stopCloudAccess()
    if (config?.tokenRef && this.vault) {
      await this.vault.remove(config.tokenRef)
    }
    if (this.storage) await this.storage.remove(CLOUD_CONFIG_PATH)
    this.cloudConfig = null
    this.cloudStatus = {
      configured: this.cloudApiOrigin !== null,
      state: 'disabled',
      apiOrigin: this.cloudApiOrigin,
      desktopId: null,
      enrollmentCode: null,
      enrollmentExpiresAt: null,
      lastError: null
    }
    this.broadcast()
    return this.status
  }

  private async restoreCloudAccess(): Promise<void> {
    if (!this.remoteModeActive || !this.storage || !this.vault || !this.cloudApiOrigin) return
    const config = await this.storage.read<CloudAccessConfig>(CLOUD_CONFIG_PATH)
    if (!config || config.apiOrigin !== this.cloudApiOrigin) return
    this.cloudConfig = config
    this.cloudStatus = {
      ...this.cloudStatus,
      state: 'connecting',
      desktopId: config.desktopId,
      enrollmentExpiresAt: config.enrollmentExpiresAt,
      lastError: null
    }
    this.broadcast()
    await this.checkEnrollmentStatus()
  }

  private scheduleEnrollmentPoll(delayMs: number): void {
    if (this.cloudPollTimer) clearTimeout(this.cloudPollTimer)
    this.cloudPollTimer = setTimeout(() => void this.checkEnrollmentStatus(), delayMs)
  }

  private async checkEnrollmentStatus(): Promise<void> {
    const config = this.cloudConfig
    if (!config || !this.vault || !this.remoteModeActive) return
    if (!this.cloudAbortController) this.cloudAbortController = new AbortController()
    try {
      const token = await this.vault.resolve(config.tokenRef)
      const response = await fetchWithDeadline(
        new URL(
          `/v1/device-enrollments/${encodeURIComponent(config.desktopId)}/status`,
          config.apiOrigin
        ),
        { headers: { Authorization: `Bearer ${token}` } },
        CLOUD_REQUEST_TIMEOUT_MS,
        this.cloudAbortController?.signal
      )
      if (!response.ok) throw new Error('Enrollment status rejected')
      const payload = (await response.json()) as Record<string, unknown>
      if (payload['revoked'] === true) {
        this.cloudStatus = { ...this.cloudStatus, state: 'error', lastError: 'Desktop revoked' }
        this.broadcast()
        return
      }
      if (payload['claimed'] === true) {
        this.cloudStatus = {
          ...this.cloudStatus,
          state: 'connecting',
          enrollmentCode: null,
          lastError: null
        }
        if (payload['grantReady'] !== true) {
          const mobileDeviceId = payload['mobileDeviceId']
          const mobilePublicKey = payload['mobilePublicKey']
          const controlSecret = this.resolvedPeerSecret ?? (await this.resolvePeerSecret())
          if (
            typeof mobileDeviceId !== 'string' ||
            typeof mobilePublicKey !== 'object' ||
            mobilePublicKey === null ||
            !controlSecret
          ) {
            throw new Error('Enrollment grant request is invalid')
          }
          const grant = await createDesktopControlGrant({
            desktopId: config.desktopId,
            mobileDeviceId,
            mobilePublicKey: mobilePublicKey as JsonWebKey,
            controlSecret
          })
          const grantResponse = await fetch(
            new URL(
              `/v1/device-enrollments/${encodeURIComponent(config.desktopId)}/grant`,
              config.apiOrigin
            ),
            {
              method: 'PUT',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                mobileDeviceId,
                desktopPublicKey: grant.desktopPublicKey,
                ciphertext: grant.ciphertext
              })
            }
          )
          if (!grantResponse.ok) throw new Error('Control grant upload failed')
        }
        this.connectCloudRelay(token)
        return
      }
      if (Date.now() >= config.enrollmentExpiresAt) {
        this.cloudStatus = { ...this.cloudStatus, state: 'error', lastError: 'Enrollment expired' }
        this.broadcast()
        return
      }
      this.cloudStatus = { ...this.cloudStatus, state: 'enrollment-pending' }
      this.broadcast()
      this.scheduleEnrollmentPoll(2_000)
    } catch (error) {
      Logger.error('Remote cloud enrollment status failed:', error)
      this.cloudStatus = { ...this.cloudStatus, state: 'offline', lastError: 'Service unreachable' }
      this.broadcast()
      this.scheduleEnrollmentPoll(5_000)
    }
  }

  private connectCloudRelay(deviceToken: string): void {
    const config = this.cloudConfig
    const controlSecret = this.resolvedPeerSecret
    if (!config || !controlSecret || !this.rpc || this.cloudRelay) return
    if (!this.cloudAbortController) this.cloudAbortController = new AbortController()
    const signal = this.cloudAbortController.signal
    const relay = new CloudRelayClient({
      apiOrigin: config.apiOrigin,
      deviceToken,
      controlSecret,
      signal,
      connectTimeoutMs: remoteEnvInt('RELAY_CONNECT_TIMEOUT_MS', 15_000),
      authTimeoutMs: remoteEnvInt('RELAY_AUTH_TIMEOUT_MS', 10_000),
      requestTimeoutMs: remoteEnvInt('RELAY_REQUEST_TIMEOUT_MS', 30_000),
      queueLimit: remoteEnvInt('RELAY_QUEUE_LIMIT', 1_000),
      replayLimit: remoteEnvInt('RELAY_REPLAY_LIMIT', 4_096),
      // The client owns reconnection: full-jitter backoff that preserves its
      // bounded outbound queue across socket drops (same-client reconnect).
      reconnect: {
        initialDelayMs: remoteEnvInt('RELAY_RECONNECT_BASE_MS', 1_000),
        maxDelayMs: remoteEnvInt('RELAY_RECONNECT_MAX_MS', 30_000)
      },
      onAuthenticated: () => {
        this.cloudStatus = { ...this.cloudStatus, state: 'online', lastError: null }
        this.installEventForwarder()
        this.broadcast()
      },
      onDisconnected: (reason) => {
        if (this.cloudRelay !== relay) return
        this.cloudStatus = { ...this.cloudStatus, state: 'offline', lastError: reason }
        this.broadcast()
      },
      onRpc: async (channel, args) =>
        this.rpc?.dispatch({ id: 0, channel, args }) ?? {
          ok: false,
          message: 'RPC unavailable'
        }
    })
    this.cloudRelay = relay
    relay.connect()
  }

  private stopCloudAccess(): void {
    if (this.cloudPollTimer) clearTimeout(this.cloudPollTimer)
    this.cloudPollTimer = null
    // Cancel any in-flight enrollment/status request and abort the relay
    // connection so nothing survives a remote-mode toggle or app shutdown.
    this.cloudAbortController?.abort()
    this.cloudAbortController = null
    this.cloudRelay?.close()
    this.cloudRelay = null
    if (this.devices.length === 0) setRemoteEventForwarder(null)
    if (this.cloudStatus.state !== 'disabled') {
      this.cloudStatus = { ...this.cloudStatus, state: 'offline' }
    }
  }

  private async startGateway(): Promise<void> {
    if (this.gateway) return
    if (!this.staticRoot) {
      Logger.error('Remote gateway not started: renderer static root is not set')
      return
    }
    await this.loadDeviceNames()
    const peerSecret = await this.resolvePeerSecret()
    const gateway = new RemoteGateway({
      port: this.lanPort,
      localPort: this.localPort,
      peerSecret,
      certificateDir: join(app.getPath('userData'), 'remote-gateway'),
      staticRoot: this.staticRoot,
      allowedOrigins: this.cloudApiOrigin ? [new URL(this.cloudApiOrigin).origin] : [],
      handlers: {
        onDevicesChange: (devices) => this.onDevicesChange(devices),
        onRpc: this.rpc
          ? async (channel, args) =>
              this.rpc?.dispatch({ id: 0, channel, args }) ?? {
                ok: false,
                message: 'RPC unavailable'
              }
          : undefined
      }
    })
    this.gateway = gateway
    try {
      await gateway.start()
      this.syncTray()
      this.broadcast()
    } catch (error: unknown) {
      Logger.error('Remote gateway failed to start:', error)
      this.gateway = null
      this.broadcast()
    }
  }

  private ensureTray(): void {
    if (this.tray) return
    if (!this.iconPath) return
    this.tray = createRemoteTray(this.iconPath, {
      onToggle: (enabled) => {
        this.toggleRemoteMode(enabled)
      },
      onQuit: () => {
        // Closing the app always fully quits — nothing is kept alive.
        return true
      },
      onRestore: () => this.restoreWindow()
    })
    this.syncTray()
  }

  private syncTray(): void {
    this.tray?.refresh(this.status)
  }

  private restoreWindow(): void {
    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }
  }

  private broadcast(): void {
    const status = this.status
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('remote:status', status)
      }
    }
  }
}
