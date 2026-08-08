/**
 * Session security helpers shared by the LAN and relay handshakes.
 *
 * - `createHandshakeToken` / `verifyHandshakeToken`: HMAC-SHA256 over a nonce,
 *   keyed by `PEER_SECRET_AUTH`. The raw secret never crosses the wire.
 * - `encryptPayload` / `decryptPayload`: AES-GCM (Web Crypto) so session
 *   traffic is encrypted end to end regardless of transport.
 *
 * The module never logs secrets and only uses the platform Web Crypto API.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const SALT = encoder.encode('codeinoven-remote-session')
const PBKDF2_ITERATIONS = 120_000
const IV_LENGTH = 12
const PAYLOAD_VERSION = 'v2'
const MAX_PAYLOAD_AGE_MS = 5 * 60 * 1_000
const MAX_CLOCK_SKEW_MS = 60 * 1_000
const MAX_REPLAY_CACHE = 4_096
const decryptedPayloads = new Set<string>()
const decryptingPayloads = new Set<string>()

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return diff === 0
}

/** A fresh random nonce, base64-encoded. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return toBase64(bytes)
}

/** HMAC-SHA256 token over the nonce, keyed by the shared auth secret. */
export async function createHandshakeToken(secret: string, nonce: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(nonce))
  return toBase64(new Uint8Array(signature))
}

/** Verify a presented handshake token against the shared secret and nonce. */
export async function verifyHandshakeToken(
  secret: string,
  nonce: string,
  token: string
): Promise<boolean> {
  const expected = await createHandshakeToken(secret, nonce)
  return constantTimeEqual(expected, token)
}

/**
 * Authenticate a handshake presented by a peer. Rejects when no secret is
 * configured (a secret is mandatory for every handshake) or the token does
 * not verify.
 */
export async function authenticateHandshake(
  secret: string | null,
  nonce: string,
  token: string
): Promise<boolean> {
  if (!secret) return false
  return verifyHandshakeToken(secret, nonce, token)
}

/** Derived keys are deterministic per secret, so cache them per session. */
const KEY_CACHE = new Map<string, CryptoKey>()

async function deriveAesGcmKey(secret: string): Promise<CryptoKey> {
  const cached = KEY_CACHE.get(secret)
  if (cached) return cached
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, [
    'deriveKey'
  ])
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: SALT,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
  KEY_CACHE.set(secret, key)
  return key
}

/** Encrypt a timestamp-bound payload for replay-resistant transport. */
export async function encryptPayload(secret: string, plaintext: string): Promise<string> {
  const key = await deriveAesGcmKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const timestamp = Date.now().toString(36)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(`${PAYLOAD_VERSION}:${timestamp}`) },
    key,
    encoder.encode(plaintext)
  )
  return `${PAYLOAD_VERSION}:${timestamp}:${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`
}

/** Decrypt a payload produced by `encryptPayload`. */
export async function decryptPayload(secret: string, payload: string): Promise<string> {
  if (decryptedPayloads.has(payload) || decryptingPayloads.has(payload)) {
    throw new Error('replayed-encrypted-payload')
  }
  decryptingPayloads.add(payload)
  try {
    const parts = payload.split(':')
    const versioned = parts[0] === PAYLOAD_VERSION
    if ((!versioned && parts.length !== 2) || (versioned && parts.length !== 4)) {
      throw new Error('malformed-encrypted-payload')
    }
    const timestamp = versioned ? parts[1] : null
    if (timestamp) {
      const sentAt = Number.parseInt(timestamp, 36)
      const age = Date.now() - sentAt
      if (!Number.isFinite(sentAt) || age > MAX_PAYLOAD_AGE_MS || age < -MAX_CLOCK_SKEW_MS) {
        throw new Error('expired-encrypted-payload')
      }
    }
    const iv = fromBase64(parts[versioned ? 2 : 0] ?? '')
    const ciphertext = fromBase64(parts[versioned ? 3 : 1] ?? '')
    const key = await deriveAesGcmKey(secret)
    const plaintext = await crypto.subtle.decrypt(
      timestamp
        ? {
            name: 'AES-GCM',
            iv,
            additionalData: encoder.encode(`${PAYLOAD_VERSION}:${timestamp}`)
          }
        : { name: 'AES-GCM', iv },
      key,
      ciphertext
    )
    decryptedPayloads.add(payload)
    if (decryptedPayloads.size > MAX_REPLAY_CACHE) {
      const oldest = decryptedPayloads.values().next().value
      if (typeof oldest === 'string') decryptedPayloads.delete(oldest)
    }
    return decoder.decode(plaintext)
  } finally {
    decryptingPayloads.delete(payload)
  }
}
