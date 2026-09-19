/**
 * LAN device authentication for remote mode.
 *
 * Phones authenticate by proving possession of their signing key (ECDSA over
 * the challenge transcript); first-time enrollment additionally presents a
 * single-use pairing bootstrap and the device's public keys. The shared secret
 * is never a durable authority: on the LAN-exposed listener it only authorizes
 * the one-shot enrollment; every session still requires device proof.
 */

import { handshakeTranscript } from '../../../renderer/lib/remote/device-identity'
import type { DeviceCredentialService, EnrolledDevice } from '../device-credential-service'
import type { RemoteDeviceInfo } from '../remote-types'

export type GatewayAuthHandler = (input: {
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

export interface LanDeviceAuthenticatorOptions {
  credentials: DeviceCredentialService | null
  /** Enrolled-device record to display-facing `RemoteDeviceInfo`. */
  toDeviceInfo: (device: EnrolledDevice, connected: boolean) => RemoteDeviceInfo
}

export function createLanDeviceAuthenticator(
  options: LanDeviceAuthenticatorOptions
): GatewayAuthHandler {
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
    const credentials = options.credentials
    if (signature && credentials) {
      // The canonical LAN transcript is recomputed server-side from the
      // desktop-issued challenge nonce plus the identity/bootstraps   never
      // taken from the peer   so a captured proof cannot be replayed.
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
        return { accepted: true, device: options.toDeviceInfo(outcome.device, true) }
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
        return { accepted: true, device: options.toDeviceInfo(result.device, true) }
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
