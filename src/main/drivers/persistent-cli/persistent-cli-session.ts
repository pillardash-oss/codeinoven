import { createHash } from 'crypto'
import type { StorageEngine } from '../../storage/storage-engine'
import type { PersistentCliSession } from './persistent-cli-types'

export function cliProjectPathHash(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex')
}

export function cliSessionPath(driverId: string, sessionId: string): string {
  return `drivers/${driverId}/sessions/${sessionId}.json`
}

export async function requireCliSession(
  storage: StorageEngine,
  driverId: string,
  cache: Map<string, PersistentCliSession>,
  projectPath: string,
  sessionId: string
): Promise<PersistentCliSession> {
  const expectedHash = cliProjectPathHash(projectPath)
  const cached = cache.get(sessionId)
  const session =
    cached ?? (await storage.read<PersistentCliSession>(cliSessionPath(driverId, sessionId)))
  if (!session || session.projectPathHash !== expectedHash) {
    throw new Error(`CLI session is unavailable: ${sessionId}`)
  }
  cache.set(sessionId, session)
  return session
}

export async function persistCliSession(
  storage: StorageEngine,
  driverId: string,
  session: PersistentCliSession
): Promise<void> {
  session.updatedAt = Date.now()
  await storage.write(cliSessionPath(driverId, session.id), session)
}

/**
 * The most recent session record for a thread in this project, or null.
 * Scans this driver's session records by project hash + stamped thread id.
 */
export async function findLatestThreadCliSession(
  storage: StorageEngine,
  driverId: string,
  projectPath: string,
  threadId: string
): Promise<PersistentCliSession | null> {
  const hash = cliProjectPathHash(projectPath)
  let names: string[]
  try {
    names = await storage.list(`drivers/${driverId}/sessions`)
  } catch {
    return null
  }
  let latest: PersistentCliSession | null = null
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const session = await storage.read<PersistentCliSession>(
        `drivers/${driverId}/sessions/${name}`
      )
      if (!session || session.threadId !== threadId || session.projectPathHash !== hash) continue
      if (!latest || session.updatedAt > latest.updatedAt) latest = session
    } catch {
      continue
    }
  }
  return latest
}
