/**
 * Persistent phone device identity.
 *
 * Every phone installs a stable identity (a random `deviceId` plus a
 * human-readable `deviceName`) so the desktop gateway can tell devices apart,
 * remember renames across reconnects, and let the user disconnect or rename a
 * specific phone. The identity is generated once and kept in `localStorage`;
 * the device name can be changed from the desktop (renames are persisted
 * desktop-side too) or locally by the user.
 */

const DEVICE_ID_KEY = 'codeinoven.remote.deviceId'
const DEVICE_NAME_KEY = 'codeinoven.remote.deviceName'
const DEVICE_KEYS_KEY = 'codeinoven.remote.deviceKeys'
const DEVICE_AUTH_VERSION_KEY = 'codeinoven.remote.deviceAuthVersion'

export interface DeviceIdentity {
  id: string
  name: string
}

/**
 * Per-device proof-of-possession key material (A-04). The phone owns an
 * ECDSA P-256 signing key plus an ECDH agreement key. Only the public halves
 * are ever shared; the private signing key proves possession during every
 * handshake so a shared QR secret or a caller-supplied device id is never
 * durable authority.
 */
export interface DeviceKeyMaterial {
  /** Assigned by the desktop at enrollment; null until then. */
  deviceId: string | null
  deviceName: string
  signingPrivateJwk: JsonWebKey
  signingPublicJwk: JsonWebKey
  agreementPublicJwk: JsonWebKey
  authVersion: number
}

const SIGNING_ALGO: EcKeyImportParams = { name: 'ECDSA', namedCurve: 'P-256' }
const AGREEMENT_ALGO: EcKeyImportParams = { name: 'ECDH', namedCurve: 'P-256' }

function randomId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `device-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
}

/** A friendly default device name derived from the user agent. */
export function defaultDeviceName(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/iPad/i.test(ua)) return 'iPad'
  if (/iPhone/i.test(ua)) return 'iPhone'
  if (/Android/i.test(ua)) return 'Android phone'
  if (/Mac/i.test(ua)) return 'Mac'
  if (/Windows/i.test(ua)) return 'Windows PC'
  return 'Phone'
}

/** Load the persisted device identity, creating it on first run. */
export function loadDeviceIdentity(storage: Storage = globalThis.localStorage): DeviceIdentity {
  let id = ''
  let name = ''
  try {
    id = storage.getItem(DEVICE_ID_KEY) ?? ''
    name = storage.getItem(DEVICE_NAME_KEY) ?? ''
  } catch {
    // storage unavailable — fall through to a fresh ephemeral identity
  }
  if (!id) {
    id = randomId()
    try {
      storage.setItem(DEVICE_ID_KEY, id)
    } catch {
      // ephemeral id is fine if storage cannot persist
    }
  }
  if (!name) {
    name = defaultDeviceName()
    try {
      storage.setItem(DEVICE_NAME_KEY, name)
    } catch {
      // ephemeral name is fine if storage cannot persist
    }
  }
  return { id, name }
}

/** Persist a local device name override (used when the phone sets its own). */
export function persistDeviceName(name: string, storage: Storage = globalThis.localStorage): void {
  try {
    storage.setItem(DEVICE_NAME_KEY, name)
  } catch {
    // best-effort
  }
}

async function generateEcKeyPair(algorithm: EcKeyImportParams): Promise<{
  privateJwk: JsonWebKey
  publicJwk: JsonWebKey
}> {
  const pair = await crypto.subtle.generateKey(algorithm, true, [
    ...(algorithm.name === 'ECDSA'
      ? (['sign', 'verify'] as KeyUsage[])
      : (['deriveKey'] as KeyUsage[]))
  ])
  return {
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey)
  }
}

function readStoredKeys(storage: Storage): {
  signingPrivateJwk: JsonWebKey
  signingPublicJwk: JsonWebKey
  agreementPublicJwk: JsonWebKey
} | null {
  try {
    const raw = storage.getItem(DEVICE_KEYS_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const signingPrivate = record['signingPrivateJwk']
    const signingPublic = record['signingPublicJwk']
    const agreement = record['agreementPublicJwk']
    if (typeof signingPrivate !== 'object' || signingPrivate === null) return null
    if (typeof signingPublic !== 'object' || signingPublic === null) return null
    if (typeof agreement !== 'object' || agreement === null) return null
    return {
      signingPrivateJwk: signingPrivate as JsonWebKey,
      signingPublicJwk: signingPublic as JsonWebKey,
      agreementPublicJwk: agreement as JsonWebKey
    }
  } catch {
    return null
  }
}

function readAuthVersion(storage: Storage): number {
  try {
    const raw = storage.getItem(DEVICE_AUTH_VERSION_KEY)
    const parsed = Number.parseInt(raw ?? '', 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
  } catch {
    return 1
  }
}

/**
 * Load (or create) the phone's persistent proof-of-possession keys. The
 * private signing JWK is kept locally and never transmitted.
 */
export async function loadOrCreateDeviceKeyMaterial(
  storage: Storage = globalThis.localStorage
): Promise<DeviceKeyMaterial> {
  let name = ''
  let deviceId: string | null = null
  try {
    name = storage.getItem(DEVICE_NAME_KEY) ?? ''
    const rawId = storage.getItem(DEVICE_ID_KEY)
    deviceId = rawId && rawId.length > 0 ? rawId : null
  } catch {
    // storage unavailable — ephemeral identity
  }
  if (!name) {
    name = defaultDeviceName()
    try {
      storage.setItem(DEVICE_NAME_KEY, name)
    } catch {
      // best-effort
    }
  }
  const existing = readStoredKeys(storage)
  if (existing) {
    return {
      deviceId,
      deviceName: name,
      ...existing,
      authVersion: readAuthVersion(storage)
    }
  }
  const signing = await generateEcKeyPair(SIGNING_ALGO)
  const agreement = await generateEcKeyPair(AGREEMENT_ALGO)
  const material = {
    signingPrivateJwk: signing.privateJwk,
    signingPublicJwk: signing.publicJwk,
    agreementPublicJwk: agreement.publicJwk
  }
  try {
    storage.setItem(DEVICE_KEYS_KEY, JSON.stringify(material))
    storage.setItem(DEVICE_AUTH_VERSION_KEY, '1')
  } catch {
    // storage unavailable — keys stay ephemeral for this session
  }
  return { deviceId, deviceName: name, ...material, authVersion: 1 }
}

/** Persist the desktop-assigned device id after the enrollment handshake. */
export function saveAssignedDeviceId(
  deviceId: string,
  storage: Storage = globalThis.localStorage
): void {
  try {
    storage.setItem(DEVICE_ID_KEY, deviceId)
  } catch {
    // best-effort
  }
}

/** Persist a bumped authVersion (after a desktop-issued rotation). */
export function saveDeviceAuthVersion(
  authVersion: number,
  storage: Storage = globalThis.localStorage
): void {
  try {
    storage.setItem(DEVICE_AUTH_VERSION_KEY, String(authVersion))
  } catch {
    // best-effort
  }
}

/** Clear the phone's device identity + keys (used by "forget device data"). */
export function clearDeviceIdentity(storage: Storage = globalThis.localStorage): void {
  try {
    storage.removeItem(DEVICE_ID_KEY)
    storage.removeItem(DEVICE_KEYS_KEY)
    storage.removeItem(DEVICE_AUTH_VERSION_KEY)
  } catch {
    // best-effort
  }
}

const encoder = new TextEncoder()

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

/** ECDSA P-256/SHA-256 signature over a transcript (proof of possession). */
export async function signTranscript(privateJwk: JsonWebKey, transcript: string): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', privateJwk, SIGNING_ALGO, false, ['sign'])
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    encoder.encode(transcript)
  )
  return toBase64Url(new Uint8Array(signature))
}

/**
 * The exact transcript the phone signs for a handshake. For a new device it
 * binds the enrollment to the single-use pairing bootstrap; for an enrolled
 * device it binds the signature to the device identity and credential version.
 * LAN and relay transcripts are distinct so a captured signature cannot be
 * replayed across transports.
 */
export function handshakeTranscript(input: {
  nonce: string
  deviceId?: string | null
  authVersion?: number
  bootstrap?: string | null
  context?: 'lan' | 'relay'
}): string {
  const prefix = input.context === 'relay' ? 'codeinoven:relay' : 'codeinoven'
  if (input.deviceId) {
    return `${prefix}:auth:${input.nonce}:${input.deviceId}:${input.authVersion ?? 1}`
  }
  return `${prefix}:enroll:${input.bootstrap ?? ''}:${input.nonce}`
}
