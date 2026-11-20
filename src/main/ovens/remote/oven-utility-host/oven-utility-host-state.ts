/**
 * Where the utility host publishes itself, and how a client finds it again.
 *
 * The state file is the whole discovery story: a relay or a client process on
 * the same machine reads `<data root>/utility-host/state.json`, learns the
 * port and the machine credential, and never needs to be told either out of
 * band. It is written 0600 inside a 0700 folder, so an unrelated account on a
 * shared Oven cannot mint its own turn.
 */
import { chmod, mkdir, open, readFile, unlink } from 'node:fs/promises'
import {
  OVEN_UTILITY_HOST_DIRECTORY,
  OVEN_UTILITY_HOST_STATE_FILE,
  type OvenUtilityHostState
} from '../../../../lib/oven-utility-host'
import { ovenDataRoot } from '../oven-root-paths'

/** How long a client waits for the host's state file to appear. */
export const OVEN_UTILITY_HOST_WAIT_MS = 10_000
/** Poll step while waiting for the host, or for it to be gone. */
export const OVEN_UTILITY_HOST_POLL_MS = 100

/** The folder an Oven's utility host owns under its data root. */
export function ovenUtilityHostDirectory(home: string): string {
  return `${ovenDataRoot(home)}/${OVEN_UTILITY_HOST_DIRECTORY}`
}

/** The one file that names the running host. */
export function ovenUtilityHostStatePath(home: string): string {
  return `${ovenUtilityHostDirectory(home)}/${OVEN_UTILITY_HOST_STATE_FILE}`
}

/**
 * Publish a running host.
 *
 * Rewritten in place rather than written beside and renamed: the file is only
 * ever read by a process that was looking for a host, and a reader that catches
 * a half-written file simply retries on its next poll.
 */
export async function writeOvenUtilityHostState(
  home: string,
  state: OvenUtilityHostState
): Promise<void> {
  await mkdir(ovenUtilityHostDirectory(home), { recursive: true, mode: 0o700 })
  const path = ovenUtilityHostStatePath(home)
  const file = await open(path, 'w', 0o600)
  try {
    await file.writeFile(JSON.stringify(state))
    await file.sync()
  } finally {
    await file.close()
  }
  // `open` applies its mode only when it creates the file, so a state file left
  // behind by a host that crashed keeps whatever permissions it had without this.
  await chmod(path, 0o600)
}

/**
 * Withdraw the published state, but only if it is still this host's.
 *
 * A host that was replaced by a newer one during a service update must not
 * delete its successor's file on the way out.
 */
export async function removeOvenUtilityHostState(home: string, hostToken: string): Promise<void> {
  const state = await readOvenUtilityHostState(home)
  if (state && state.hostToken !== hostToken) return
  await unlink(ovenUtilityHostStatePath(home)).catch(() => undefined)
}

/** Read the published host, or null when nothing is listening. */
export async function readOvenUtilityHostState(home: string): Promise<OvenUtilityHostState | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(ovenUtilityHostStatePath(home), 'utf8'))
  } catch {
    return null
  }
  return ovenUtilityHostState(parsed)
}

/** Wait for a host to publish itself, giving up after `timeoutMs`. */
export async function waitForOvenUtilityHostState(
  home: string,
  timeoutMs: number = OVEN_UTILITY_HOST_WAIT_MS
): Promise<OvenUtilityHostState | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = await readOvenUtilityHostState(home)
    if (state) return state
    if (Date.now() >= deadline) return null
    await new Promise<void>((resolve) => setTimeout(resolve, OVEN_UTILITY_HOST_POLL_MS))
  }
}

/** One state file, validated: a truncated or hand-edited file reads as no host. */
function ovenUtilityHostState(value: unknown): OvenUtilityHostState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const protocolVersion = record['protocolVersion']
  const revision = record['revision']
  const port = record['port']
  const hostToken = record['hostToken']
  const pid = record['pid']
  const startedAt = record['startedAt']
  if (typeof protocolVersion !== 'number' || !Number.isSafeInteger(protocolVersion)) return null
  if (typeof revision !== 'string') return null
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port <= 0 || port > 65_535)
    return null
  if (typeof hostToken !== 'string' || hostToken.length === 0) return null
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null
  return { protocolVersion, revision, port, hostToken, pid, startedAt }
}
