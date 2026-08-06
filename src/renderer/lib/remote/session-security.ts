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

async function deriveAesGcmKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, [
    'deriveKey'
  ])
  return crypto.subtle.deriveKey(
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
}

/** Encrypt a payload, returning `base64(iv):base64(ciphertext)`. */
export async function encryptPayload(secret: string, plaintext: string): Promise<string> {
  const key = await deriveAesGcmKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext)
  )
  return `${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`
}

/** Decrypt a payload produced by `encryptPayload`. */
export async function decryptPayload(secret: string, payload: string): Promise<string> {
  const separator = payload.indexOf(':')
  if (separator === -1) throw new Error('malformed-encrypted-payload')
  const iv = fromBase64(payload.slice(0, separator))
  const ciphertext = fromBase64(payload.slice(separator + 1))
  const key = await deriveAesGcmKey(secret)
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return decoder.decode(plaintext)
}
