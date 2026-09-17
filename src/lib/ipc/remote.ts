/** Remote-mode keep-alive phase, mirroring the renderer's `KeepAlivePhase`. */
export type RemoteModePhase =
  'IDLE' | 'KEEP_ALIVE_ARMED' | 'KEEP_ALIVE_ACTIVE' | 'REMOTE_SESSION_LIVE'

export interface RemoteGatewayInfo {
  listening: boolean
  port: number
  /** The URL a phone can open to reach the installable PWA. */
  url: string | null
  /** Ordered Wi-Fi/Ethernet endpoint candidates for multi-homed desktops. */
  urls: string[]
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
  /** Granted scope identifiers. */
  scopes: string[]
  /** SHA-256 fingerprint prefix of the device signing key. */
  fingerprint: string | null
  lastUsedAt: number | null
  /** Device authorization expiry (epoch ms). */
  expiresAt: number | null
  /** Signed credential lifetime expiry (epoch ms). */
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

/** A pending single-use local step-up approval awaiting desktop disposition. */
export interface RemotePendingStepUpApproval {
  approvalId: string
  deviceId: string
  channel: string
  action: string
  resource: string | null
  expiresAt: number
}

/** A redacted security audit record: never contains secrets or content. */
export interface RemoteAuditEventInfo {
  id: string
  timestamp: number
  deviceId: string | null
  deviceName: string | null
  fingerprintPrefix: string | null
  channel: string | null
  projectId: string | null
  requiredScope: string | null
  decision: string
  reasonCode: string | null
  stepUpApprovalId: string | null
  authVersion: number | null
}
