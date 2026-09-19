import { stat } from 'node:fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { PersistentCliSession } from '../persistent-cli/persistent-cli-types'
import type { MuseTurnState } from './muse-parts'

/** Session-log tail cadence for the current turn's reasoning/tool backfill. */
export const MUSE_SESSION_LOG_POLL_MS = 800
/** How long the tailer keeps looking for the log file before giving up. */
export const MUSE_SESSION_LOG_FIND_TIMEOUT_MS = 60_000
/** How long after process exit the tailer keeps catching final flushes. */
export const MUSE_SESSION_LOG_TAIL_GRACE_MS = 4_000

/** Incremental tail state for one turn's Muse session log. */
export interface MuseSessionLogWatcher {
  turnState: MuseTurnState
  session: PersistentCliSession
  projectPath: string
  museSessionId: string
  logPath: string | null
  offset: number
  pending: string
  giveUpAfter: number
  timer: ReturnType<typeof setInterval> | null
  stopTimer: ReturnType<typeof setTimeout> | null
  stopping: boolean
}

/**
 * Locate the durable session log Muse writes for a run:
 * `~/.local/share/muse/sessions/<YYYY>/<MM>/<DD>/<run-uuid>/session.jsonl`.
 * Date directories use the local clock; probe today/yesterday in local and UTC
 * so a run crossing midnight still resolves. Returns null while the log has
 * not appeared yet.
 */
export async function findMuseSessionLog(museSessionId: string): Promise<string | null> {
  const root = join(homedir(), '.local', 'share', 'muse', 'sessions')
  const stamps: string[] = []
  for (const base of [new Date(), new Date(Date.now() - 26 * 60 * 60 * 1000)]) {
    stamps.push(
      `${base.getFullYear()}/${String(base.getMonth() + 1).padStart(2, '0')}/${String(
        base.getDate()
      ).padStart(2, '0')}`
    )
    stamps.push(
      `${base.getUTCFullYear()}/${String(base.getUTCMonth() + 1).padStart(2, '0')}/${String(
        base.getUTCDate()
      ).padStart(2, '0')}`
    )
  }
  for (const stamp of [...new Set(stamps)]) {
    const candidate = join(root, stamp, museSessionId, 'session.jsonl')
    try {
      const info = await stat(candidate)
      if (info.isFile()) return candidate
    } catch {
      // Not written yet   keep probing until the finder timeout.
    }
  }
  return null
}
