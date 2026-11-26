import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { versionFifteenMigration } from '../../../src/main/database/migrations/v015'

/**
 * The corpus repair: rows written before search was narrowed to the
 * conversation's words still carry reasoning and sub-agent cards, so a search
 * matched text the user was never shown. The migration rewrites those rows and
 * bumps the thread stamp the embedding index uses to notice stale windows.
 */

function migratedDatabase(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'local'
    );
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, provider_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', title_source TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL DEFAULT 'created', working_directory TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_activity INTEGER NOT NULL
    );
    CREATE TABLE agent_messages (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'provider', visibility TEXT NOT NULL DEFAULT 'conversation',
      parts TEXT NOT NULL DEFAULT '[]', search_text TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE agent_messages_fts USING fts5(
      search_text, content='agent_messages', content_rowid='rowid', tokenize='porter unicode61'
    );
    CREATE TRIGGER agent_messages_fts_insert AFTER INSERT ON agent_messages BEGIN
      INSERT INTO agent_messages_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
    END;
    CREATE TRIGGER agent_messages_fts_update AFTER UPDATE ON agent_messages
    WHEN new.search_text != old.search_text BEGIN
      INSERT INTO agent_messages_fts(agent_messages_fts, rowid, search_text)
        VALUES('delete', old.rowid, old.search_text);
      INSERT INTO agent_messages_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
    END;
  `)
  return db
}

function insertThread(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO projects (id, name, path, source) VALUES ('project-1', 'P', 'project', 'local')`
  ).run()
  db.prepare(
    `INSERT INTO threads (id, project_id, provider_id, title, title_source, status, created_at, updated_at, last_activity, working_directory)
     VALUES (?, 'project-1', 'openai', 'T', 'auto', 'created', 100, 100, 500, 'project')`
  ).run(id)
}

function insertMessage(
  db: Database.Database,
  id: string,
  threadId: string,
  parts: unknown[],
  searchText: string
): void {
  db.prepare(
    `INSERT INTO agent_messages (id, thread_id, role, origin, visibility, parts, search_text, created_at)
     VALUES (?, ?, 'assistant', 'provider', 'conversation', ?, ?, 100)`
  ).run(id, threadId, JSON.stringify(parts), searchText)
}

function searchText(db: Database.Database, id: string): string {
  const row = db.prepare('SELECT search_text FROM agent_messages WHERE id = ?').get(id) as {
    search_text: string
  }
  return row.search_text
}

describe('version 15 search corpus repair', () => {
  it('drops reasoning and sub-agent text, and keeps what the conversation said', () => {
    const db = migratedDatabase()
    insertThread(db, 'thread-1')
    insertMessage(
      db,
      'msg-1',
      'thread-1',
      [
        { type: 'text', id: 'p1', messageID: 'msg-1', text: 'Wired the retry' },
        { type: 'reasoning', id: 'p2', messageID: 'msg-1', text: 'Internal plan', time: {} }
      ],
      'Wired the retry\nInternal plan'
    )
    insertMessage(
      db,
      'msg-2',
      'thread-1',
      [
        {
          type: 'subagent',
          id: 'p3',
          messageID: 'msg-2',
          activity: { id: 'a1', description: 'Sweep callers', output: 'Found three' }
        },
        { type: 'text', id: 'p4', messageID: 'msg-2', text: 'Three callers remain' }
      ],
      'Sweep callers\nFound three\nThree callers remain'
    )
    insertMessage(
      db,
      'msg-3',
      'thread-1',
      [{ type: 'text', id: 'p5', messageID: 'msg-3', text: 'Already clean' }],
      'Already clean'
    )

    versionFifteenMigration.apply(db)

    expect(searchText(db, 'msg-1')).toBe('Wired the retry')
    expect(searchText(db, 'msg-2')).toBe('Three callers remain')
    // A row that already matched the corpus is untouched.
    expect(searchText(db, 'msg-3')).toBe('Already clean')

    // The embedding index compares against this stamp, so a changed thread must
    // look stale; recency (`last_activity`) must not move.
    const thread = db
      .prepare('SELECT updated_at, last_activity FROM threads WHERE id = ?')
      .get('thread-1') as { updated_at: number; last_activity: number }
    expect(thread.updated_at).toBeGreaterThan(100)
    expect(thread.last_activity).toBe(500)
  })

  it('leaves a database with nothing to repair alone', () => {
    const db = migratedDatabase()
    insertThread(db, 'thread-1')
    insertMessage(
      db,
      'msg-1',
      'thread-1',
      [{ type: 'text', id: 'p1', messageID: 'msg-1', text: 'Only words' }],
      'Only words'
    )
    versionFifteenMigration.apply(db)
    const thread = db.prepare('SELECT updated_at FROM threads WHERE id = ?').get('thread-1') as {
      updated_at: number
    }
    expect(thread.updated_at).toBe(100)
  })
})
