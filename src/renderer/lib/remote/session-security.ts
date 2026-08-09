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
/** Maximum ciphertext bytes accepted before decryption (1 MiB). */
export const MAX_ENCRYPTED_PAYLOAD_BYTES = 1024 * 1024
/**
 * Maximum raw encrypted envelope length (the complete payload string) accepted
 * before any splitting or hashing. Accounts for base64 expansion and the
 * version/timestamp/IV prefix so no payload under the ciphertext cap is
 * rejected; anything longer is oversized by construction.
 */
export const MAX_RAW_PAYLOAD_CHARS = Math.ceil((MAX_ENCRYPTED_PAYLOAD_BYTES * 4) / 3) + 128
/** Maximum decrypted plaintext bytes accepted before decoding (768 KiB). */
export const MAX_PLAINTEXT_BYTES = 768 * 1024
/** Maximum number of replay identifiers retained (bounded, fixed-size entries). */
export const MAX_REPLAY_CACHE = 4_096
/**
 * Replay protection stores SHA-256 hashes of each encrypted payload, never the
 * ciphertext itself, so the retained identifiers are fixed-size and bounded.
 */
const decryptedPayloads = new Set<string>()
const decryptingPayloads = new Set<string>()

/** Number of replay identifiers currently retained (development/test helper). */
export function replayCacheSize(): number {
  return decryptedPayloads.size
}

async function replayId(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(payload))
  return toBase64(new Uint8Array(digest))
}

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

/** Derived keys are deterministic per secret, so retain a small LRU. */
export const MAX_DERIVED_KEY_CACHE_ENTRIES = 8
const KEY_CACHE = new Map<string, CryptoKey>()

async function deriveAesGcmKey(secret: string): Promise<CryptoKey> {
  const cached = KEY_CACHE.get(secret)
  if (cached) {
    KEY_CACHE.delete(secret)
    KEY_CACHE.set(secret, cached)
    return cached
  }
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
  while (KEY_CACHE.size > MAX_DERIVED_KEY_CACHE_ENTRIES) {
    const oldest = KEY_CACHE.keys().next().value as string | undefined
    if (!oldest) break
    KEY_CACHE.delete(oldest)
  }
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
  // Reject an oversized raw envelope before any split, hash, or base64 work.
  if (payload.length > MAX_RAW_PAYLOAD_CHARS) {
    throw new Error('oversized-encrypted-payload')
  }
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
  const ciphertextBase64 = parts[versioned ? 3 : 1] ?? ''
  // Keep the decoded segment cap: bound the base64 ciphertext before decoding
  // it so a decoded payload that slips under the raw string bound still fails
  // before a large allocation.
  const estimatedCiphertextBytes = Math.ceil((ciphertextBase64.length * 3) / 4)
  if (estimatedCiphertextBytes > MAX_ENCRYPTED_PAYLOAD_BYTES) {
    throw new Error('oversized-encrypted-payload')
  }
  const id = await replayId(payload)
  if (decryptedPayloads.has(id) || decryptingPayloads.has(id)) {
    throw new Error('replayed-encrypted-payload')
  }
  decryptingPayloads.add(id)
  try {
    const iv = fromBase64(parts[versioned ? 2 : 0] ?? '')
    const ciphertext = fromBase64(ciphertextBase64)
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
    if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
      throw new Error('oversized-plaintext-payload')
    }
    decryptedPayloads.add(id)
    if (decryptedPayloads.size > MAX_REPLAY_CACHE) {
      const oldest = decryptedPayloads.values().next().value
      if (typeof oldest === 'string') decryptedPayloads.delete(oldest)
    }
    return decoder.decode(plaintext)
  } finally {
    decryptingPayloads.delete(id)
  }
}
