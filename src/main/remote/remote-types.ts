/**
 * Shared remote-mode types used by the main-process remote wiring and the
 * renderer over IPC. `phase` mirrors the `KeepAlivePhase` union in
 * `src/renderer/lib/remote/session-state.ts`.
 */

export type RemoteModePhase =
  'IDLE' | 'KEEP_ALIVE_ARMED' | 'KEEP_ALIVE_ACTIVE' | 'REMOTE_SESSION_LIVE'

export interface RemoteGatewayInfo {
  listening: boolean
  port: number
  /** The URL a phone can open to reach the installable PWA. */
  url: string | null
  /**
   * The pairing URL a human scans as a QR code. Embeds the shared peer secret
   * as `#pair=<secret>` so the phone opens the PWA pre-configured and connects
   * automatically — no typing, no account.
   */
  pairingUrl: string | null
  /**
   * When the pairing value in `pairingUrl` expires (epoch ms). The bootstrap
   * is only valid for five minutes and rotates after enrollment.
   */
  pairingExpiresAt: number | null
}

export interface RemoteCloudStatus {
  configured: boolean
  state: 'disabled' | 'enrollment-pending' | 'connecting' | 'online' | 'offline' | 'error'
  apiOrigin: string | null
  desktopId: string | null
  enrollmentCode: string | null
  enrollmentExpiresAt: number | null
  lastError: string | null
}

/** A phone device known to the desktop (enrolled, connected, or revoked). */
export interface RemoteDeviceInfo {
  id: string
  /** Human-readable device name (reported by the phone or renamed on desktop). */
  name: string
  connectedAt: number
  transport: 'lan' | 'relay'
  /** Whether the device currently holds a live session. */
  connected: boolean
  /** Granted scope identifiers (absent for legacy ephemeral devices). */
  scopes: string[]
  /** SHA-256 fingerprint prefix of the device signing key. */
  fingerprint: string | null
  lastUsedAt: number | null
  /** Device authorization expiry (epoch ms); `null` for legacy devices. */
  expiresAt: number | null
  /** Signed credential lifetime expiry (epoch ms); `null` for legacy devices. */
  credentialExpiresAt: number | null
  revokedAt: number | null
  authVersion: number
  /** Whether the device may reach every project (local explicit choice). */
  allProjects: boolean
  /** Project ids allowed when `allProjects` is false. */
  projectIds: string[]
}

export interface RemoteModeStatus {
  remoteMode: boolean
  phase: RemoteModePhase
  blockedQuit: boolean
  gateway: RemoteGatewayInfo
  cloud: RemoteCloudStatus
  /** Connected phone devices, newest first. */
  devices: RemoteDeviceInfo[]
}
