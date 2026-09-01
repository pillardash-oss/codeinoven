import { describe, expect, it } from 'vitest'
import { createTestDb, destroyTestDb } from './test-helper'
import type { Database } from '../../../src/main/database/database'
import { ThreadRepo } from '../../../src/main/database/repositories/thread-repo'
import { sanitizeThreadSettings } from '../../../src/lib/types'

function seedThread(
  db: Database,
  threadId: string,
  settingsJson: string
): void {
  db.run(
    `INSERT OR IGNORE INTO projects(id, name, path, source, provider_id, workflow_id, thread_limit, change_tracking_mode, created_at, updated_at)
     VALUES('p', 'Project', '/p', 'local', 'openai', 'default', 70, 'manual', 1, 1)`
  )
  db.run(
    `INSERT INTO threads(id, project_id, provider_id, title, status, pinned, archived, read, scope_bucket_id, settings, created_at, updated_at, last_activity)
     VALUES(?, 'p', '', ?, 'created', 0, 0, 1, 'default', ?, 1, 1, 1)`,
    threadId,
    `Thread ${threadId}`,
    settingsJson
  )
}

function settingsOf(db: Database, threadId: string): string | undefined {
  return db.get<{ settings: string }>('SELECT settings FROM threads WHERE id = ?', threadId)
    ?.settings
}

describe('legacy engineeringMode flag scrub', () => {
  it('strips the flag from settings snapshots via sanitizeThreadSettings', () => {
    const persisted = {
      harnessId: 'opencode',
      providerId: 'anthropic',
      modelId: 'claude-sonnet',
      thinkingLevel: 'medium',
      permissionLevel: 'auto_review',
      engineeringMode: true,
      loopMode: false
    }
    const sanitized = sanitizeThreadSettings(persisted)
    expect('engineeringMode' in sanitized).toBe(false)
    expect(sanitized.harnessId).toBe('opencode')
    expect(sanitized.loopMode).toBe(false)
    // Non-object and array inputs sanitize to an empty settings snapshot.
    expect(sanitizeThreadSettings(null)).toEqual({})
    expect(sanitizeThreadSettings(['engineeringMode'])).toEqual({})
  })

  it('rewrites persisted rows on startup and reads them back without the flag', async () => {
    const db = await createTestDb()
    try {
      seedThread(
        db,
        't-legacy',
        JSON.stringify({
          harnessId: 'opencode',
          providerId: 'anthropic',
          modelId: 'claude-sonnet',
          thinkingLevel: 'medium',
          permissionLevel: 'auto_review',
          engineeringMode: true
        })
      )
      seedThread(
        db,
        't-clean',
        JSON.stringify({
          harnessId: 'opencode',
          providerId: 'anthropic',
          modelId: 'claude-sonnet',
          thinkingLevel: 'medium',
          permissionLevel: 'auto_review'
        })
      )
      seedThread(db, 't-malformed', '{not json')

      db.migrateThreadSettingsLegacyEngineeringFlag()

      expect(settingsOf(db, 't-legacy')).not.toContain('engineeringMode')
      expect(JSON.parse(settingsOf(db, 't-legacy') ?? '{}')).toMatchObject({
        harnessId: 'opencode',
        modelId: 'claude-sonnet'
      })
      // Clean rows are left byte-identical.
      expect(settingsOf(db, 't-clean')).not.toContain('engineeringMode')
      // Malformed blobs never abort the migration.
      expect(settingsOf(db, 't-malformed')).toBe('{not json')

      // The repo read path also guards stale rows defensively.
      const repo = new ThreadRepo(db)
      const thread = repo.get('t-legacy')
      expect(thread?.settings).toBeDefined()
      expect('engineeringMode' in (thread?.settings ?? {})).toBe(false)
      expect(thread?.settings?.modelId).toBe('claude-sonnet')
    } finally {
      destroyTestDb(db)
    }
  })

  it('is idempotent: a second pass finds nothing to rewrite', async () => {
    const db = await createTestDb()
    try {
      seedThread(
        db,
        't-legacy',
        JSON.stringify({
          harnessId: 'codex',
          providerId: 'openai',
          modelId: 'gpt-5',
          thinkingLevel: 'high',
          permissionLevel: 'auto_review',
          engineeringMode: false
        })
      )
      db.migrateThreadSettingsLegacyEngineeringFlag()
      const once = settingsOf(db, 't-legacy')
      expect(once).not.toContain('engineeringMode')
      db.migrateThreadSettingsLegacyEngineeringFlag()
      expect(settingsOf(db, 't-legacy')).toEqual(once)
    } finally {
      destroyTestDb(db)
    }
  })
})
