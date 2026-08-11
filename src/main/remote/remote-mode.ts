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
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import { join } from 'node:path'
import { hostname, platform } from 'node:os'
import { Logger } from '../logger'
import { sendToRenderer } from '../renderer-delivery'
import { SecretVault } from '../secret-vault'
import { CloudRelayClient } from './cloud-relay-client'
import { createDesktopControlGrant } from './control-grant'
import { RemoteGateway } from './remote-gateway'
import { createRemoteTray, type RemoteTray } from './remote-tray'
import type { RemoteCloudStatus, RemoteDeviceInfo, RemoteModeStatus } from './remote-types'
import type {
  AccountAuthProvider,
  AccountProfile,
  AccountProfileState,
  AccountProfileSyncPayload,
  AccountSignInStart,
  AccountUsageBreakdown,
  AccountUsageSummary,
  MemoryEntry
} from '../../lib/types'
import { createKeepAliveSession, type KeepAliveSession } from '../../renderer/lib/remote/keep-alive'
import { verifyHandshakeToken } from '../../renderer/lib/remote/session-security'
import { handshakeTranscript } from '../../renderer/lib/remote/device-identity'
import {
  isPairingExpired,
  loadOrCreatePeerSecret,
  readPairingExpiry,
  rotatePeerSecret
} from './peer-secret'
import { RemoteRpcDispatcher } from './remote-rpc'
import { DeviceCredentialService, type EnrolledDevice } from './device-credential-service'
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

/** Gateway device-authentication callback shape (see RemoteGateway options). */
type GatewayAuthHandler = (input: {
  nonce: string
  token?: string
  signature?: string
  transcript?: string
  bootstrap?: string
  signingPublicJwk?: JsonWebKey
  agreementPublicJwk?: JsonWebKey
  authVersion?: number
  deviceId: string
  deviceName: string
  originPolicy: 'strict' | 'local'
  transport: 'lan' | 'relay'
}) => Promise<{ accepted: boolean; device?: RemoteDeviceInfo }>

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
  /** Device credential service backing per-device identity and revocation. */
  credentials?: DeviceCredentialService | null
  /**
   * Called whenever the live remote-session state changes (a phone connects or
   * disconnects). Lets the host keep the device awake while a session is live.
   */
  onSessionActiveChange?: (active: boolean) => void
  /** Supplies local usage and global memory for authenticated profile sync. */
  loadAccountProfileData?: () => Promise<AccountProfileSyncPayload>
  /** Applies the merged cloud memory snapshot to local global memory. */
  applyGlobalMemories?: (entries: MemoryEntry[]) => Promise<void>
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
const CLOUD_ENROLLMENT_RETRY_INITIAL_MS = 5_000
const CLOUD_ENROLLMENT_RETRY_MAX_MS = 5 * 60_000

function cloudResponseIsTerminal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429
}

function cloudRetryAfterMs(response: Response): number | null {
  const retryAfter = response.headers.get('retry-after')
  if (!retryAfter) return null
  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const retryAt = Date.parse(retryAfter)
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : null
}

class CloudRequestCancelledError extends Error {
  constructor() {
    super('Cloud request cancelled')
    this.name = 'CloudRequestCancelledError'
  }
}

class CloudRequestTimeoutError extends Error {
  constructor() {
    super('Cloud service request timed out')
    this.name = 'CloudRequestTimeoutError'
  }
}

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
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (externalSignal?.aborted) throw new CloudRequestCancelledError()
    if (timedOut) throw new CloudRequestTimeoutError()
    throw error
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

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function parseUsageBreakdown(value: unknown): AccountUsageBreakdown[] | null {
  if (!Array.isArray(value)) return null
  const rows: AccountUsageBreakdown[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const row = item as Record<string, unknown>
    const messageCount = finiteNumber(row['messageCount'])
    const costUsd = finiteNumber(row['costUsd'])
    const tokens = finiteNumber(row['tokens'])
    if (
      typeof row['id'] !== 'string' ||
      messageCount === null ||
      costUsd === null ||
      tokens === null
    ) {
      return null
    }
    rows.push({ id: row['id'], messageCount, costUsd, tokens })
  }
  return rows
}

function parseAccountUsage(value: unknown): AccountUsageSummary | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const messageCount = finiteNumber(record['messageCount'])
  const costUsd = finiteNumber(record['costUsd'])
  const tokens = finiteNumber(record['tokens'])
  const durationMs = finiteNumber(record['durationMs'])
  const generatedAt = finiteNumber(record['generatedAt'])
  const harnesses = parseUsageBreakdown(record['harnesses'])
  const models = parseUsageBreakdown(record['models'])
  if (
    messageCount === null ||
    costUsd === null ||
    tokens === null ||
    durationMs === null ||
    generatedAt === null ||
    !harnesses ||
    !models ||
    !Array.isArray(record['activityDays'])
  ) {
    return null
  }
  const activityDays = record['activityDays'].flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
    const day = item as Record<string, unknown>
    const dayCount = finiteNumber(day['messageCount'])
    return typeof day['date'] === 'string' && dayCount !== null
      ? [{ date: day['date'], messageCount: dayCount }]
      : []
  })
  return {
    messageCount,
    costUsd,
    tokens,
    durationMs,
    topHarnessId: typeof record['topHarnessId'] === 'string' ? record['topHarnessId'] : null,
    topModelId: typeof record['topModelId'] === 'string' ? record['topModelId'] : null,
    harnesses,
    models,
    activityDays,
    generatedAt
  }
}

function parseGlobalMemories(value: unknown): MemoryEntry[] | null {
  if (!Array.isArray(value)) return null
  const entries: MemoryEntry[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const entry = item as Record<string, unknown>
    const categories: MemoryEntry['category'][] = [
      'behavioral',
      'project-rule',
      'identity',
      'preference'
    ]
    const priorities: MemoryEntry['priority'][] = ['critical', 'high', 'medium', 'low']
    const sources: MemoryEntry['source'][] = ['manual', 'auto-detected']
    if (
      typeof entry['id'] !== 'string' ||
      typeof entry['label'] !== 'string' ||
      typeof entry['content'] !== 'string' ||
      typeof entry['enabled'] !== 'boolean' ||
      typeof entry['updatedAt'] !== 'number' ||
      !categories.includes(entry['category'] as MemoryEntry['category']) ||
      !priorities.includes(entry['priority'] as MemoryEntry['priority']) ||
      entry['scope'] !== 'global' ||
      !sources.includes(entry['source'] as MemoryEntry['source']) ||
      typeof entry['frequency'] !== 'number' ||
      typeof entry['lastReinforced'] !== 'number'
    ) {
      return null
    }
    entries.push({
      id: entry['id'],
      label: entry['label'],
      content: entry['content'],
      enabled: entry['enabled'],
      updatedAt: entry['updatedAt'],
      category: entry['category'] as MemoryEntry['category'],
      priority: entry['priority'] as MemoryEntry['priority'],
      scope: 'global',
      source: entry['source'] as MemoryEntry['source'],
      frequency: entry['frequency'],
      lastReinforced: entry['lastReinforced']
    })
  }
  return entries
}

function parseAccountProfile(value: unknown): AccountProfile | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const wrapper = value as Record<string, unknown>
  const raw = wrapper['profile']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const profile = raw as Record<string, unknown>
  const usage = parseAccountUsage(profile['usage'])
  const globalMemories = parseGlobalMemories(profile['globalMemories'])
  if (
    typeof profile['id'] !== 'string' ||
    typeof profile['email'] !== 'string' ||
    typeof profile['displayName'] !== 'string' ||
    (profile['image'] !== null && typeof profile['image'] !== 'string') ||
    typeof profile['updatedAt'] !== 'number' ||
    !usage ||
    !globalMemories
  ) {
    return null
  }
  return {
    id: profile['id'],
    email: profile['email'],
    displayName: profile['displayName'],
    image: profile['image'],
    usage,
    globalMemories,
    updatedAt: profile['updatedAt']
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
  private readonly credentials: DeviceCredentialService | null
  private readonly onSessionActiveChange?: (active: boolean) => void
  private readonly loadAccountProfileData?: () => Promise<AccountProfileSyncPayload>
  private readonly applyGlobalMemories?: (entries: MemoryEntry[]) => Promise<void>
  private readonly cloudApiOrigin: string | null = resolveCloudApiOrigin()
  private readonly vault: SecretVault | null
  private cloudConfig: CloudAccessConfig | null = null
  private cloudRelay: CloudRelayClient | null = null
  private cloudPollTimer: ReturnType<typeof setTimeout> | null = null
  private cloudProfileSyncTimer: ReturnType<typeof setTimeout> | null = null
  private cloudAbortController: AbortController | null = null
  private cloudPollGeneration = 0
  private cloudPollRunningGeneration: number | null = null
  private cloudPollFailureCount = 0
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
    this.credentials = options.credentials ?? null
    this.vault = this.storage ? new SecretVault(this.storage) : null
    this.onSessionActiveChange = options.onSessionActiveChange
    this.loadAccountProfileData = options.loadAccountProfileData
    this.applyGlobalMemories = options.applyGlobalMemories
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

  /**
   * Keep the short-lived account enrollment bootstrap synchronized with the
   * current LAN control secret.
   */
  private async syncPairingState(): Promise<void> {
    const directory = join(app.getPath('userData'), 'remote-gateway')
    if (this.credentials && !this.peerSecret && (await isPairingExpired(directory))) {
      this.resolvedPeerSecret = await rotatePeerSecret(directory)
      this.gateway?.setPeerSecret(this.resolvedPeerSecret)
      Logger.info('Remote account enrollment bootstrap rotated after expiry')
    }
    const secret = this.resolvedPeerSecret
    if (!secret) return
    const expiresAt = await readPairingExpiry(directory)
    if (this.credentials) {
      await this.credentials.registerPairingValue(secret, {
        expiresAt: expiresAt ?? Date.now() + 5 * 60 * 1_000
      })
    }
  }

  /**
   * Rotate the LAN control secret and its short-lived account enrollment
   * bootstrap before issuing a new account enrollment code.
   */
  private async rotatePairingBootstrap(): Promise<void> {
    if (this.peerSecret) return
    const directory = join(app.getPath('userData'), 'remote-gateway')
    this.resolvedPeerSecret = await rotatePeerSecret(directory)
    this.gateway?.setPeerSecret(this.resolvedPeerSecret)
    const expiresAt = Date.now() + 5 * 60 * 1_000
    if (this.credentials && this.resolvedPeerSecret) {
      await this.credentials.registerPairingValue(this.resolvedPeerSecret, {
        expiresAt
      })
    }
    this.broadcast()
  }

  get status(): RemoteModeStatus {
    const gateway = this.gateway?.info() ?? {
      listening: false,
      port: this.lanPort,
      url: null
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
    const wasLive = this.devices.some((device) => device.connected)
    const connectedIds = new Set(devices.map((device) => device.id))
    this.refreshDevices(connectedIds)
    const isLive = this.devices.some((device) => device.connected)
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

  /**
   * Rebuild the device list from the enrolled device records, marking which
   * hold a live session. Falls back to the gateway's connected set when no
   * credential service is wired (legacy path).
   */
  private refreshDevices(connectedIds: Set<string>): void {
    if (!this.credentials) {
      const live = this.gateway?.listDevices() ?? []
      this.devices = live.map((device) => ({
        ...device,
        name: this.deviceNames[device.id] ?? device.name,
        connected: true,
        scopes: [],
        fingerprint: null,
        lastUsedAt: null,
        expiresAt: null,
        credentialExpiresAt: null,
        revokedAt: null,
        authVersion: 0,
        allProjects: true,
        projectIds: []
      }))
      return
    }
    this.devices = this.credentials.listDevices().map((device) => ({
      ...this.toDeviceInfo(device, connectedIds.has(device.deviceId)),
      name: this.deviceNames[device.deviceId] ?? device.name
    }))
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

  /** Rename an enrolled device; the record and legacy override are updated. */
  async renameDevice(deviceId: string, name: string): Promise<RemoteModeStatus> {
    const trimmed = name.trim().slice(0, 100)
    if (trimmed.length === 0) throw new TypeError('Device name cannot be empty')
    if (this.credentials) {
      this.credentials.renameDevice(deviceId, trimmed)
    }
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

  /**
   * Human revocation: durably marks the device revoked (tombstone + authVersion
   * bump), closes every live socket, and only then broadcasts the new list.
   */
  async revokeDevice(deviceId: string, reason: string): Promise<RemoteModeStatus> {
    if (!this.credentials) throw new Error('Device credential service is unavailable')
    const revoked = this.credentials.revokeDevice(deviceId, reason || 'operator')
    if (!revoked) throw new Error('Device not found')
    this.gateway?.disconnectDevice(deviceId)
    // Terminate any bound cloud relay session for this device immediately;
    // per-invoke revalidation also rejects it if a socket survives.
    if (this.cloudRelay?.boundDeviceId() === deviceId) {
      this.cloudRelay.close()
      this.cloudRelay = null
      this.cloudStatus = { ...this.cloudStatus, state: 'offline', lastError: 'device revoked' }
    }
    this.refreshDevices(new Set(this.gateway?.listDevices().map((d) => d.id) ?? []))
    this.syncTray()
    this.broadcast()
    return this.status
  }

  /** Enrolled device records (including revoked), enriched with connection state. */
  listEnrolledDevices(): RemoteDeviceInfo[] {
    if (!this.credentials) return []
    const connectedIds = new Set(this.gateway?.listDevices().map((d) => d.id) ?? [])
    return this.credentials.listDevices().map((device) => ({
      ...this.toDeviceInfo(device, connectedIds.has(device.deviceId)),
      name: this.deviceNames[device.deviceId] ?? device.name
    }))
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

  /**
   * Gateway device-authentication handler. Phones authenticate by proving
   * possession of their signing key (ECDSA over the challenge transcript);
   * first-time enrollment additionally presents a single-use pairing
   * bootstrap and the device's public keys. The shared secret is never a
   * durable authority: on the LAN-exposed listener it only authorizes the
   * one-shot enrollment, and the legacy HMAC path is accepted solely for the
   * desktop renderer's own loopback session.
   */
  private makeAuthenticateDevice(): GatewayAuthHandler {
    return async ({
      nonce,
      token,
      signature,
      bootstrap,
      signingPublicJwk,
      agreementPublicJwk,
      authVersion,
      deviceId,
      deviceName,
      originPolicy
    }) => {
      const credentials = this.credentials
      if (signature && credentials) {
        // The canonical LAN transcript is recomputed server-side from the
        // desktop-issued challenge nonce plus the identity/bootstraps — never
        // taken from the peer — so a captured proof cannot be replayed.
        if (bootstrap && signingPublicJwk && agreementPublicJwk) {
          const transcript = handshakeTranscript({ nonce, bootstrap, context: 'lan' })
          // First-time enrollment: the single-use pairing bootstrap from the QR
          // authorizes exactly one enrollment; the signature proves the device
          // owns the signing key it is submitting.
          const outcome = await credentials.enrollDevice({
            bootstrapValue: bootstrap,
            name: deviceName,
            signingPublicJwk,
            agreementPublicJwk,
            signingProof: signature,
            proofTranscript: transcript,
            transport: 'lan'
          })
          if (!outcome.ok || !outcome.device) return { accepted: false }
          // enrollDevice atomically consumes the one-time bootstrap. Keep the
          // granted transport key stable so account-backed LAN and relay
          // reconnects can continue decrypting their existing cloud grant.
          // An explicit "Create new code" action rotates it before re-enrollment.
          return { accepted: true, device: this.toDeviceInfo(outcome.device, true) }
        }
        if (deviceId && typeof authVersion === 'number') {
          const transcript = handshakeTranscript({ nonce, deviceId, authVersion, context: 'lan' })
          const result = await credentials.authenticateDevice({
            deviceId,
            authVersion,
            transcript,
            signature,
            transport: 'lan'
          })
          if (!result.ok || !result.device) return { accepted: false }
          return { accepted: true, device: this.toDeviceInfo(result.device, true) }
        }
        credentials.audit({
          decision: 'auth_failed',
          reasonCode: 'malformed',
          deviceId: deviceId || null,
          deviceName: deviceName || null,
          transport: 'lan'
        })
        return { accepted: false }
      }
      // Legacy shared-secret handshake: only the desktop renderer's own
      // loopback session, never a phone on the LAN-exposed listener.
      if (token && originPolicy === 'local' && credentials) {
        const secret = this.resolvedPeerSecret ?? (await this.resolvePeerSecret())
        const verified = secret ? await verifyHandshakeToken(secret, nonce, token) : false
        if (!verified) {
          credentials.audit({
            decision: 'auth_failed',
            reasonCode: 'signature_invalid',
            deviceId: null,
            transport: 'lan'
          })
        }
        return { accepted: verified }
      }
      credentials?.audit({
        decision: 'auth_failed',
        reasonCode: 'denied_by_default',
        deviceId: deviceId || null,
        deviceName: deviceName || null,
        transport: 'lan'
      })
      return { accepted: false }
    }
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
    ipcMain.handle('account:getProfile', (): Promise<AccountProfileState> => this.accountProfile())
    ipcMain.handle(
      'account:beginSignIn',
      (_event: IpcMainInvokeEvent, provider: AccountAuthProvider): Promise<AccountSignInStart> =>
        this.beginAccountSignIn(provider)
    )
    ipcMain.handle('account:syncProfile', (): Promise<AccountProfileState> =>
      this.syncAccountProfile()
    )
  }

  private async accountRequest(init?: RequestInit): Promise<Response | null> {
    const config =
      this.cloudConfig ?? (await this.storage?.read<CloudAccessConfig>(CLOUD_CONFIG_PATH)) ?? null
    if (!config || !this.vault) return null
    const token = await this.vault.resolve(config.tokenRef)
    return fetchWithDeadline(
      new URL('/v1/profile', config.apiOrigin),
      {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers
        }
      },
      CLOUD_REQUEST_TIMEOUT_MS,
      this.cloudAbortController?.signal
    )
  }

  private async loadProfileImage(profile: AccountProfile): Promise<AccountProfile> {
    if (!profile.image || profile.image.startsWith('data:')) return profile
    try {
      const url = new URL(profile.image)
      if (url.protocol !== 'https:') return { ...profile, image: null }
      const response = await fetchWithDeadline(url, {}, 5_000)
      const contentType = response.headers.get('content-type') ?? ''
      const contentLength = Number(response.headers.get('content-length') ?? 0)
      const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
      if (!response.ok || !allowedTypes.has(contentType) || contentLength > 2 * 1_024 * 1_024) {
        return { ...profile, image: null }
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > 2 * 1_024 * 1_024) return { ...profile, image: null }
      return {
        ...profile,
        image: `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`
      }
    } catch {
      return { ...profile, image: null }
    }
  }

  async accountProfile(): Promise<AccountProfileState> {
    const response = await this.accountRequest()
    if (!response || response.status === 401) {
      return {
        status: this.cloudStatus.state === 'enrollment-pending' ? 'pending' : 'signed-out',
        profile: null
      }
    }
    if (!response.ok) throw new Error('Account profile is unavailable')
    const profile = parseAccountProfile(await response.json())
    if (!profile) throw new Error('Account profile response is invalid')
    return { status: 'signed-in', profile: await this.loadProfileImage(profile) }
  }

  async beginAccountSignIn(provider: AccountAuthProvider): Promise<AccountSignInStart> {
    if (provider !== 'google' && provider !== 'apple') throw new Error('Invalid account provider')
    if (!this.cloudApiOrigin) throw new Error('REMOTE_API_ORIGIN is not configured')
    const url = new URL('/', this.cloudApiOrigin)
    url.hash = new URLSearchParams({ provider }).toString()
    return { url: url.toString() }
  }

  async syncAccountProfile(): Promise<AccountProfileState> {
    if (!this.loadAccountProfileData) return this.accountProfile()
    const local = await this.loadAccountProfileData()
    const response = await this.accountRequest({
      method: 'PUT',
      body: JSON.stringify(local)
    })
    if (!response || response.status === 401) return { status: 'signed-out', profile: null }
    if (!response.ok) throw new Error('Account profile sync failed')
    const profile = parseAccountProfile(await response.json())
    if (!profile) throw new Error('Account profile response is invalid')
    await this.applyGlobalMemories?.(profile.globalMemories)
    return { status: 'signed-in', profile: await this.loadProfileImage(profile) }
  }

  private scheduleAccountProfileSync(delayMs: number): void {
    if (!this.loadAccountProfileData) return
    if (this.cloudProfileSyncTimer) clearTimeout(this.cloudProfileSyncTimer)
    const generation = this.cloudPollGeneration
    this.cloudProfileSyncTimer = setTimeout(() => {
      this.cloudProfileSyncTimer = null
      if (generation !== this.cloudPollGeneration) return
      void this.syncAccountProfile()
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

    // A hosted enrollment must never issue a control grant from an expired or
    // already-consumed LAN bootstrap. Generate and register a fresh one before
    // the one-time account code is created. A fixed operator-provided secret
    // cannot be rotated, so re-register it with a fresh enrollment window.
    if (this.peerSecret) {
      await this.syncPairingState()
    } else {
      await this.rotatePairingBootstrap()
    }

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
    this.broadcast()
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
      if (payload['claimed'] === true) {
        this.cloudStatus = {
          ...this.cloudStatus,
          state: 'connecting',
          enrollmentCode: null,
          lastError: null
        }
        // The peer secret is also the transport encryption key. It can rotate
        // when an expired LAN pairing code is refreshed, so a previously
        // uploaded grant may be cryptographically stale even though the server
        // reports it as present. Refresh it before every relay startup; the
        // service invalidates sockets and buffered ciphertext from the old key.
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
    if (!config || !controlSecret || !this.rpc || this.cloudRelay) return
    if (!this.cloudAbortController) this.cloudAbortController = new AbortController()
    const signal = this.cloudAbortController.signal
    const relay = new CloudRelayClient({
      apiOrigin: config.apiOrigin,
      deviceToken,
      controlSecret,
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
        this.cloudStatus = { ...this.cloudStatus, state: 'online', lastError: null }
        this.installEventForwarder()
        this.scheduleAccountProfileSync(0)
        this.broadcast()
      },
      onDisconnected: (reason) => {
        if (this.cloudRelay !== relay) return
        this.cloudStatus = { ...this.cloudStatus, state: 'offline', lastError: reason }
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
    await this.resolvePeerSecret()
    await this.syncPairingState()
    // syncPairingState may rotate an expired persisted secret. Read the
    // resolved value only after that rotation so the gateway, QR, credential
    // bootstrap, cloud grant, and payload encryption all use the same key.
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
        authenticateDevice: this.makeAuthenticateDevice(),
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
