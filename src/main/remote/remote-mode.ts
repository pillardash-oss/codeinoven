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
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
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
  AccountProfile,
  AccountProfileState,
  AccountProfileSyncPayload,
  AccountSignInStart,
  MemoryEntry,
  MemoryTombstone,
  SyncedDeviceProject,
  SyncedDeviceUsage
} from '../../lib/types'
import { createKeepAliveSession, type KeepAliveSession } from '../../renderer/lib/remote/keep-alive'
import { handshakeTranscript } from '../../renderer/lib/remote/device-identity'
import {
  PAIRING_TTL_MS,
  loadOrCreatePeerSecret,
  rotatePeerSecret,
  writePairingExpiry
} from './peer-secret'
import { RemoteRpcDispatcher } from './remote-rpc'
import { DeviceCredentialService, type EnrolledDevice } from './device-credential-service'
import { AccountProfileRepo } from '../database/repositories/account-profile-repo'
import { setRemoteEventForwarder } from './remote-event-forwarder'
import { readRemoteModeState, writeRemoteModeState } from './remote-state'
import {
  mergeTombstones,
  readMemorySyncState,
  tombstonesForDeletions,
  writeMemorySyncState
} from './memory-sync-state'
import { isHarnessScopedModelKey } from '../../lib/model-keys'

declare global {
  /** Public remote-service origin injected by the Electron production build. */
  const __CODEINOVEN_REMOTE_API_ORIGIN__: string | undefined
  /** Public account sign-in origin injected by the Electron production build. */
  const __CODEINOVEN_ACCOUNT_AUTH_ORIGIN__: string | undefined
}

/** Gateway device-authentication callback shape (see RemoteGateway options). */
type GatewayAuthHandler = (input: {
  nonce: string
  signature?: string
  transcript?: string
  bootstrap?: string
  signingPublicJwk?: JsonWebKey
  agreementPublicJwk?: JsonWebKey
  authVersion?: number
  deviceId: string
  deviceName: string
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
const CLOUD_CONFIG_PATH = 'remote/cloud-access.json'
const ACCOUNT_CONFIG_PATH = 'account/session.json'

interface CloudAccessConfig {
  apiOrigin: string
  desktopId: string
  enrollmentId: string
  tokenRef: string
  profileTokenRef?: string
  enrollmentExpiresAt: number
}

interface AccountSessionConfig {
  apiOrigin: string
  profileTokenRef: string
  expiresAt?: number
}

interface EnrollmentResponse {
  enrollmentId: string
  desktopId: string
  deviceToken: string | null
  profileToken: string
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
const ACCOUNT_TOKEN_REFRESH_LEAD_MS = 7 * 24 * 60 * 60_000
const ACCOUNT_TOKEN_REFRESH_RETRY_MS = 5 * 60_000
const ACCOUNT_TOKEN_REFRESH_TIMER_MAX_MS = 24 * 60 * 60_000
const ACCOUNT_PROFILE_REFRESH_RETRY_INITIAL_MS = 30_000
const ACCOUNT_PROFILE_REFRESH_RETRY_MAX_MS = 5 * 60_000
// Every renderer surface that shows the account (sidebar, settings, remote
// client view) calls accountProfile() on mount. The cached profile always
// answers instantly; this bounds how often a mount is additionally allowed to
// revalidate over the network, so opening/switching between those views does
// not each spend a Convex round trip. The periodic scheduleAccountProfileSync
// timer already keeps the cache fresh in the background regardless.
const ACCOUNT_PROFILE_REFRESH_MIN_INTERVAL_MS = 5 * 60_000

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

/** Cancellation and deadline timeouts are expected while offline or during teardown. */
function isExpectedCloudFailure(error: unknown): boolean {
  return error instanceof CloudRequestCancelledError || error instanceof CloudRequestTimeoutError
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

function resolveAccountAuthOrigin(): string | null {
  const baked =
    typeof __CODEINOVEN_ACCOUNT_AUTH_ORIGIN__ === 'string'
      ? __CODEINOVEN_ACCOUNT_AUTH_ORIGIN__
      : undefined
  const value = (process.env['ACCOUNT_AUTH_ORIGIN'] ?? baked ?? '').trim()
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
    typeof record['profileToken'] !== 'string' ||
    typeof record['code'] !== 'string' ||
    typeof record['expiresAt'] !== 'number'
  ) {
    return null
  }
  return {
    enrollmentId: record['enrollmentId'],
    desktopId: record['desktopId'],
    deviceToken: record['deviceToken'] as string | null,
    profileToken: record['profileToken'],
    code: record['code'],
    expiresAt: record['expiresAt']
  }
}

async function enrollmentFailureMessage(response: Response): Promise<string> {
  let reason = ''
  try {
    const payload: unknown = await response.json()
    if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
      const error = (payload as Record<string, unknown>)['error']
      if (typeof error === 'string') reason = error
    }
  } catch {
    // The status code still provides a safe, actionable fallback.
  }
  if (response.status === 401 || reason === 'unauthorized') {
    return 'The remote service could not verify your signed-in account'
  }
  if (response.status === 403 || reason === 'enrollment-conflict') {
    return 'This desktop enrollment belongs to a different account'
  }
  if (response.status === 429 || reason === 'rate-limited') {
    return 'Too many pairing attempts. Wait a moment and try again'
  }
  if (response.status >= 500) return 'The remote pairing service is unavailable'
  return `The remote service rejected pairing (HTTP ${response.status})`
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function parseSyncedDeviceProject(value: unknown): SyncedDeviceProject | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const messageCount = finiteNumber(row['messageCount'])
  const costUsd = finiteNumber(row['costUsd'])
  const tokens = finiteNumber(row['tokens'])
  const durationMs = finiteNumber(row['durationMs'])
  const threadCount = finiteNumber(row['threadCount'])
  if (
    typeof row['id'] !== 'string' ||
    typeof row['name'] !== 'string' ||
    messageCount === null ||
    costUsd === null ||
    tokens === null ||
    durationMs === null ||
    threadCount === null
  ) {
    return null
  }
  return {
    id: row['id'],
    name: row['name'],
    messageCount,
    costUsd,
    tokens,
    durationMs,
    threadCount
  }
}

function parseSyncedDeviceUsage(value: unknown): SyncedDeviceUsage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const messageCount = finiteNumber(record['messageCount'])
  const costUsd = finiteNumber(record['costUsd'])
  const tokens = finiteNumber(record['tokens'])
  const durationMs = finiteNumber(record['durationMs'])
  const activeDays = finiteNumber(record['activeDays'])
  const updatedAt = finiteNumber(record['updatedAt'])
  if (
    typeof record['deviceId'] !== 'string' ||
    typeof record['deviceLabel'] !== 'string' ||
    typeof record['platform'] !== 'string' ||
    messageCount === null ||
    costUsd === null ||
    tokens === null ||
    durationMs === null ||
    activeDays === null ||
    updatedAt === null ||
    !Array.isArray(record['projects'])
  ) {
    return null
  }
  const projects: SyncedDeviceProject[] = []
  for (const item of record['projects'].slice(0, 10)) {
    const project = parseSyncedDeviceProject(item)
    if (!project) return null
    projects.push(project)
  }
  return {
    deviceId: record['deviceId'],
    deviceLabel: record['deviceLabel'],
    platform: record['platform'],
    messageCount,
    costUsd,
    tokens,
    durationMs,
    activeDays,
    projects,
    updatedAt
  }
}

function parseUsageByDevice(value: unknown): Record<string, SyncedDeviceUsage> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const byDevice: Record<string, SyncedDeviceUsage> = {}
  for (const [deviceId, raw] of Object.entries(value as Record<string, unknown>)) {
    const usage = parseSyncedDeviceUsage(raw)
    if (!usage || usage.deviceId !== deviceId) return null
    byDevice[deviceId] = usage
  }
  return byDevice
}

function parseMemoryTombstones(value: unknown): MemoryTombstone[] | null {
  if (!Array.isArray(value)) return null
  const tombstones: MemoryTombstone[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const tombstone = item as Record<string, unknown>
    if (typeof tombstone['id'] !== 'string' || typeof tombstone['deletedAt'] !== 'number') {
      return null
    }
    tombstones.push({ id: tombstone['id'], deletedAt: tombstone['deletedAt'] })
  }
  return tombstones
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
      'preference',
      'models'
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
      typeof entry['lastReinforced'] !== 'number' ||
      (entry['category'] === 'models' &&
        (!Array.isArray(entry['modelKeys']) ||
          entry['modelKeys'].length === 0 ||
          entry['modelKeys'].some(
            (key) => typeof key !== 'string' || !isHarnessScopedModelKey(key)
          )))
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
      lastReinforced: entry['lastReinforced'],
      ...(Array.isArray(entry['modelKeys']) ? { modelKeys: entry['modelKeys'] as string[] } : {})
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
  const usageByDevice = parseUsageByDevice(profile['usageByDevice'] ?? {})
  const globalMemories = parseGlobalMemories(profile['globalMemories'])
  const globalMemoryTombstones = parseMemoryTombstones(profile['globalMemoryTombstones'] ?? [])
  if (
    typeof profile['id'] !== 'string' ||
    typeof profile['email'] !== 'string' ||
    typeof profile['displayName'] !== 'string' ||
    (profile['image'] !== null && typeof profile['image'] !== 'string') ||
    typeof profile['updatedAt'] !== 'number' ||
    !usageByDevice ||
    !globalMemories ||
    !globalMemoryTombstones
  ) {
    return null
  }
  return {
    id: profile['id'],
    email: profile['email'],
    displayName: profile['displayName'],
    image: profile['image'],
    usageByDevice,
    globalMemories,
    globalMemoryTombstones,
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
  private readonly storage: import('../storage/storage-engine').StorageEngine | null
  private readonly credentials: DeviceCredentialService | null
  private readonly accountProfileRepo: AccountProfileRepo | null
  private readonly onSessionActiveChange?: (active: boolean) => void
  private readonly loadAccountProfileData?: () => Promise<AccountProfileSyncPayload>
  private readonly applyGlobalMemories?: (entries: MemoryEntry[]) => Promise<void>
  private readonly canOwnTransport: () => boolean
  private readonly cloudApiOrigin: string | null = resolveCloudApiOrigin()
  private readonly accountAuthOrigin: string | null = resolveAccountAuthOrigin()
  private readonly vault: SecretVault | null
  private accountConfig: AccountSessionConfig | null = null
  private accountSignInServer: Server | null = null
  private accountSignInTimeout: ReturnType<typeof setTimeout> | null = null
  private accountTokenRefreshTimer: ReturnType<typeof setTimeout> | null = null
  private accountTokenRefreshPromise: Promise<AccountSessionConfig> | null = null
  /** Bumped on sign-out so in-flight profile refreshes never re-broadcast stale state. */
  private accountProfileGeneration = 0
  private accountProfileRefreshPromise: Promise<void> | null = null
  private accountProfileRefreshFailureCount = 0
  private accountProfileRefreshRetryAt = 0
  private accountProfileRefreshedAt = 0
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
    this.accountProfileRepo = options.accountProfileRepo ?? null
    this.vault = this.storage ? new SecretVault(this.storage) : null
    this.onSessionActiveChange = options.onSessionActiveChange
    this.loadAccountProfileData = options.loadAccountProfileData
    this.applyGlobalMemories = options.applyGlobalMemories
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

  /**
   * Gateway device-authentication handler. Phones authenticate by proving
   * possession of their signing key (ECDSA over the challenge transcript);
   * first-time enrollment additionally presents a single-use pairing
   * bootstrap and the device's public keys. The shared secret is never a
   * durable authority: on the LAN-exposed listener it only authorizes the
   * one-shot enrollment; every session still requires device proof.
   */
  private makeAuthenticateDevice(): GatewayAuthHandler {
    return async ({
      nonce,
      signature,
      bootstrap,
      signingPublicJwk,
      agreementPublicJwk,
      authVersion,
      deviceId,
      deviceName
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
    this.closeAccountSignInListener()
    if (this.accountTokenRefreshTimer) clearTimeout(this.accountTokenRefreshTimer)
    this.accountTokenRefreshTimer = null
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
    ipcMain.handle('account:getProfile', (): Promise<AccountProfileState> => this.accountProfile())
    ipcMain.handle(
      'account:beginSignIn',
      (_event: IpcMainInvokeEvent, provider: AccountAuthProvider): Promise<AccountSignInStart> =>
        this.beginAccountSignIn(provider)
    )
    ipcMain.handle('account:syncProfile', (): Promise<AccountProfileState> =>
      this.syncAccountProfile()
    )
    ipcMain.handle('account:signOut', (): Promise<void> => this.signOutAccount())
  }

  private async accountRequest(init?: RequestInit): Promise<Response | null> {
    if (!this.vault) return null
    const accountConfig =
      this.accountConfig ??
      (await this.storage?.read<AccountSessionConfig>(ACCOUNT_CONFIG_PATH)) ??
      null
    this.accountConfig = accountConfig
    const freshAccountConfig = accountConfig
      ? await this.ensureFreshAccountToken(accountConfig)
      : null
    const cloudConfig =
      this.cloudConfig ?? (await this.storage?.read<CloudAccessConfig>(CLOUD_CONFIG_PATH)) ?? null
    const tokenRef = freshAccountConfig?.profileTokenRef ?? cloudConfig?.profileTokenRef
    if (!tokenRef) return null
    let token: string | null
    try {
      token = await this.vault.resolve(tokenRef)
    } catch (error) {
      if (error instanceof Error && error.message === 'Credential not found') {
        token = null
      } else {
        throw error
      }
    }
    if (token === null) return null
    const apiOrigin = freshAccountConfig?.apiOrigin ?? cloudConfig?.apiOrigin
    return fetchWithDeadline(
      new URL('/v1/profile', apiOrigin),
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

  /**
   * Current account profile, served from the SQLite cache first so a restart
   * (or an offline window) never loses the signed-in identity. When a cached
   * profile exists the live fetch runs in the background and broadcasts a fresh
   * copy via `account:profileChanged` when it lands.
   */
  async accountProfile(): Promise<AccountProfileState> {
    const cached = await this.readCachedAccountProfile()
    if (cached) {
      void this.refreshAccountProfileInBackground()
      return { status: 'signed-in', profile: cached }
    }
    try {
      return await this.fetchAccountProfile()
    } catch (error) {
      if (!isExpectedCloudFailure(error)) {
        Logger.dev('Account profile could not be fetched:', error)
      }
      return {
        status:
          this.accountSignInServer || this.cloudStatus.state === 'enrollment-pending'
            ? 'pending'
            : 'signed-out',
        profile: null
      }
    }
  }

  private async fetchAccountProfile(): Promise<AccountProfileState> {
    const response = await this.accountRequest()
    if (!response || response.status === 401) {
      return {
        status:
          this.accountSignInServer || this.cloudStatus.state === 'enrollment-pending'
            ? 'pending'
            : 'signed-out',
        profile: null
      }
    }
    if (!response.ok) throw new Error('Account profile is unavailable')
    const profile = parseAccountProfile(await response.json())
    if (!profile) throw new Error('Account profile response is invalid')
    const withImage = await this.loadProfileImage(profile)
    await this.cacheAccountProfile(withImage)
    return { status: 'signed-in', profile: withImage }
  }

  /**
   * Revalidate a cached profile from the network without disturbing the state
   * already served. Network failures are deliberately swallowed — the cached
   * signed-in identity stays until a successful fetch or an explicit sign-out.
   */
  private refreshAccountProfileInBackground(): Promise<void> {
    if (this.accountProfileRefreshPromise) return this.accountProfileRefreshPromise
    if (Date.now() < this.accountProfileRefreshRetryAt) return Promise.resolve()
    if (Date.now() - this.accountProfileRefreshedAt < ACCOUNT_PROFILE_REFRESH_MIN_INTERVAL_MS) {
      return Promise.resolve()
    }
    this.accountProfileRefreshPromise = this.runAccountProfileRefresh().finally(() => {
      this.accountProfileRefreshPromise = null
    })
    return this.accountProfileRefreshPromise
  }

  private async runAccountProfileRefresh(): Promise<void> {
    const generation = this.accountProfileGeneration
    this.accountProfileRefreshedAt = Date.now()
    try {
      const state = await this.fetchAccountProfile()
      if (generation !== this.accountProfileGeneration) return
      // A background probe must never drop a cached identity — only a successful
      // fetch (or an explicit sign-out) changes what the user sees.
      if (state.status !== 'signed-in') {
        Logger.dev('Account profile revalidation is not signed in; keeping the cached profile')
        this.deferAccountProfileRefresh()
        return
      }
      this.accountProfileRefreshFailureCount = 0
      this.accountProfileRefreshRetryAt = 0
      this.broadcastAccountProfile(state)
    } catch (error) {
      if (generation !== this.accountProfileGeneration) return
      const retryDelay = this.deferAccountProfileRefresh()
      // Cancellation (cloud teardown/enrollment resets the shared abort
      // controller) and timeouts are expected while offline, so keep the log
      // quiet while the bounded retry delay is active.
      if (!isExpectedCloudFailure(error)) {
        Logger.dev(
          `Account profile refresh deferred for ${Math.ceil(retryDelay / 1_000)}s; keeping the cached profile:`,
          error
        )
      }
    }
  }

  private deferAccountProfileRefresh(): number {
    const exponent = Math.min(this.accountProfileRefreshFailureCount, 4)
    const retryDelay = Math.min(
      ACCOUNT_PROFILE_REFRESH_RETRY_INITIAL_MS * 2 ** exponent,
      ACCOUNT_PROFILE_REFRESH_RETRY_MAX_MS
    )
    this.accountProfileRefreshFailureCount += 1
    this.accountProfileRefreshRetryAt = Date.now() + retryDelay
    return retryDelay
  }

  private async readCachedAccountProfile(): Promise<AccountProfile | null> {
    try {
      return this.accountProfileRepo?.load() ?? null
    } catch (error) {
      Logger.dev('Could not read the cached account profile:', error)
      return null
    }
  }

  private async cacheAccountProfile(profile: AccountProfile): Promise<void> {
    try {
      this.accountProfileRepo?.save(profile)
    } catch (error) {
      Logger.dev('Could not cache the account profile:', error)
    }
  }

  private async clearCachedAccountProfile(): Promise<void> {
    try {
      this.accountProfileRepo?.clear()
    } catch (error) {
      Logger.dev('Could not clear the cached account profile:', error)
    }
  }

  /**
   * Explicit account sign-out: revoke the persisted session token, remove the
   * session config, and delete the cached profile (the only thing that removes
   * the cached identity). Remote-device enrollment is independent and untouched.
   */
  async signOutAccount(): Promise<void> {
    this.accountProfileGeneration++
    this.accountProfileRefreshFailureCount = 0
    this.accountProfileRefreshRetryAt = 0
    this.accountProfileRefreshedAt = 0
    const config =
      this.accountConfig ??
      (await this.storage?.read<AccountSessionConfig>(ACCOUNT_CONFIG_PATH)) ??
      null
    if (config?.profileTokenRef && this.vault) {
      await this.vault.remove(config.profileTokenRef).catch(() => undefined)
    }
    if (this.storage) {
      await this.storage.remove(ACCOUNT_CONFIG_PATH).catch(() => undefined)
    }
    this.accountConfig = null
    await this.clearCachedAccountProfile()
    this.broadcastAccountProfile({ status: 'signed-out', profile: null })
  }

  async beginAccountSignIn(provider: AccountAuthProvider): Promise<AccountSignInStart> {
    if (provider !== 'google' && provider !== 'apple') throw new Error('Invalid account provider')
    if (!this.cloudApiOrigin) throw new Error('REMOTE_API_ORIGIN is not configured')
    if (!this.accountAuthOrigin) throw new Error('ACCOUNT_AUTH_ORIGIN is not configured')
    if (!this.storage || !this.vault || !this.vault.isAvailable()) {
      throw new Error('Secure desktop storage is unavailable')
    }

    this.closeAccountSignInListener()
    const state = randomBytes(32).toString('base64url')
    const codeVerifier = randomBytes(48).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
    const callback = await this.listenForAccountCallback(state, codeVerifier)
    const url = new URL('/desktop/sign-in', this.accountAuthOrigin)
    url.search = new URLSearchParams({
      provider,
      redirect_uri: callback,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    }).toString()
    return { url: url.toString() }
  }

  private closeAccountSignInListener(): void {
    if (this.accountSignInTimeout) clearTimeout(this.accountSignInTimeout)
    this.accountSignInTimeout = null
    this.accountSignInServer?.close()
    this.accountSignInServer = null
  }

  private failAccountSignIn(message: string): void {
    this.closeAccountSignInListener()
    this.broadcastAccountProfile({ status: 'error', profile: null, message })
  }

  private accountCallbackResponse(response: ServerResponse, status: number, message: string): void {
    response.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"
    })
    response.end(
      `<!doctype html><meta charset="utf-8"><title>CodeInOven sign-in</title><style>body{font:16px system-ui;margin:48px;color:#081825}main{max-width:560px}p{line-height:1.6}</style><main><h1>${status === 200 ? 'Sign-in complete' : 'Sign-in failed'}</h1><p>${message}</p></main>`
    )
  }

  private async listenForAccountCallback(state: string, codeVerifier: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        void (async () => {
          let terminalCallback = false
          try {
            const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
            if (request.method !== 'GET' || requestUrl.pathname !== '/account/callback') {
              this.accountCallbackResponse(response, 404, 'This callback is not valid.')
              return
            }
            terminalCallback = true
            const callbackState = requestUrl.searchParams.get('state')
            const code = requestUrl.searchParams.get('code')
            if (callbackState !== state || !code) {
              this.broadcastAccountProfile({
                status: 'error',
                profile: null,
                message: 'The browser callback could not be verified. Start sign-in again.'
              })
              this.accountCallbackResponse(
                response,
                400,
                'The sign-in response could not be verified.'
              )
              return
            }
            const callbackUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/account/callback`
            const exchange = await fetchWithDeadline(
              new URL('/v1/desktop-auth/exchange', this.cloudApiOrigin!),
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code, codeVerifier, redirectUri: callbackUrl })
              },
              CLOUD_REQUEST_TIMEOUT_MS
            )
            const payload = (await exchange.json()) as Record<string, unknown>
            const profileToken = payload['profileToken']
            const expiresAt = payload['expiresAt']
            if (
              !exchange.ok ||
              typeof profileToken !== 'string' ||
              profileToken.length === 0 ||
              typeof expiresAt !== 'number' ||
              !Number.isFinite(expiresAt)
            ) {
              throw new Error('Account credential exchange failed')
            }
            const profileTokenRef = await this.vault!.save(
              profileToken,
              this.accountConfig?.profileTokenRef
            )
            this.accountConfig = { apiOrigin: this.cloudApiOrigin!, profileTokenRef, expiresAt }
            await this.storage!.write(ACCOUNT_CONFIG_PATH, this.accountConfig)
            this.scheduleAccountTokenRefresh(expiresAt)
            this.accountProfileGeneration++
            this.accountProfileRefreshFailureCount = 0
            this.accountProfileRefreshRetryAt = 0
            const profile = await this.syncAccountProfile()
            this.accountProfileRefreshedAt = Date.now()
            this.broadcastAccountProfile(profile)
            this.accountCallbackResponse(
              response,
              200,
              'Your account is connected. You can close this tab and return to CodeInOven.'
            )
          } catch (error) {
            Logger.error('Desktop account sign-in callback failed:', error)
            this.broadcastAccountProfile({
              status: 'error',
              profile: null,
              message: 'The browser returned to CodeInOven, but the account could not be connected.'
            })
            this.accountCallbackResponse(
              response,
              500,
              'CodeInOven could not finish connecting your account. Return to the app and try again.'
            )
          } finally {
            if (terminalCallback) this.closeAccountSignInListener()
          }
        })()
      })
      server.once('error', (error) => {
        this.failAccountSignIn('CodeInOven could not open a local callback port. Try again.')
        reject(error)
      })
      server.listen(0, '127.0.0.1', () => {
        this.accountSignInServer = server
        const address = server.address()
        if (!address || typeof address === 'string') {
          this.closeAccountSignInListener()
          reject(new Error('Desktop sign-in callback listener is unavailable'))
          return
        }
        this.accountSignInTimeout = setTimeout(
          () =>
            this.failAccountSignIn('Sign-in timed out. Start again to open a new secure callback.'),
          5 * 60 * 1_000
        )
        this.broadcastAccountProfile({ status: 'pending', profile: null })
        resolve(`http://127.0.0.1:${address.port}/account/callback`)
      })
    })
  }

  private scheduleAccountTokenRefresh(expiresAt: number): void {
    if (this.accountTokenRefreshTimer) clearTimeout(this.accountTokenRefreshTimer)
    const delay = Math.min(
      ACCOUNT_TOKEN_REFRESH_TIMER_MAX_MS,
      Math.max(60_000, expiresAt - Date.now() - ACCOUNT_TOKEN_REFRESH_LEAD_MS)
    )
    this.accountTokenRefreshTimer = setTimeout(() => {
      this.accountTokenRefreshTimer = null
      const config = this.accountConfig
      if (!config) return
      void this.ensureFreshAccountToken(config).catch((error) => {
        Logger.dev('Account token refresh unavailable:', error)
      })
    }, delay)
  }

  private async ensureFreshAccountToken(
    config: AccountSessionConfig
  ): Promise<AccountSessionConfig> {
    if (!config.expiresAt || config.expiresAt - Date.now() > ACCOUNT_TOKEN_REFRESH_LEAD_MS) {
      if (config.expiresAt) this.scheduleAccountTokenRefresh(config.expiresAt)
      return config
    }
    if (this.accountTokenRefreshPromise) return this.accountTokenRefreshPromise
    this.accountTokenRefreshPromise = (async () => {
      try {
        if (!this.vault || !this.storage) return config
        const currentToken = await this.vault.resolve(config.profileTokenRef)
        const response = await fetchWithDeadline(
          new URL('/v1/desktop-auth/refresh', config.apiOrigin),
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${currentToken}` }
          },
          CLOUD_REQUEST_TIMEOUT_MS
        )
        const payload = (await response.json()) as Record<string, unknown>
        const profileToken = payload['profileToken']
        const expiresAt = payload['expiresAt']
        if (
          !response.ok ||
          typeof profileToken !== 'string' ||
          !profileToken ||
          typeof expiresAt !== 'number' ||
          !Number.isFinite(expiresAt)
        ) {
          throw new Error('Account token refresh failed')
        }
        const profileTokenRef = await this.vault.save(profileToken, config.profileTokenRef)
        const refreshed = { ...config, profileTokenRef, expiresAt }
        this.accountConfig = refreshed
        await this.storage.write(ACCOUNT_CONFIG_PATH, refreshed)
        this.scheduleAccountTokenRefresh(expiresAt)
        return refreshed
      } catch (error) {
        this.accountTokenRefreshTimer = setTimeout(() => {
          this.accountTokenRefreshTimer = null
          void this.ensureFreshAccountToken(config).catch(() => undefined)
        }, ACCOUNT_TOKEN_REFRESH_RETRY_MS)
        if (!config.expiresAt || config.expiresAt > Date.now()) {
          Logger.dev('Account token refresh deferred; current token remains valid:', error)
          return config
        }
        throw error
      } finally {
        this.accountTokenRefreshPromise = null
      }
    })()
    return this.accountTokenRefreshPromise
  }

  private broadcastAccountProfile(state: AccountProfileState): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) sendToRenderer(window.webContents, 'account:profileChanged', state)
    }
  }

  async syncAccountProfile(): Promise<AccountProfileState> {
    if (!this.loadAccountProfileData) return this.accountProfile()
    const cached = await this.readCachedAccountProfile()
    try {
      const local = await this.loadAccountProfileData()
      const now = Date.now()
      const syncState = await readMemorySyncState(this.storage)
      const localIds = local.globalMemories.map((entry) => entry.id)
      // Entries that were part of the last synced snapshot but are gone locally
      // now were deleted — record a tombstone so the deletion sticks server-side.
      const newTombstones = syncState
        ? tombstonesForDeletions(syncState.lastSnapshotIds, localIds, now)
        : []
      const tombstones = mergeTombstones(
        [...(syncState?.tombstones ?? []), ...local.globalMemoryTombstones, ...newTombstones],
        now
      )
      const response = await this.accountRequest({
        method: 'PUT',
        body: JSON.stringify({
          ...local,
          globalMemoryTombstones: tombstones
        })
      })
      if (!response || response.status === 401) return { status: 'signed-out', profile: null }
      if (!response.ok) throw new Error('Account profile sync failed')
      const profile = parseAccountProfile(await response.json())
      if (!profile) throw new Error('Account profile response is invalid')
      await this.applyGlobalMemories?.(profile.globalMemories)
      await writeMemorySyncState(this.storage, {
        lastSnapshotIds: profile.globalMemories.map((entry) => entry.id),
        tombstones: profile.globalMemoryTombstones,
        updatedAt: now
      })
      const withImage = await this.loadProfileImage(profile)
      await this.cacheAccountProfile(withImage)
      return { status: 'signed-in', profile: withImage }
    } catch (error) {
      if (cached) return { status: 'signed-in', profile: cached }
      throw error
    }
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

    // Open a fresh one-time enrollment window without rotating the transport
    // key already encrypted for approved phones. Rotating that shared key here
    // made every older cloud grant unusable whenever another phone was paired.
    await this.syncPairingState()

    const previous =
      this.cloudConfig ?? (await this.storage.read<CloudAccessConfig>(CLOUD_CONFIG_PATH))
    const storedAccountConfig =
      this.accountConfig ?? (await this.storage.read<AccountSessionConfig>(ACCOUNT_CONFIG_PATH))
    const accountConfig = storedAccountConfig
      ? await this.ensureFreshAccountToken(storedAccountConfig)
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
    this.accountConfig = {
      apiOrigin: this.cloudApiOrigin,
      profileTokenRef,
      expiresAt: accountConfig?.expiresAt
    }
    await this.storage.write(ACCOUNT_CONFIG_PATH, this.accountConfig)
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
