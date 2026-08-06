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
   * as `?pair=<secret>` so the phone opens the PWA pre-configured and connects
   * automatically — no typing, no account.
   */
  pairingUrl: string | null
}

export interface RemoteModeStatus {
  remoteMode: boolean
  phase: RemoteModePhase
  blockedQuit: boolean
  gateway: RemoteGatewayInfo
}
