/**
 * Shared option and handler types for the remote gateway.
 *
 * `remote-gateway.ts` re-exports these so the public surface is unchanged; the
 * peer registry and the gateway both import them from here.
 */

import type { RemoteRpcDeviceContext } from '../../../lib/remote-rpc'
import type { RemoteDeviceInfo } from '../remote-types'

export interface GatewayHandlers {
  /** Called whenever the set of connected phone devices changes. */
  onDevicesChange: (devices: RemoteDeviceInfo[]) => void
  /** Called with the decrypted plaintext of a `remote:data` frame. */
  onData?: (plaintext: string) => void
  /** Called with a decrypted remote RPC invoke; returns the result to reply. */
  onRpc?: (
    channel: string,
    args: unknown[],
    device?: RemoteRpcDeviceContext
  ) => Promise<{ ok: true; result: unknown } | { ok: false; message: string }>
  /** Called when an authenticated phone opens or leaves the remote workspace. */
  onWorkspaceActiveChange?: (deviceId: string, active: boolean) => void
  /** Authenticates a device handshake against the device credential service. */
  authenticateDevice?: (input: {
    nonce: string
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
}

export interface RemoteGatewayOptions {
  /** HTTPS LAN port on 0.0.0.0 (serves the PWA + wss). */
  port: number
  /** HTTP loopback port on 127.0.0.1 (ws only, no static). */
  localPort: number
  peerSecret: string | null
  /** Directory for the persisted self-signed certificate. */
  certificateDir: string
  /** Directory of built renderer assets (only PWA assets are served). */
  staticRoot: string
  handlers: GatewayHandlers
  /** How long an unauthenticated peer may hold a connection open. */
  unauthenticatedTimeoutMs?: number
  /** Exact hosted PWA origins allowed to attempt an authenticated LAN upgrade. */
  allowedOrigins?: string[]
}
