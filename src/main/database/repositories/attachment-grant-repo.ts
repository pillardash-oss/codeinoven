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
  constructor(private readonly db: Database) {}

  isApproved(canonicalPath: string): boolean {
    return (
      this.db.get<{ approved: number }>(
        'SELECT 1 AS approved FROM attachment_grants WHERE canonical_path = ? LIMIT 1',
        canonicalPath
      )?.approved === 1
    )
  }
}
