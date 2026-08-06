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
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SECRET_BYTES = 32
const SECRET_FILE = 'peer-secret'

/** Load the persisted peer secret from `directory`, or generate + persist one. */
export async function loadOrCreatePeerSecret(directory: string): Promise<string> {
  const file = join(directory, SECRET_FILE)
  try {
    const existing = (await readFile(file, 'utf8')).trim()
    if (existing.length >= 16) return existing
  } catch {
    // fall through to generation
  }
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  await mkdir(directory, { recursive: true })
  await writeFile(file, secret, { encoding: 'utf8', mode: 0o600 })
  return secret
}
