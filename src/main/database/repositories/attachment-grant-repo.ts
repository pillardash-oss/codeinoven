import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from '../database'

interface AttachmentGrantExecutor {
  run(sql: string, ...params: unknown[]): void
}

interface GrantableMessage {
  id: string
  threadId: string
  sessionId: string | null
  role: string
  partsJson: string
  createdAt: number
}

interface PersistedUserMessageRow {
  id: string
  thread_id: string
  parts: string
  created_at: number
}

const ATTACHMENT_GRANTS_BACKFILL_KEY = 'attachment_grants_backfilled_v1'

const ATTACHMENT_GRANTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS attachment_grants (
  message_id      TEXT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
  thread_id       TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  canonical_path  TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (message_id, canonical_path)
)`

const ATTACHMENT_GRANTS_PATH_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_attachment_grants_canonical_path ON attachment_grants(canonical_path)'

export function ensureAttachmentGrantSchema(executor: AttachmentGrantExecutor): void {
  executor.run(ATTACHMENT_GRANTS_TABLE_SQL)
  executor.run(ATTACHMENT_GRANTS_PATH_INDEX_SQL)
}

function pathFromFileUrl(url: string): string | null {
  if (!url.startsWith('file://')) return null
  try {
    return fileURLToPath(url)
  } catch {
    const fallback = url.slice('file://'.length)
    return isAbsolute(fallback) ? fallback : null
  }
}

function canonicalPaths(partsJson: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(partsJson)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const paths = new Set<string>()
  for (const value of parsed) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const part = value as Record<string, unknown>
    if (part.type !== 'file' || typeof part.url !== 'string') continue
    const localPath = pathFromFileUrl(part.url)
    if (!localPath) continue
    try {
      paths.add(realpathSync.native(localPath))
    } catch {
      // Missing attachments are intentionally not granted or logged.
    }
  }
  return [...paths]
}

export function attachmentGrantStatements(
  message: GrantableMessage
): Array<{ sql: string; params: unknown[] }> {
  const statements: Array<{ sql: string; params: unknown[] }> = [
    { sql: 'DELETE FROM attachment_grants WHERE message_id = ?', params: [message.id] }
  ]
  if (message.role !== 'user' || message.sessionId !== null) return statements

  for (const canonicalPath of canonicalPaths(message.partsJson)) {
    statements.push({
      sql: `INSERT OR IGNORE INTO attachment_grants(
        message_id, thread_id, canonical_path, created_at
      ) VALUES(?,?,?,?)`,
      params: [message.id, message.threadId, canonicalPath, message.createdAt]
    })
  }
  return statements
}

export function syncAttachmentGrants(
  executor: AttachmentGrantExecutor,
  message: GrantableMessage
): void {
  for (const statement of attachmentGrantStatements(message)) {
    executor.run(statement.sql, ...statement.params)
  }
}

/** Durable exact-file grants derived only from persisted user-authored attachments. */
export class AttachmentGrantRepo {
  constructor(private readonly db: Database) {
    ensureAttachmentGrantSchema(db)
    this.backfillPersistedUserAttachments()
  }

  isApproved(canonicalPath: string): boolean {
    return (
      this.db.get<{ approved: number }>(
        'SELECT 1 AS approved FROM attachment_grants WHERE canonical_path = ? LIMIT 1',
        canonicalPath
      )?.approved === 1
    )
  }

  private backfillPersistedUserAttachments(): void {
    const complete =
      this.db.get<{ value: string }>(
        'SELECT value FROM db_meta WHERE key = ?',
        ATTACHMENT_GRANTS_BACKFILL_KEY
      )?.value === '1'
    if (complete) return

    const rows = this.db.all<PersistedUserMessageRow>(
      `SELECT id, thread_id, parts, created_at
       FROM agent_messages
       WHERE role = 'user' AND session_id IS NULL AND parts LIKE '%"type":"file"%'`
    )
    this.db.transaction(() => {
      for (const row of rows) {
        syncAttachmentGrants(this.db, {
          id: row.id,
          threadId: row.thread_id,
          sessionId: null,
          role: 'user',
          partsJson: row.parts,
          createdAt: row.created_at
        })
      }
      this.db.run(
        'INSERT OR REPLACE INTO db_meta(key, value) VALUES(?, ?)',
        ATTACHMENT_GRANTS_BACKFILL_KEY,
        '1'
      )
    })
  }
}
