/**
 * Persisted peer pairing secret for the LAN gateway.
 *
 * The phone client handshake and payload encryption are keyed by a shared
 * secret (`PEER_SECRET_AUTH`). For a human-friendly LAN flow the desktop must
 * work with **zero configuration**, so when the operator has not supplied a
 * secret through the environment, the main process generates a random one and
 * persists it under the app's user-data directory. The generated secret is
 * stable across restarts and is delivered to the phone through the QR pairing
 * URL, so neither the human nor any environment file ever needs to know it.
 *
 * An operator-provided `PEER_SECRET_AUTH` always takes precedence; the
 * persisted secret is only a fallback so LAN pairing works out of the box.
 *
 * Since the 2026-08-08 remediation (A-04), the shared secret is treated as a
 * short-lived **pairing bootstrap**: it may enroll a device but never grants
 * RPC authority on its own (device records carry the actual scoped
 * credentials). The bootstrap expires `PAIRING_TTL_MS` (five minutes) after
 * it is issued. The persisted value also encrypts transport payloads, so
 * refreshing an enrollment window must not rotate it and invalidate grants
 * held by already approved phones.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SECRET_BYTES = 32
const SECRET_FILE = 'peer-secret'
const EXPIRY_FILE = 'peer-secret.expiresAt'

/** A pairing bootstrap is only valid for five minutes. */
export const PAIRING_TTL_MS = 5 * 60 * 1_000

/** Load the persisted peer secret from `directory`, or generate + persist one. */
export async function loadOrCreatePeerSecret(directory: string): Promise<string> {
  const file = join(directory, SECRET_FILE)
  let existing = ''
  try {
    existing = (await readFile(file, 'utf8')).trim()
  } catch {
    // fall through to generation
  }
  if (existing.length >= 16) {
    await ensurePairingExpiry(directory)
    return existing
  }
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  await mkdir(directory, { recursive: true })
  await writeFile(file, secret, { encoding: 'utf8', mode: 0o600 })
  await writePairingExpiry(directory, Date.now() + PAIRING_TTL_MS)
  return secret
}

/** Read the persisted bootstrap expiry, or `null` when unknown. */
export async function readPairingExpiry(directory: string): Promise<number | null> {
  try {
    const raw = (await readFile(join(directory, EXPIRY_FILE), 'utf8')).trim()
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Write the bootstrap expiry sidecar (used by tests and the controller). */
export async function writePairingExpiry(directory: string, expiresAt: number): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, EXPIRY_FILE), String(expiresAt), {
    encoding: 'utf8',
    mode: 0o600
  })
}

/** Ensure a fresh bootstrap always carries an expiry. */
async function ensurePairingExpiry(directory: string): Promise<void> {
  if ((await readPairingExpiry(directory)) === null) {
    await writePairingExpiry(directory, Date.now() + PAIRING_TTL_MS)
  }
}

/** Whether the persisted bootstrap has expired (a stale QR must not connect). */
export async function isPairingExpired(directory: string, now = Date.now()): Promise<boolean> {
  const expiresAt = await readPairingExpiry(directory)
  return expiresAt !== null && expiresAt < now
}

/**
 * Rotate the pairing bootstrap after enrollment: replace the persisted secret
 * and stamp a fresh five-minute expiry so older QR codes are invalidated.
 */
export async function rotatePeerSecret(directory: string): Promise<string> {
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, SECRET_FILE), secret, { encoding: 'utf8', mode: 0o600 })
  await writePairingExpiry(directory, Date.now() + PAIRING_TTL_MS)
  return secret
}
