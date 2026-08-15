/**
 * SQLite repository for the desktop account profile cache.
 *
 * Mirrors the last validated remote account profile (id, avatar, display name,
 * email, usage, global memories) so an app restart or an offline window keeps
 * the signed-in identity without a network round-trip. The row is replaced only
 * when a fresh profile is fetched and removed only when the user explicitly
 * signs out. No secrets are ever stored here — the session token stays in the
 * OS-backed vault.
 */

import type { Database } from '../database'
import type { AccountProfile } from '../../../lib/types'

interface AccountProfileRow {
  id: string
  profile_json: string
  cached_at: number
}

export class AccountProfileRepo {
  constructor(private db: Database) {}

  save(profile: AccountProfile): void {
    this.db.run(
      `INSERT INTO account_profile(id, profile_json, cached_at)
       VALUES(?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         profile_json = excluded.profile_json,
         cached_at = excluded.cached_at`,
      profile.id,
      JSON.stringify(profile),
      Date.now()
    )
  }

  load(): AccountProfile | null {
    const row = this.db.get<AccountProfileRow>(
      'SELECT * FROM account_profile ORDER BY cached_at DESC LIMIT 1'
    )
    if (!row) return null
    return parseCachedProfile(row.profile_json)
  }

  clear(): void {
    this.db.run('DELETE FROM account_profile')
  }
}

/** Best-effort parse of a stored cache row; a corrupt row must never break sign-in. */
function parseCachedProfile(raw: string): AccountProfile | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const profile = value as Record<string, unknown>
    if (
      typeof profile['id'] !== 'string' ||
      typeof profile['email'] !== 'string' ||
      typeof profile['displayName'] !== 'string' ||
      (profile['image'] !== null && typeof profile['image'] !== 'string') ||
      typeof profile['updatedAt'] !== 'number' ||
      typeof profile['usage'] !== 'object' ||
      profile['usage'] === null ||
      !Array.isArray(profile['globalMemories'])
    ) {
      return null
    }
    return profile as unknown as AccountProfile
  } catch {
    return null
  }
}
