/**
 * Remote-mode controller (main process).
 *
 * Owns the keep-alive session, the LAN gateway, and the system Tray, and wires
 * quit interception so the desktop stays alive while the user is away. This is
 * the production `TrayHost`/`KeepAliveSession` wiring for the renderer-side
 * modules: the plain `keep-alive.ts` state machine is shared with the renderer
 * via `src/renderer/lib/remote/keep-alive.ts`.
 */

import { app, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { join } from 'node:path'
import { hostname, platform } from 'node:os'
import { Logger } from '../system/logger'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { SecretVault } from '../storage/secret-vault'
import { CloudRelayClient } from './cloud-relay-client'
import { createDesktopControlGrant } from './control-grant'
import { RemoteGateway } from './remote-gateway'
import { remoteWebPush } from './web-push-service'
import { createRemoteTray, type RemoteTray } from './remote-tray'
import type { RemoteCloudStatus, RemoteDeviceInfo, RemoteModeStatus } from './remote-types'
import type {
  AccountAuthProvider,
  AccountProfileState,
  AccountProfileSyncPayload,
  AccountSignInStart,
  MemoryEntry
} from '../../lib/types'
import { createKeepAliveSession, type KeepAliveSession } from '../../renderer/lib/remote/keep-alive'
import {
  PAIRING_TTL_MS,
  loadOrCreatePeerSecret,
  rotatePeerSecret,
  writePairingExpiry
} from './peer-secret'
import { RemoteRpcDispatcher } from './remote-rpc'
import { DeviceCredentialService, type EnrolledDevice } from './device-credential-service'
import type { AccountProfileRepo } from '../database/repositories/account-profile-repo'
import { setRemoteEventForwarder } from './remote-event-forwarder'
import { readRemoteModeState, writeRemoteModeState } from './remote-state'
import { RemoteAccountSession } from './remote-mode/remote-mode-account'
import { createLanDeviceAuthenticator } from './remote-mode/remote-mode-gateway-auth'
import {
  ACCOUNT_CONFIG_PATH,
  CLOUD_CONFIG_PATH,
  CLOUD_ENROLLMENT_RETRY_INITIAL_MS,
  CLOUD_ENROLLMENT_RETRY_MAX_MS,
  CLOUD_REQUEST_TIMEOUT_MS,
  CloudRequestCancelledError,
  cloudResponseIsTerminal,
  cloudRetryAfterMs,
  enrollmentFailureMessage,
  fetchWithDeadline,
  parseEnrollmentResponse,
  resolveAccountAuthOrigin,
  resolveCloudApiOrigin,
  type AccountSessionConfig,
  type CloudAccessConfig
} from './remote-mode/remote-mode-cloud-protocol'

export interface RemoteModeOptions {
  lanPort: number
  localPort: number
  peerSecret: string | null
  staticRoot: string
  iconPath: string
  /** Optional remote RPC dispatcher that serves the phone chat client. */
  rpc?: RemoteRpcDispatcher | null
  /** Optional storage used to persist the remote-mode flag across restarts. */
  storage?: import('../storage/storage-engine').StorageEngine | null
  /** Device credential service backing per-device identity and revocation. */
  credentials?: DeviceCredentialService | null
  /** SQLite repository used to cache the validated account profile locally. */
  accountProfileRepo?: AccountProfileRepo | null
  /**
   * Called whenever the live remote-session state changes (a phone connects or
   * disconnects). Lets the host keep the device awake while a session is live.
   */
  onSessionActiveChange?: (active: boolean) => void
  /** Supplies local usage and global memory for authenticated profile sync. */
  loadAccountProfileData?: () => Promise<AccountProfileSyncPayload>
  /** Applies the merged cloud memory snapshot to local global memory. */
  applyGlobalMemories?: (entries: MemoryEntry[]) => Promise<void>
  /** True only for the process elected to own shared remote transports. */
  canOwnTransport?: () => boolean
}

export const DEFAULT_LAN_PORT = 4455
const REMOTE_SUSPENSION_GRACE_MS = 5 * 60 * 1_000

/** Read a positive integer env var, falling back to `fallback`. */
export function remoteEnvInt(name: string, fallback: number): number {
  const value = process.env[name]
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Resolve the shared peer auth secret for the gateway, if configured. */
export function remotePeerSecret(): string | null {
  return process.env['PEER_SECRET_AUTH'] ?? process.env['VITE_PEER_SECRET_AUTH'] ?? null
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
  private readonly storage: import('../storage/storage-engine').StorageEngine | null
  private readonly credentials: DeviceCredentialService | null
  private readonly onSessionActiveChange?: (active: boolean) => void
  private readonly loadAccountProfileData?: () => Promise<AccountProfileSyncPayload>
  private readonly canOwnTransport: () => boolean
  private readonly cloudApiOrigin: string | null = resolveCloudApiOrigin()
  private readonly accountAuthOrigin: string | null = resolveAccountAuthOrigin()
  private readonly vault: SecretVault | null
  private readonly account: RemoteAccountSession
  private cloudConfig: CloudAccessConfig | null = null
  private cloudRelay: CloudRelayClient | null = null
  private cloudEventSendQueue: Promise<void> = Promise.resolve()
  private cloudPollTimer: ReturnType<typeof setTimeout> | null = null
  private cloudProfileSyncTimer: ReturnType<typeof setTimeout> | null = null
  private cloudAbortController: AbortController | null = null
  private cloudPollGeneration = 0
  private cloudPollRunningGeneration: number | null = null
  private cloudPollFailureCount = 0
  private cloudStatus: RemoteCloudStatus
  /** Phone whose claimed code is still completing grant delivery + relay device auth. */
  private pendingCloudDeviceId: string | null = null
  /** Desktop credential currently authenticated through the cloud relay. */
  private cloudConnectedDeviceId: string | null = null
  /** Phones that explicitly opened the remote workspace, not merely paired. */
  private readonly activeWorkspaceDeviceIds = new Set<string>()
  /**
   * A mobile browser may drop its socket as soon as it is backgrounded. Keep
   * that logical workspace live briefly so a foreground resume can replace the
   * transport without emitting a false session-end transition or releasing the
   * desktop wake blocker immediately.
   */
  private readonly suspendedDeviceIds = new Set<string>()
  private readonly suspensionGraceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Connected devices, newest first (source of truth = the gateway). */
  private devices: RemoteDeviceInfo[] = []

  constructor(options: RemoteModeOptions) {
    this.lanPort = options.lanPort
    this.localPort = options.localPort
    this.peerSecret = options.peerSecret
    this.staticRoot = options.staticRoot
    this.iconPath = options.iconPath
    this.rpc = options.rpc ?? null
    this.storage = options.storage ?? null
    this.credentials = options.credentials ?? null
    this.vault = this.storage ? new SecretVault(this.storage) : null
    this.account = new RemoteAccountSession({
      storage: this.storage,
      vault: this.vault,
      accountProfileRepo: options.accountProfileRepo ?? null,
      cloudApiOrigin: this.cloudApiOrigin,
      accountAuthOrigin: this.accountAuthOrigin,
      loadAccountProfileData: options.loadAccountProfileData,
      applyGlobalMemories: options.applyGlobalMemories,
      getCloudConfig: () => this.cloudConfig,
      getAbortSignal: () => this.cloudAbortController?.signal,
      isEnrollmentPending: () => this.cloudStatus.state === 'enrollment-pending'
    })
    this.onSessionActiveChange = options.onSessionActiveChange
    this.loadAccountProfileData = options.loadAccountProfileData
    this.canOwnTransport = options.canOwnTransport ?? (() => true)
    this.cloudStatus = {
      configured: this.cloudApiOrigin !== null,
      state: 'disabled',
      apiOrigin: this.cloudApiOrigin,
      desktopId: null,
      enrollmentCode: null,
      enrollmentExpiresAt: null,
      lastError: null
    }
    this.refreshDevices(new Set())
  }

  /**
   * Restore remote mode at startup if it was enabled before the app quit, so a
   * desktop restart never silently breaks the phone connection. Only starts the
   * gateway + keep-alive (and Tray); it never hides the freshly opened window.
   */
  async restoreRemoteMode(): Promise<void> {
    if (!this.canOwnTransport()) return
    if (this.remoteModeActive) return
    const enabled = await this.readPersistedEnabled()
    if (!enabled) return
    const restoreLan = this.hasRestorableLanEnrollment()
    const restoreCloud = await this.hasRestorableCloudEnrollment()
    if (!restoreLan && !restoreCloud) {
      await this.persistEnabled(false)
      return
    }
    this.keepAlive.dispatch({ type: 'arm' })
    this.credentials?.startPeriodicMaintenance()
    if (restoreCloud) {
      await this.resolvePeerSecret()
      await this.restoreCloudAccess()
    }
    if (restoreLan) await this.startGateway(false)
    if (!this.remoteModeActive) return
    this.ensureTray()
    this.syncTray()
    this.broadcast()
    Logger.info('Remote mode restored from previous session')
  }

  private hasRestorableLanEnrollment(): boolean {
    return (
      this.credentials
        ?.listActiveDevices()
        .some((device) => this.credentials?.isDeviceActive(device.deviceId, device.authVersion)) ===
      true
    )
  }

  private async hasRestorableCloudEnrollment(): Promise<boolean> {
    if (!this.storage || !this.vault || !this.cloudApiOrigin) return false
    const config = await this.storage.read<CloudAccessConfig>(CLOUD_CONFIG_PATH)
    if (!config || config.apiOrigin !== this.cloudApiOrigin) return false
    try {
      const token = await this.vault.resolve(config.tokenRef)
      if (!token) return false
      this.cloudConfig = config
      return true
    } catch {
      return false
    }
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
   * persisted under the app user-data dir so account-backed LAN encryption is
   * stable across restarts.
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

  /** Keep a short-lived enrollment window around the stable transport key. */
  private async syncPairingState(): Promise<void> {
    const directory = join(app.getPath('userData'), 'remote-gateway')
    const secret = this.resolvedPeerSecret
    if (!secret) return
    const expiresAt = Date.now() + PAIRING_TTL_MS
    if (!this.peerSecret) await writePairingExpiry(directory, expiresAt)
    if (this.credentials) {
      await this.credentials.registerPairingValue(secret, { expiresAt })
    }
  }

  /** Rotate the pairing bootstrap after relay enrollment (see cloud-rotation contract test). */
  async rotatePairingBootstrap(): Promise<void> {
    if (this.peerSecret) return
    const directory = join(app.getPath('userData'), 'remote-gateway')
    const newSecret = await rotatePeerSecret(directory)
    this.resolvedPeerSecret = newSecret
    if (this.credentials) {
      await this.credentials.registerPairingValue(newSecret, {
        expiresAt: Date.now() + PAIRING_TTL_MS
      })
    }
    if (this.gateway) {
      try {
        await this.gateway.stop()
      } catch (error) {
        Logger.dev('Gateway stop during rotation failed:', error)
      }
      this.gateway = null
      await this.startGateway()
    }
    this.broadcast()
  }

  get status(): RemoteModeStatus {
    const gateway = this.gateway?.info() ?? {
      listening: false,
      port: this.lanPort,
      url: null,
      urls: []
    }
    return {
      remoteMode: this.keepAlive.phase !== 'IDLE',
      phase: this.keepAlive.phase,
      blockedQuit: this.keepAlive.blockedQuit,
      gateway,
      cloud: { ...this.cloudStatus },
      devices: this.devices
    }
  }

  get remoteModeActive(): boolean {
    return this.keepAlive.phase !== 'IDLE'
  }

  /**
   * Stop this process's transports without changing the shared persisted
   * preference. A newer app process can then restore the same enrollment and
   * become the sole RPC executor.
   */
  async relinquishTransportOwnership(): Promise<void> {
    if (!this.remoteModeActive) return
    this.keepAlive.dispatch({ type: 'disarm' })
    const gateway = this.gateway
    this.gateway = null
    this.tray?.destroy()
    this.tray = null
    this.clearSuspensionGrace()
    this.activeWorkspaceDeviceIds.clear()
    this.onSessionActiveChange?.(false)
    this.stopCloudAccess()
    this.credentials?.stopPeriodicMaintenance()
    if (gateway) {
      try {
        await gateway.stop()
      } catch (error) {
        Logger.error('Remote gateway stop failed during transport handoff:', error)
      }
    }
    this.syncTray()
    this.broadcast()
    Logger.info('Remote transport handed to a newer CodeInOven instance')
  }

  /** Start remote mode: arm keep-alive, launch the gateway, show the Tray. */
  toggleRemoteMode(enabled: boolean): RemoteModeStatus {
    if (enabled && !this.canOwnTransport()) return this.status
    if (enabled && !this.remoteModeActive) {
      this.keepAlive.dispatch({ type: 'arm' })
      this.credentials?.startPeriodicMaintenance()
      // Cloud is the primary route. An occupied/blocked optional LAN port must
      // never delay desktop relay restoration or first-time remote access.
      void this.restoreCloudAccess()
      void this.startGateway()
      this.ensureTray()
      void this.persistEnabled(true)
      Logger.info('Remote mode enabled')
    } else if (!enabled && this.remoteModeActive) {
      this.keepAlive.dispatch({ type: 'disarm' })
      void this.gateway?.stop()
      this.gateway = null
      this.tray?.destroy()
      this.tray = null
      this.clearSuspensionGrace()
      this.activeWorkspaceDeviceIds.clear()
      this.onSessionActiveChange?.(false)
      this.stopCloudAccess()
      this.credentials?.stopPeriodicMaintenance()
      void this.persistEnabled(false)
      Logger.info('Remote mode disabled')
    }
    this.syncTray()
    this.broadcast()
    return this.status
  }

  /** Status-only compatibility endpoint. Viewing Remote settings must stay cold. */
  async ensureGateway(): Promise<RemoteModeStatus> {
    this.syncTray()
    this.broadcast()
    return this.status
  }

  /** Called by the gateway whenever the connected device set changes. */
  onDevicesChange(devices: RemoteDeviceInfo[]): void {
    const connectedIds = new Set(devices.map((device) => device.id))
    if (this.cloudConnectedDeviceId) connectedIds.add(this.cloudConnectedDeviceId)
    this.reconcileDeviceConnections(connectedIds)
    this.syncTray()
    this.broadcast()
  }

  /** Actual transport identities, excluding suspension-grace leases. */
  private connectedTransportDeviceIds(): Set<string> {
    const connectedIds = new Set(this.gateway?.listDevices().map((device) => device.id) ?? [])
    if (this.cloudConnectedDeviceId) connectedIds.add(this.cloudConnectedDeviceId)
    return connectedIds
  }

  /**
   * Merge physical transport presence with short logical-session leases. A
   * lease is only created for a phone that explicitly opened the workspace;
   * paired-but-idle phones and explicit disconnects still end immediately.
   */
  private reconcileDeviceConnections(
    connectedTransportIds: Set<string>,
    allowSuspensionGrace = true
  ): void {
    const wasLive = this.devices.some((device) => device.connected)
    for (const deviceId of connectedTransportIds) this.cancelSuspensionGrace(deviceId)
    if (allowSuspensionGrace) {
      for (const device of this.devices) {
        if (
          device.connected &&
          !connectedTransportIds.has(device.id) &&
          this.activeWorkspaceDeviceIds.has(device.id)
        ) {
          this.startSuspensionGrace(device.id)
        }
      }
    } else {
      for (const deviceId of [...this.suspendedDeviceIds]) {
        if (!connectedTransportIds.has(deviceId)) this.cancelSuspensionGrace(deviceId)
      }
    }
    const effectiveConnectedIds = new Set(connectedTransportIds)
    for (const deviceId of this.suspendedDeviceIds) effectiveConnectedIds.add(deviceId)
    this.refreshDevices(effectiveConnectedIds)
    this.reconcileSessionActivity(wasLive)
  }

  private startSuspensionGrace(deviceId: string): void {
    if (this.suspensionGraceTimers.has(deviceId)) return
    this.suspendedDeviceIds.add(deviceId)
    const timer = setTimeout(() => {
      this.suspensionGraceTimers.delete(deviceId)
      this.suspendedDeviceIds.delete(deviceId)
      this.activeWorkspaceDeviceIds.delete(deviceId)
      this.reconcileDeviceConnections(this.connectedTransportDeviceIds(), false)
      this.onSessionActiveChange?.(this.activeWorkspaceDeviceIds.size > 0)
      this.syncTray()
      this.broadcast()
    }, REMOTE_SUSPENSION_GRACE_MS)
    this.suspensionGraceTimers.set(deviceId, timer)
  }

  private cancelSuspensionGrace(deviceId: string): void {
    const timer = this.suspensionGraceTimers.get(deviceId)
    if (timer) clearTimeout(timer)
    this.suspensionGraceTimers.delete(deviceId)
    this.suspendedDeviceIds.delete(deviceId)
  }

  private clearSuspensionGrace(): void {
    for (const timer of this.suspensionGraceTimers.values()) clearTimeout(timer)
    this.suspensionGraceTimers.clear()
    this.suspendedDeviceIds.clear()
  }

  /** Reconcile keep-alive, power, tray notifications, and event forwarding. */
  private reconcileSessionActivity(wasLive: boolean): void {
    const isLive = this.devices.some((device) => device.connected)
    if (isLive && !wasLive) {
      this.keepAlive.dispatch({ type: 'sessionStart' })
      this.tray?.notify('Remote session started', 'Your phone is connected to this desktop.')
      this.installEventForwarder()
    } else if (!isLive && wasLive) {
      this.keepAlive.dispatch({ type: 'sessionEnd' })
      this.tray?.notify('Remote session ended', 'The phone disconnected from this desktop.')
      if (this.cloudStatus.state !== 'online') setRemoteEventForwarder(null)
    }
  }

  /** Keep power awake only after a connected phone explicitly opens the workspace. */
  private updateWorkspaceActivity(deviceId: string, active: boolean): void {
    if (active && this.devices.some((device) => device.id === deviceId && device.connected)) {
      this.activeWorkspaceDeviceIds.add(deviceId)
    } else {
      this.cancelSuspensionGrace(deviceId)
      this.activeWorkspaceDeviceIds.delete(deviceId)
    }
    this.onSessionActiveChange?.(this.activeWorkspaceDeviceIds.size > 0)
  }

  /** Rebuild the device list from the enrolled device records. */
  private refreshDevices(connectedIds: Set<string>): void {
    if (!this.credentials) {
      this.devices = []
      return
    }
    this.devices = this.credentials
      .listDevices()
      .map((device) => this.toDeviceInfo(device, connectedIds.has(device.deviceId)))
    let workspaceSetChanged = false
    for (const deviceId of this.activeWorkspaceDeviceIds) {
      if (connectedIds.has(deviceId)) continue
      this.activeWorkspaceDeviceIds.delete(deviceId)
      workspaceSetChanged = true
    }
    if (workspaceSetChanged) {
      this.onSessionActiveChange?.(this.activeWorkspaceDeviceIds.size > 0)
    }
  }

  /** Enrolled-device record → display-facing `RemoteDeviceInfo`. */
  private toDeviceInfo(device: EnrolledDevice, connected: boolean): RemoteDeviceInfo {
    return {
      id: device.deviceId,
      name: device.name,
      connectedAt: device.lastUsedAt ?? device.createdAt,
      transport: device.lastTransport,
      connected,
      scopes: device.scopes,
      fingerprint: device.publicKeyFingerprint,
      lastUsedAt: device.lastUsedAt,
      expiresAt: device.expiresAt,
      credentialExpiresAt: device.credentialExpiresAt,
      revokedAt: device.revokedAt,
      authVersion: device.authVersion,
      allProjects: device.allProjects,
      projectIds: device.projectIds
    }
  }

  /** Rename an enrolled device. */
  async renameDevice(deviceId: string, name: string): Promise<RemoteModeStatus> {
    const trimmed = name.trim().slice(0, 100)
    if (trimmed.length === 0) throw new TypeError('Device name cannot be empty')
    if (!this.credentials?.renameDevice(deviceId, trimmed)) throw new Error('Device not found')
    this.devices = this.devices.map((device) =>
      device.id === deviceId ? { ...device, name: trimmed } : device
    )
    this.syncTray()
    this.broadcast()
    return this.status
  }

  /** Disconnect a connected device by id. */
  disconnectDevice(deviceId: string): void {
    this.cancelSuspensionGrace(deviceId)
    this.activeWorkspaceDeviceIds.delete(deviceId)
    this.onSessionActiveChange?.(this.activeWorkspaceDeviceIds.size > 0)
    const disconnected = this.gateway?.disconnectDevice(deviceId) ?? false
    if (!disconnected) {
      this.reconcileDeviceConnections(this.connectedTransportDeviceIds(), false)
      this.syncTray()
      this.broadcast()
    }
  }

  /**
   * Human revocation: durably marks the device revoked (tombstone + authVersion
   * bump), closes every live socket, and only then broadcasts the new list.
   */
  async revokeDevice(deviceId: string, reason: string): Promise<RemoteModeStatus> {
    if (!this.credentials) throw new Error('Device credential service is unavailable')
    const revoked = this.credentials.revokeDevice(deviceId, reason || 'operator')
    if (!revoked) throw new Error('Device not found')
    this.cancelSuspensionGrace(deviceId)
    this.activeWorkspaceDeviceIds.delete(deviceId)
    this.onSessionActiveChange?.(this.activeWorkspaceDeviceIds.size > 0)
    await remoteWebPush.removeDevice(deviceId)
    this.gateway?.disconnectDevice(deviceId)
    // Terminate any bound cloud relay session for this device immediately;
    // per-invoke revalidation also rejects it if a socket survives.
    if (this.cloudRelay?.boundDeviceId() === deviceId) {
      this.cloudConnectedDeviceId = null
      this.cloudRelay.close()
      this.cloudRelay = null
      this.cloudStatus = { ...this.cloudStatus, state: 'offline', lastError: 'device revoked' }
    }
    this.reconcileDeviceConnections(this.connectedTransportDeviceIds(), false)
    this.syncTray()
    this.broadcast()
    return this.status
  }

  /** Enrolled device records (including revoked), enriched with connection state. */
  listEnrolledDevices(): RemoteDeviceInfo[] {
    if (!this.credentials) return []
    const connectedIds = new Set(this.gateway?.listDevices().map((d) => d.id) ?? [])
    if (this.cloudConnectedDeviceId) connectedIds.add(this.cloudConnectedDeviceId)
    return this.credentials
      .listDevices()
      .map((device) => this.toDeviceInfo(device, connectedIds.has(device.deviceId)))
  }

  /** Trusted desktop step-up disposition for a pending high-risk request. */
  approveStepUp(approvalId: string, decision: 'approved' | 'rejected'): boolean {
    const resolved = this.rpc?.approveStepUp(approvalId, decision) ?? false
    this.broadcastPendingApprovals()
    return resolved
  }

  listPendingApprovals(): ReturnType<RemoteRpcDispatcher['listPendingApprovals']> {
    return this.rpc?.listPendingApprovals() ?? []
  }

  listAuditEvents(limit = 100): ReturnType<RemoteRpcDispatcher['listAuditEvents']> {
    return this.rpc?.listAuditEvents(limit) ?? []
  }

  /** Forward live desktop events to every connected phone peer. */
  private installEventForwarder(): void {
    setRemoteEventForwarder((channel, payload) => {
      this.gateway?.sendToPeer({ rpc: 'event', channel, payload })
      this.cloudEventSendQueue = this.cloudEventSendQueue
        .then(async () => {
          await this.cloudRelay?.send({ rpc: 'event', channel, payload })
        })
        .catch(() => undefined)
    })
  }

  /**
   * Tear everything down when the user closes the app: disconnect peers, stop
   * the gateway, destroy the Tray, disarm keep-alive, and release the
   * device-awake blocker. Closing the app must leave nothing alive.
   */
  async dispose(): Promise<void> {
    this.account.dispose()
    this.keepAlive.dispatch({ type: 'disarm' })
    setRemoteEventForwarder(null)
    this.stopCloudAccess()
    this.credentials?.stopPeriodicMaintenance()
    this.clearSuspensionGrace()
    this.activeWorkspaceDeviceIds.clear()
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
    ipcMain.handle('remote:listDevices', (): RemoteDeviceInfo[] => this.listEnrolledDevices())
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
    ipcMain.handle(
      'remote:revokeDevice',
      (_event: IpcMainInvokeEvent, deviceId: string, reason: string): Promise<RemoteModeStatus> => {
        return this.revokeDevice(typeof deviceId === 'string' ? deviceId : '', String(reason))
      }
    )
    ipcMain.handle(
      'remote:approveStepUp',
      (_event: IpcMainInvokeEvent, approvalId: string): boolean => {
        return this.approveStepUp(typeof approvalId === 'string' ? approvalId : '', 'approved')
      }
    )
    ipcMain.handle(
      'remote:rejectStepUp',
      (_event: IpcMainInvokeEvent, approvalId: string): boolean => {
        return this.approveStepUp(typeof approvalId === 'string' ? approvalId : '', 'rejected')
      }
    )
    ipcMain.handle(
      'remote:listPendingApprovals',
      (): ReturnType<RemoteRpcDispatcher['listPendingApprovals']> => this.listPendingApprovals()
    )
    ipcMain.handle(
      'remote:listAuditEvents',
      (
        _event: IpcMainInvokeEvent,
        limit: number
      ): ReturnType<RemoteRpcDispatcher['listAuditEvents']> =>
        this.listAuditEvents(typeof limit === 'number' ? limit : 100)
    )
    ipcMain.handle('remote:beginCloudEnrollment', (): Promise<RemoteModeStatus> => {
      return this.beginCloudEnrollment()
    })
    ipcMain.handle('remote:resetCloudEnrollment', (): Promise<RemoteModeStatus> => {
      return this.resetCloudEnrollment()
    })
    ipcMain.handle('account:getProfile', (): Promise<AccountProfileState> =>
      this.account.accountProfile()
    )
    ipcMain.handle(
      'account:beginSignIn',
      (_event: IpcMainInvokeEvent, provider: AccountAuthProvider): Promise<AccountSignInStart> =>
        this.account.beginAccountSignIn(provider)
    )
    ipcMain.handle('account:syncProfile', (): Promise<AccountProfileState> =>
      this.account.syncAccountProfile()
    )
    ipcMain.handle('account:signOut', (): Promise<void> => this.account.signOutAccount())
  }

  private scheduleAccountProfileSync(delayMs: number): void {
    if (!this.loadAccountProfileData) return
    if (this.cloudProfileSyncTimer) clearTimeout(this.cloudProfileSyncTimer)
    const generation = this.cloudPollGeneration
    this.cloudProfileSyncTimer = setTimeout(() => {
      this.cloudProfileSyncTimer = null
      if (generation !== this.cloudPollGeneration) return
      void this.account
        .syncAccountProfile()
        .catch((error) => Logger.dev('Account profile background sync unavailable:', error))
        .finally(() => {
          if (generation === this.cloudPollGeneration) {
            this.scheduleAccountProfileSync(5 * 60 * 1_000)
          }
        })
    }, delayMs)
  }

  async beginCloudEnrollment(): Promise<RemoteModeStatus> {
    if (!this.cloudApiOrigin) throw new Error('REMOTE_API_ORIGIN is not configured')
    if (!this.storage || !this.vault) throw new Error('Secure desktop storage is unavailable')
    if (!this.vault.isAvailable()) throw new Error('OS credential encryption is unavailable')
    if (!(await this.resolvePeerSecret())) throw new Error('Remote control secret is unavailable')

    // Open a fresh one-time enrollment window without rotating the transport
    // key already encrypted for approved phones. Rotating that shared key here
    // made every older cloud grant unusable whenever another phone was paired.
    await this.syncPairingState()

    const previous =
      this.cloudConfig ?? (await this.storage.read<CloudAccessConfig>(CLOUD_CONFIG_PATH))
    const storedAccountConfig =
      this.account.config ?? (await this.storage.read<AccountSessionConfig>(ACCOUNT_CONFIG_PATH))
    const accountConfig = storedAccountConfig
      ? await this.account.ensureFreshAccountToken(storedAccountConfig)
      : null
    const accountToken = accountConfig
      ? await this.vault.resolve(accountConfig.profileTokenRef)
      : null
    const existingDeviceToken = previous?.tokenRef
      ? await this.vault.resolve(previous.tokenRef)
      : null
    const authorizationToken = accountToken ?? existingDeviceToken
    if (!authorizationToken) throw new Error('Sign in before pairing this desktop')

    // Opening another pairing window must not stop the desktop relay or any
    // already authenticated phone. Invalidate only the previous enrollment poll.
    this.cloudPollGeneration += 1
    this.cloudPollRunningGeneration = null
    this.cloudPollFailureCount = 0
    this.pendingCloudDeviceId = null
    if (this.cloudPollTimer) clearTimeout(this.cloudPollTimer)
    this.cloudPollTimer = null
    if (!this.cloudAbortController) this.cloudAbortController = new AbortController()
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
          Authorization: `Bearer ${authorizationToken}`,
          ...(accountToken && existingDeviceToken
            ? { 'X-CodeInOven-Desktop-Token': existingDeviceToken }
            : {})
        },
        body: JSON.stringify({
          name: hostname(),
          platform: platform(),
          lanEndpoint: this.gateway?.info().url ?? null,
          lanEndpoints: this.gateway?.info().urls ?? []
        })
      },
      CLOUD_REQUEST_TIMEOUT_MS,
      this.cloudAbortController?.signal
    )
    if (!response.ok) {
      const message = await enrollmentFailureMessage(response)
      this.cloudStatus = { ...this.cloudStatus, state: 'error', lastError: message }
      this.broadcast()
      throw new Error(message)
    }
    const payload = parseEnrollmentResponse(await response.json())
    if (!payload) throw new Error('Cloud service returned an invalid enrollment response')

    const deviceToken = payload.deviceToken ?? existingDeviceToken
    if (!deviceToken) throw new Error('Cloud service did not issue a desktop credential')
    const tokenRef = await this.vault.save(deviceToken, previous?.tokenRef)
    const profileTokenRef = await this.vault.save(
      payload.profileToken,
      previous?.profileTokenRef ?? accountConfig?.profileTokenRef
    )
    await this.account.adoptConfig({
      apiOrigin: this.cloudApiOrigin,
      profileTokenRef,
      expiresAt: accountConfig?.expiresAt
    })
    this.cloudConfig = {
      apiOrigin: this.cloudApiOrigin,
      desktopId: payload.desktopId,
      enrollmentId: payload.enrollmentId,
      tokenRef,
      profileTokenRef,
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
        CLOUD_REQUEST_TIMEOUT_MS
      )
      if (!response.ok && response.status !== 404) {
        throw new Error('Could not cancel the pairing window')
      }
    }
    this.cloudPollGeneration += 1
    this.cloudPollRunningGeneration = null
    this.cloudPollFailureCount = 0
    this.pendingCloudDeviceId = null
    if (this.cloudPollTimer) clearTimeout(this.cloudPollTimer)
    this.cloudPollTimer = null
    this.cloudStatus = {
      ...this.cloudStatus,
      state: this.cloudRelay ? 'online' : 'connecting',
      enrollmentCode: null,
      enrollmentExpiresAt: null,
      lastError: null
    }
    if (!this.cloudRelay && config && this.vault) {
      const token = await this.vault.resolve(config.tokenRef)
      if (token) this.connectCloudRelay(token)
    }
    this.broadcast()
    return this.status
  }

  private async restoreCloudAccess(): Promise<void> {
    if (!this.remoteModeActive || !this.storage || !this.vault || !this.cloudApiOrigin) return
    const config = await this.storage.read<CloudAccessConfig>(CLOUD_CONFIG_PATH)
    if (!config || config.apiOrigin !== this.cloudApiOrigin) {
      Logger.info('Remote cloud relay not started: no enrolled desktop is saved')
      return
    }
    this.cloudConfig = config
    Logger.info('Remote cloud enrollment restored; checking desktop authorization')
    // Restoring credentials only starts a status check. Preserve the current
    // state until the service confirms the enrollment has actually been claimed.
    this.cloudStatus = {
      ...this.cloudStatus,
      desktopId: config.desktopId,
      enrollmentExpiresAt: config.enrollmentExpiresAt,
      lastError: null
    }
    this.broadcast()
    await this.checkEnrollmentStatus()
  }

  private scheduleEnrollmentPoll(delayMs: number): void {
    if (this.cloudPollTimer) clearTimeout(this.cloudPollTimer)
    const generation = this.cloudPollGeneration
    this.cloudPollTimer = setTimeout(() => {
      this.cloudPollTimer = null
      if (generation === this.cloudPollGeneration) void this.checkEnrollmentStatus()
    }, delayMs)
  }

  private nextEnrollmentRetryDelay(serverDelayMs: number | null): number {
    const exponent = Math.min(this.cloudPollFailureCount, 6)
    const exponentialDelay = Math.min(
      CLOUD_ENROLLMENT_RETRY_INITIAL_MS * 2 ** exponent,
      CLOUD_ENROLLMENT_RETRY_MAX_MS
    )
    this.cloudPollFailureCount += 1
    return Math.min(Math.max(exponentialDelay, serverDelayMs ?? 0), CLOUD_ENROLLMENT_RETRY_MAX_MS)
  }

  private async discardCloudEnrollment(lastError: string): Promise<void> {
    const config = this.cloudConfig
    this.stopCloudAccess()
    this.cloudConfig = null

    if (this.storage) {
      try {
        await this.storage.remove(CLOUD_CONFIG_PATH)
      } catch (error) {
        Logger.error('Could not remove rejected remote cloud enrollment:', error)
      }
    }
    if (config?.tokenRef && this.vault) {
      try {
        await this.vault.remove(config.tokenRef)
        // Keep the account credential so Profile and a new enrollment stay signed in.
      } catch (error) {
        Logger.error('Could not remove rejected remote cloud credential:', error)
      }
    }

    this.cloudStatus = {
      configured: this.cloudApiOrigin !== null,
      state: 'error',
      apiOrigin: this.cloudApiOrigin,
      desktopId: null,
      enrollmentCode: null,
      enrollmentExpiresAt: null,
      lastError
    }
    if (!this.hasRestorableLanEnrollment() && this.remoteModeActive) {
      this.toggleRemoteMode(false)
    } else {
      this.broadcast()
    }
  }

  private async checkEnrollmentStatus(): Promise<void> {
    const config = this.cloudConfig
    if (!config || !this.vault || !this.remoteModeActive) return
    if (!this.cloudAbortController) this.cloudAbortController = new AbortController()
    const controller = this.cloudAbortController
    const generation = this.cloudPollGeneration
    if (this.cloudPollRunningGeneration === generation) return
    this.cloudPollRunningGeneration = generation
    const isCurrentPoll = (): boolean =>
      generation === this.cloudPollGeneration &&
      controller === this.cloudAbortController &&
      config === this.cloudConfig &&
      this.remoteModeActive
    let serverRetryDelay: number | null = null
    try {
      const token = await this.vault.resolve(config.tokenRef)
      if (!isCurrentPoll()) return
      const response = await fetchWithDeadline(
        new URL(
          `/v1/device-enrollments/${encodeURIComponent(config.desktopId)}/status`,
          config.apiOrigin
        ),
        { headers: { Authorization: `Bearer ${token}` } },
        CLOUD_REQUEST_TIMEOUT_MS,
        controller.signal
      )
      if (!isCurrentPoll()) return
      if (!response.ok) {
        if (cloudResponseIsTerminal(response.status)) {
          Logger.info(`Remote cloud enrollment rejected (${response.status}); local state cleared`)
          await this.discardCloudEnrollment('Enrollment rejected. Sign in again.')
          return
        }
        serverRetryDelay = cloudRetryAfterMs(response)
        throw new Error(`Enrollment status unavailable (${response.status})`)
      }
      this.cloudPollFailureCount = 0
      const payload = (await response.json()) as Record<string, unknown>
      if (payload['revoked'] === true) {
        await this.discardCloudEnrollment('Desktop revoked. Sign in again.')
        return
      }
      if (payload['exists'] === false) {
        this.cloudStatus = {
          ...this.cloudStatus,
          state: 'connecting',
          enrollmentCode: null,
          enrollmentExpiresAt: null,
          lastError: null
        }
        this.broadcast()
        this.connectCloudRelay(token)
        return
      }
      if (payload['claimed'] === true) {
        Logger.info('Remote cloud enrollment claimed; preparing the encrypted control grant')
        const mobileDeviceId = payload['mobileDeviceId']
        const mobilePublicKey = payload['mobilePublicKey']
        if (
          typeof mobileDeviceId !== 'string' ||
          typeof mobilePublicKey !== 'object' ||
          mobilePublicKey === null
        ) {
          throw new Error('Enrollment grant request is invalid')
        }
        this.pendingCloudDeviceId = mobileDeviceId
        this.cloudStatus = {
          ...this.cloudStatus,
          state: 'connecting',
          lastError: null
        }
        // The peer secret is also the transport encryption key. It can rotate
        // when an expired LAN pairing code is refreshed, so a previously
        // uploaded grant may be cryptographically stale even though the server
        // reports it as present. Refresh it before every relay startup; the
        // service invalidates sockets and buffered ciphertext from the old key.
        const controlSecret = this.resolvedPeerSecret ?? (await this.resolvePeerSecret())
        if (!controlSecret) {
          throw new Error('Enrollment grant request is invalid')
        }
        const grant = await createDesktopControlGrant({
          desktopId: config.desktopId,
          mobileDeviceId,
          mobilePublicKey: mobilePublicKey as JsonWebKey,
          controlSecret
        })
        const grantResponse = await fetchWithDeadline(
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
          },
          CLOUD_REQUEST_TIMEOUT_MS,
          controller.signal
        )
        if (!isCurrentPoll()) return
        if (!grantResponse.ok) {
          if (cloudResponseIsTerminal(grantResponse.status)) {
            Logger.info(
              `Remote cloud control grant rejected (${grantResponse.status}); local state cleared`
            )
            await this.discardCloudEnrollment('Connection authorization rejected. Sign in again.')
            return
          }
          serverRetryDelay = cloudRetryAfterMs(grantResponse)
          throw new Error(`Control grant upload unavailable (${grantResponse.status})`)
        }
        Logger.info('Remote cloud control grant uploaded; opening the relay')
        this.connectCloudRelay(token)
        return
      }
      if (Date.now() >= config.enrollmentExpiresAt) {
        await this.discardCloudEnrollment('Enrollment expired. Sign in again.')
        return
      }
      this.cloudStatus = { ...this.cloudStatus, state: 'enrollment-pending' }
      this.broadcast()
      this.scheduleEnrollmentPoll(2_000)
    } catch (error) {
      if (error instanceof CloudRequestCancelledError || !isCurrentPoll()) return
      const retryDelay = this.nextEnrollmentRetryDelay(serverRetryDelay)
      const retrySeconds = Math.ceil(retryDelay / 1_000)
      if (this.cloudPollFailureCount === 1) {
        Logger.error('Remote cloud enrollment status unavailable:', error)
      } else {
        Logger.dev(`Remote cloud enrollment still unavailable; retrying in ${retrySeconds}s`)
      }
      this.cloudStatus = {
        ...this.cloudStatus,
        state: 'offline',
        lastError: `Service unreachable. Retrying in ${retrySeconds}s.`
      }
      this.broadcast()
      this.scheduleEnrollmentPoll(retryDelay)
    } finally {
      if (this.cloudPollRunningGeneration === generation) {
        this.cloudPollRunningGeneration = null
      }
    }
  }

  private connectCloudRelay(deviceToken: string): void {
    const config = this.cloudConfig
    const controlSecret = this.resolvedPeerSecret
    if (!config || !controlSecret || !this.rpc) {
      const reason = !config
        ? 'enrollment configuration is unavailable'
        : !controlSecret
          ? 'control secret is unavailable'
          : 'remote RPC is unavailable'
      Logger.error(`Remote cloud relay could not start: ${reason}`)
      this.cloudStatus = { ...this.cloudStatus, state: 'error', lastError: reason }
      this.broadcast()
      return
    }
    if (this.cloudRelay) return
    if (!this.cloudAbortController) this.cloudAbortController = new AbortController()
    const signal = this.cloudAbortController.signal
    const relay = new CloudRelayClient({
      apiOrigin: config.apiOrigin,
      deviceToken,
      controlSecret,
      lanEndpoints: this.gateway?.info().urls ?? [],
      credentials: this.credentials ?? undefined,
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
        Logger.info('Remote cloud relay authenticated; waiting for phone authentication')
        this.cloudStatus = {
          ...this.cloudStatus,
          state: this.pendingCloudDeviceId ? 'connecting' : 'online',
          lastError: null
        }
        this.installEventForwarder()
        this.scheduleAccountProfileSync(0)
        this.broadcast()
      },
      onDeviceAuthenticated: (deviceId, cloudMobileDeviceId) => {
        this.cloudConnectedDeviceId = deviceId
        this.reconcileDeviceConnections(this.connectedTransportDeviceIds())
        if (cloudMobileDeviceId === this.pendingCloudDeviceId) {
          this.pendingCloudDeviceId = null
          this.cloudStatus = {
            ...this.cloudStatus,
            state: 'online',
            enrollmentCode: null,
            enrollmentExpiresAt: null,
            lastError: null
          }
        }
        this.broadcast()
      },
      onWorkspaceActiveChange: (deviceId, active) => {
        this.updateWorkspaceActivity(deviceId, active)
      },
      onDisconnected: (reason) => {
        if (this.cloudRelay !== relay) return
        if (reason === 'remote-host-active') {
          Logger.dev('Waiting for the active CodeInOven instance to hand off remote transport')
          this.cloudStatus = { ...this.cloudStatus, state: 'connecting', lastError: null }
          this.broadcast()
          return
        }
        if (reason === 'revoked' || reason === 'relay-closed-4003') {
          Logger.info('Remote cloud relay credential was revoked; local enrollment cleared')
          void this.discardCloudEnrollment('Desktop access was revoked. Create a new pairing code.')
          return
        }
        if (reason === 'authentication-failed' || reason === 'relay-closed-4001') {
          Logger.error('Remote cloud relay rejected the saved desktop credential')
          void this.discardCloudEnrollment(
            'Desktop authorization was rejected. Create a new pairing code.'
          )
          return
        }
        Logger.dev(`Remote cloud relay disconnected (${reason}); reconnecting automatically`)
        this.cloudStatus = { ...this.cloudStatus, state: 'offline', lastError: reason }
        this.cloudConnectedDeviceId = null
        this.reconcileDeviceConnections(this.connectedTransportDeviceIds())
        this.broadcast()
      },
      onRpc: async (channel, args, device) => {
        const rpc = this.rpc
        const outcome = rpc
          ? await rpc.dispatch({ id: 0, channel, args, device })
          : { ok: false as const, message: 'RPC unavailable' }
        this.broadcastPendingApprovals()
        return outcome
      }
    })
    this.cloudRelay = relay
    relay.connect()
  }

  private stopCloudAccess(): void {
    this.cloudPollGeneration += 1
    this.cloudPollRunningGeneration = null
    this.cloudPollFailureCount = 0
    this.pendingCloudDeviceId = null
    if (this.cloudPollTimer) clearTimeout(this.cloudPollTimer)
    this.cloudPollTimer = null
    if (this.cloudProfileSyncTimer) clearTimeout(this.cloudProfileSyncTimer)
    this.cloudProfileSyncTimer = null
    // Cancel any in-flight enrollment/status request and abort the relay
    // connection so nothing survives a remote-mode toggle or app shutdown.
    this.cloudAbortController?.abort()
    this.cloudAbortController = null
    this.cloudRelay?.close()
    this.cloudRelay = null
    this.cloudConnectedDeviceId = null
    this.reconcileDeviceConnections(this.connectedTransportDeviceIds(), false)
    if (!this.devices.some((device) => device.connected)) setRemoteEventForwarder(null)
    if (this.cloudStatus.state !== 'disabled') {
      this.cloudStatus = { ...this.cloudStatus, state: 'offline' }
    }
  }

  private async startGateway(prepareEnrollment = true): Promise<void> {
    if (this.gateway) return
    if (!this.staticRoot) {
      Logger.error('Remote gateway not started: renderer static root is not set')
      return
    }
    await this.resolvePeerSecret()
    if (prepareEnrollment) await this.syncPairingState()
    const peerSecret = this.resolvedPeerSecret
    const gateway = new RemoteGateway({
      port: this.lanPort,
      localPort: this.localPort,
      peerSecret,
      certificateDir: join(app.getPath('userData'), 'remote-gateway'),
      staticRoot: this.staticRoot,
      allowedOrigins: this.cloudApiOrigin ? [new URL(this.cloudApiOrigin).origin] : [],
      handlers: {
        onDevicesChange: (devices) => this.onDevicesChange(devices),
        onWorkspaceActiveChange: (deviceId, active) => {
          this.updateWorkspaceActivity(deviceId, active)
        },
        authenticateDevice: createLanDeviceAuthenticator({
          credentials: this.credentials,
          toDeviceInfo: (device, connected) => this.toDeviceInfo(device, connected)
        }),
        onRpc: this.rpc
          ? async (channel, args, device) => {
              const rpc = this.rpc
              const outcome = rpc
                ? await rpc.dispatch({ id: 0, channel, args, device })
                : { ok: false as const, message: 'RPC unavailable' }
              this.broadcastPendingApprovals()
              return outcome
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
        // Closing the app always fully quits   nothing is kept alive.
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
        sendToRenderer(window.webContents, 'remote:status', status)
      }
    }
  }

  /** Push pending high-risk approvals to the desktop renderer for disposition. */
  private broadcastPendingApprovals(): void {
    const approvals = this.listPendingApprovals()
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        sendToRenderer(window.webContents, 'remote:stepUpPending', approvals)
      }
    }
  }
}
