/**
 * The credentials a turn's MCP servers run with, resolved on this Oven.
 *
 * The app normally resolves a utility's vault on its own side and ships the
 * result inside the turn, so the Oven runs a server it never had to ask about.
 * Two things make that insufficient here:
 *
 * 1. A client with no app behind it (an Oven-local harness, the `cio-oven` CLI)
 *    has no vault to resolve, and would otherwise start a server with no token.
 * 2. A credential rotates on the app's side, and this machine is where the new
 *    value has to land, or every later turn keeps using the old one.
 *
 * So the precedence is the app's: what the turn carries wins for that turn, and
 * while the store is enabled it is written back. When the turn carries nothing
 * for a utility, the stored bundle fills in. The merge is per key, because a
 * rotation usually moves one token and leaves the rest alone.
 *
 * Nothing is cached. The store is read for every local call that can open a
 * server, so a secret forgotten while the host is running is gone from the very
 * next turn rather than from the next host.
 */
import type {
  OvenUtilityMcpServer,
  OvenUtilityStoredSecret,
  OvenUtilityTurn,
  OvenUtilityTurnUtility
} from '../../../../lib/oven-utility-host'
import { Logger } from '../../../system/logger'
import type { OvenUtilityCredentialStore } from './oven-utility-secrets'

/**
 * Resolve every server in a turn against this machine's stored credentials.
 *
 * The same turn object comes back when nothing was filled in, which keeps the
 * common case free of copies and makes "nothing changed" visible to callers.
 */
export async function resolveOvenUtilityTurnCredentials(
  turn: OvenUtilityTurn,
  store: OvenUtilityCredentialStore
): Promise<OvenUtilityTurn> {
  const utilities = await Promise.all(
    turn.utilities.map(async (utility): Promise<OvenUtilityTurnUtility> => {
      if (!utility.server) return utility
      const server = await resolveOvenUtilityServerCredentials(utility.server, store)
      return server === utility.server ? utility : { ...utility, server }
    })
  )
  if (utilities.every((utility, index) => utility === turn.utilities[index])) return turn
  return { ...turn, utilities }
}

/**
 * Resolve one server's env and headers.
 *
 * A turn's own values are applied last, so they win; the stored bundle supplies
 * whatever the turn left out. The write-back happens whenever the turn carried a
 * credential at all, which is what carries a rotation to this machine, and the
 * store itself refuses while it is disabled.
 */
async function resolveOvenUtilityServerCredentials(
  server: OvenUtilityMcpServer,
  store: OvenUtilityCredentialStore
): Promise<OvenUtilityMcpServer> {
  const carriedEnv = server.env ?? {}
  const carriedHeaders = server.headers ?? {}
  const carried = hasEntries(carriedEnv) || hasEntries(carriedHeaders)
  const stored = await readStoredBundle(store, server.utilityId)
  const env = { ...(stored?.env ?? {}), ...carriedEnv }
  const headers = { ...(stored?.headers ?? {}), ...carriedHeaders }
  // Write back only what this machine does not already say. A turn that repeats
  // the same credential on every call must not turn each call into a keychain
  // write, while a rotation is by definition a difference and always lands.
  if (carried && !sameBundle(stored, env, headers))
    await keepBundle(store, server.utilityId, env, headers)
  const envChanged = !sameEntries(env, carriedEnv)
  const headersChanged = !sameEntries(headers, carriedHeaders)
  if (!envChanged && !headersChanged) return server
  return {
    ...server,
    ...(hasEntries(env) ? { env } : {}),
    ...(hasEntries(headers) ? { headers } : {})
  }
}

/** The stored bundle for one utility, or null when it cannot be read at all. */
async function readStoredBundle(
  store: OvenUtilityCredentialStore,
  utilityId: string
): Promise<OvenUtilityStoredSecret | null> {
  try {
    return await store.stored(utilityId)
  } catch (error) {
    // A locked keychain must not fail the turn: it only means this machine
    // cannot supply what the turn did not carry. The message carries the reason
    // the backend reported, never a value.
    Logger.error(
      `An Oven could not read the stored credential for \`${utilityId}\`; the turn's own credentials were used.`,
      error instanceof Error ? error.message : 'The credential store failed.'
    )
    return null
  }
}

/** Write a turn's credentials back, so a rotation reaches this machine. */
async function keepBundle(
  store: OvenUtilityCredentialStore,
  utilityId: string,
  env: Record<string, string>,
  headers: Record<string, string>
): Promise<void> {
  try {
    await store.remember({
      utilityId,
      env,
      ...(hasEntries(headers) ? { headers } : {})
    })
  } catch (error) {
    // The turn still runs with what it carried; only the at-rest copy is missing.
    Logger.error(
      `An Oven could not keep the credential for \`${utilityId}\` at rest; this turn still uses it.`,
      error instanceof Error ? error.message : 'The credential store failed.'
    )
  }
}

function hasEntries(record: Record<string, string>): boolean {
  return Object.keys(record).length > 0
}

/** Whether the stored bundle already says exactly what this turn would keep. */
function sameBundle(
  stored: OvenUtilityStoredSecret | null,
  env: Record<string, string>,
  headers: Record<string, string>
): boolean {
  return (
    stored !== null && sameEntries(stored.env, env) && sameEntries(stored.headers ?? {}, headers)
  )
}

/** Whether two credential maps say exactly the same thing. */
function sameEntries(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every((key) => left[key] === right[key])
}
