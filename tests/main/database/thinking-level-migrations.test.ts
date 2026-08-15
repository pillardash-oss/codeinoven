import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Worker } from 'node:worker_threads'
import DatabaseConstructor from 'better-sqlite3'
import {
  DATABASE_SCHEMA_SQL,
  HARNESS_USAGE_MODELS_ADD_THINKING_LEVEL_MIGRATION_SQL,
  HARNESS_USAGE_MODELS_NORMALIZE_THINKING_LEVEL_MIGRATION_SQL,
  TURN_FEEDBACK_SET_NULL_MIGRATION_SQL
} from '../../../src/main/database/schema'
import { Database } from '../../../src/main/database/database'

function legacyHarnessUsageModelsSql(): string {
  return `
    CREATE TABLE threads (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE harness_usage_models (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      harness_id TEXT NOT NULL, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
      thinking_level TEXT,
      message_count INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
      tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0, tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0, tokens_total INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0, first_used_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, harness_id, provider_id, model_id, thinking_level)
    );
  `
}

function preThinkingLevelHarnessUsageModelsSql(): string {
  return `
    CREATE TABLE threads (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE harness_usage_models (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      harness_id TEXT NOT NULL, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
      tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0, tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0, tokens_total INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0, first_used_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, harness_id, provider_id, model_id)
    );
  `
}

describe('harness_usage_models thinking-level migration', () => {
  it('migrates a table created before thinking_level existed (missing column)', () => {
    const db = new DatabaseConstructor(':memory:')
    db.exec(preThinkingLevelHarnessUsageModelsSql())
    db.exec(`INSERT INTO threads(id) VALUES('t1')`)
    // The legacy table keyed per model without a level, so one accumulated row.
    db.exec(
      `INSERT INTO harness_usage_models VALUES('t1','opencode','openai','gpt-x',5,3.0,300,150,30,0,0,480,3000,100,200)`
    )

    // Regression: the earlier rebuild referenced thinking_level, which does not
    // exist here, and failed with "no such column: thinking_level".
    expect(() => db.exec(HARNESS_USAGE_MODELS_ADD_THINKING_LEVEL_MIGRATION_SQL)).not.toThrow()

    const cols = db.pragma('table_info(harness_usage_models)') as Array<{
      name: string
      notnull: number
      pk: number
    }>
    const level = cols.find((c) => c.name === 'thinking_level')
    expect(level?.notnull).toBe(1)

    // Legacy rows carry the '' unknown sentinel, keyed by the new 5-column PK.
    const rows = db.prepare('SELECT * FROM harness_usage_models').all() as Array<{
      thinking_level: string
      message_count: number
      tokens_total: number
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.thinking_level).toBe('')
    expect(rows[0]?.message_count).toBe(5)
    expect(rows[0]?.tokens_total).toBe(480)
  })

  it('recovers when a partially-failed run left harness_usage_models_v2 behind', () => {
    const db = new DatabaseConstructor(':memory:')
    db.exec(preThinkingLevelHarnessUsageModelsSql())
    db.exec(`INSERT INTO threads(id) VALUES('t1')`)
    db.exec(
      `INSERT INTO harness_usage_models VALUES('t1','opencode','openai','gpt-x',5,3.0,300,150,30,0,0,480,3000,100,200)`
    )
    // Simulate the earlier migration failing midway: the v2 CREATE succeeded,
    // the copy aborted on the missing column, and the temp table was left over.
    db.exec(`CREATE TABLE harness_usage_models_v2 (id TEXT)`)
    db.exec(`INSERT INTO harness_usage_models_v2(id) VALUES('leftover')`)

    // Regression: the retry must not abort with "table ... already exists".
    expect(() => db.exec(HARNESS_USAGE_MODELS_ADD_THINKING_LEVEL_MIGRATION_SQL)).not.toThrow()

    const rows = db.prepare('SELECT * FROM harness_usage_models').all() as Array<{
      thinking_level: string
      message_count: number
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.thinking_level).toBe('')
    expect(rows[0]?.message_count).toBe(5)
    // The leftover temp table was dropped, not left polluting the schema.
    const leftover = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'harness_usage_models_v2'"
      )
      .get()
    expect(leftover).toBeUndefined()
  })

  it('normalizes a nullable thinking_level to NOT NULL so unknown rows accumulate', () => {
    const db = new DatabaseConstructor(':memory:')
    db.exec(legacyHarnessUsageModelsSql())
    db.exec(`INSERT INTO threads(id) VALUES('t1')`)
    // The nullable-column bug: two rows with NULL level for the same model
    // (SQLite treats NULLs as distinct inside a composite PRIMARY KEY).
    db.exec(
      `INSERT INTO harness_usage_models VALUES('t1','opencode','openai','gpt-x',NULL,2,1.0,100,50,10,0,0,160,1000,100,200)`
    )
    db.exec(
      `INSERT INTO harness_usage_models VALUES('t1','opencode','openai','gpt-x',NULL,3,2.0,200,100,20,0,0,320,2000,150,250)`
    )

    db.exec(HARNESS_USAGE_MODELS_NORMALIZE_THINKING_LEVEL_MIGRATION_SQL)

    const cols = db.pragma('table_info(harness_usage_models)') as Array<{
      name: string
      notnull: number
      pk: number
    }>
    const level = cols.find((c) => c.name === 'thinking_level')
    expect(level?.notnull).toBe(1)
    const pk = cols
      .filter((c) => c.pk > 0)
      .map((c) => c.name)
      .join(',')
    expect(pk).toBe('thread_id,harness_id,provider_id,model_id,thinking_level')

    // The duplicate NULL rows were merged into a single '' row, not fragmented.
    const rows = db.prepare('SELECT * FROM harness_usage_models').all() as Array<{
      thinking_level: string
      message_count: number
      cost_usd: number
      tokens_total: number
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.thinking_level).toBe('')
    expect(rows[0]?.message_count).toBe(5)
    expect(rows[0]?.cost_usd).toBeCloseTo(3.0)
    expect(rows[0]?.tokens_total).toBe(480)

    // Unknown (''), low, and high levels now coexist as distinct rows.
    db.prepare(
      `INSERT INTO harness_usage_models VALUES('t1','opencode','openai','gpt-x','low',1,0.5,50,25,5,0,0,80,500,300,400)`
    ).run()
    db.prepare(
      `INSERT INTO harness_usage_models VALUES('t1','opencode','openai','gpt-x','high',1,0.5,50,25,5,0,0,80,500,300,400)`
    ).run()
    expect(
      (db.prepare('SELECT COUNT(*) c FROM harness_usage_models').get() as { c: number }).c
    ).toBe(3)
  })
})

describe('turn_feedback SET NULL migration', () => {
  function legacyTurnFeedbackSql(): string {
    return `
      CREATE TABLE threads (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE turn_feedback (
        id TEXT PRIMARY KEY NOT NULL,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        parent_turn_id TEXT NOT NULL UNIQUE,
        session_id TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        status TEXT NOT NULL CHECK(status IN ('pending','success','corrected')),
        signal TEXT CHECK(signal IN ('continued','switched','cleaned_up','corrective_feedback')),
        score REAL NOT NULL DEFAULT 0,
        feature TEXT CHECK(feature IN ('main','audit','assignment')),
        task_slug TEXT,
        harness_id TEXT, provider_id TEXT, model_id TEXT, thinking_level TEXT
      );
    `
  }

  it('switches the thread FK to SET NULL and preserves rows', () => {
    const db = new DatabaseConstructor(':memory:')
    db.exec(legacyTurnFeedbackSql())
    db.exec(`INSERT INTO threads(id) VALUES('t1')`)
    db.exec(
      `INSERT INTO turn_feedback(id, thread_id, parent_turn_id, created_at, status, score, feature, harness_id, provider_id, model_id, thinking_level)
       VALUES('o1','t1','turn-1',1000,'success',1,'main','opencode','openai','gpt-x','high')`
    )

    db.exec(TURN_FEEDBACK_SET_NULL_MIGRATION_SQL)

    const fks = db.pragma('foreign_key_list(turn_feedback)') as Array<{
      table: string
      on_delete: string
    }>
    expect(fks.some((fk) => fk.table === 'threads' && fk.on_delete === 'SET NULL')).toBe(true)

    const row = db.prepare('SELECT * FROM turn_feedback').get() as {
      thread_id: string
      parent_turn_id: string
      model_id: string
      score: number
    }
    expect(row.thread_id).toBe('t1')
    expect(row.parent_turn_id).toBe('turn-1')
    expect(row.model_id).toBe('gpt-x')
    expect(row.score).toBe(1)
  })

  it('recovers when a partially-failed run left turn_feedback_v2 behind', () => {
    const db = new DatabaseConstructor(':memory:')
    db.exec(legacyTurnFeedbackSql())
    db.exec(`INSERT INTO threads(id) VALUES('t1')`)
    db.exec(
      `INSERT INTO turn_feedback(id, thread_id, parent_turn_id, created_at, status, score, feature, harness_id, provider_id, model_id)
       VALUES('o1','t1','turn-1',1000,'success',1,'main','opencode','openai','gpt-x')`
    )
    db.exec(`CREATE TABLE turn_feedback_v2 (id TEXT)`)
    db.exec(`INSERT INTO turn_feedback_v2(id) VALUES('leftover')`)

    expect(() => db.exec(TURN_FEEDBACK_SET_NULL_MIGRATION_SQL)).not.toThrow()

    const row = db.prepare('SELECT * FROM turn_feedback').get() as { parent_turn_id: string }
    expect(row.parent_turn_id).toBe('turn-1')
    const leftover = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'turn_feedback_v2'")
      .get()
    expect(leftover).toBeUndefined()
  })

  it('keeps resolved cleanup outcomes after the thread row is deleted', () => {
    const db = new DatabaseConstructor(':memory:')
    db.exec(legacyTurnFeedbackSql())
    db.exec(`INSERT INTO threads(id) VALUES('t1')`)
    db.exec(
      `INSERT INTO turn_feedback(id, thread_id, parent_turn_id, created_at, resolved_at, status, signal, score, feature, harness_id, provider_id, model_id)
       VALUES('o1','t1','turn-1',1000,2000,'success','cleaned_up',1,'main','opencode','openai','gpt-x')`
    )

    db.exec(TURN_FEEDBACK_SET_NULL_MIGRATION_SQL)
    db.exec(`DELETE FROM threads WHERE id = 't1'`)

    const row = db.prepare('SELECT * FROM turn_feedback').get() as {
      thread_id: string | null
      status: string
      signal: string
      score: number
    }
    expect(row).toBeDefined()
    expect(row.thread_id).toBeNull()
    expect(row.status).toBe('success')
    expect(row.signal).toBe('cleaned_up')
    expect(row.score).toBe(1)
  })
})

describe('interrupted-rebuild recovery', () => {
  // A maintenance worker cannot share a file database with a second WAL
  // connection from a bare test, so the Database is given a scripted factory:
  // every request is answered as "unavailable" (making query helpers fall back
  // to the primary connection) and shutdown is acknowledged with a clean exit,
  // so init() and the awaited close() complete without timers or errors.
  const noopWorkerFactory = (): Worker => {
    let messageHandler: ((message: unknown) => void) | null = null
    let exitHandler: (() => void) | null = null
    const stub = {
      on: (event: string, handler: (message?: unknown) => void) => {
        if (event === 'message') messageHandler = handler as (message: unknown) => void
        if (event === 'exit') exitHandler = handler as () => void
        return stub
      },
      once: (event: string, handler: () => void) => {
        if (event === 'exit') exitHandler = handler
        return stub
      },
      removeListener: () => stub,
      removeAllListeners: () => stub,
      postMessage: (message: { type: string; id: number; request: { kind: string } }) => {
        if (message.type !== 'request') return
        messageHandler?.({
          type: 'response',
          id: message.id,
          result: { kind: message.request.kind, ok: false, error: 'unavailable' }
        })
        if (message.request.kind === 'shutdown') exitHandler?.()
      },
      terminate: () => Promise.resolve(0)
    }
    return stub as unknown as Worker
  }

  it('adopts the populated staging table when a crash left the canonical table missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cio-migration-recovery-'))
    const path = join(dir, 'app.db')
    try {
      // Build the full fresh database, then simulate the pre-transaction crash
      // window: the old table was dropped and the rename never ran, so the
      // populated *_v2 staging tables survived while the canonical tables are
      // gone (the next startup recreates them empty).
      const raw = new DatabaseConstructor(path)
      raw.exec(DATABASE_SCHEMA_SQL)
      raw.exec(
        `INSERT INTO projects(id, name, path, source, provider_id, workflow_id, thread_limit, change_tracking_mode, created_at, updated_at)
         VALUES('p', 'Project', '/p', 'local', 'openai', 'default', 70, 'manual', 1, 1)`
      )
      raw.exec(
        `INSERT INTO threads(id, project_id, provider_id, title, status, pinned, archived, read, scope_bucket_id, created_at, updated_at, last_activity)
         VALUES('t1', 'p', '', 'Thread', 'created', 0, 0, 1, 'default', 1, 1, 1)`
      )
      raw.exec(`CREATE TABLE harness_usage_models_v2 AS SELECT * FROM harness_usage_models`)
      raw.exec(
        `INSERT INTO harness_usage_models_v2(thread_id, harness_id, provider_id, model_id, thinking_level, message_count, cost_usd, tokens_in, tokens_out, tokens_reasoning, tokens_cache_read, tokens_cache_write, tokens_total, duration_ms, first_used_at, last_used_at)
         VALUES('t1','opencode','openai','gpt-x','high',5,3.0,300,150,30,0,0,480,3000,100,200)`
      )
      raw.exec(`DROP TABLE harness_usage_models`)

      raw.exec('CREATE TABLE turn_feedback_v2 AS SELECT * FROM turn_feedback')
      raw.exec(
        `INSERT INTO turn_feedback_v2(id, thread_id, parent_turn_id, created_at, status, score, feature, harness_id, provider_id, model_id)
         VALUES('o1','t1','turn-1',1000,'success',1,'main','opencode','openai','gpt-x')`
      )
      raw.exec(`DROP TABLE turn_feedback`)
      raw.close()

      // The fixed Database.init() must adopt both staging tables instead of
      // recreating empty canonicals and losing the data.
      const db = new Database(path, noopWorkerFactory)
      await db.init()
      try {
        const model = db.get(
          'SELECT thinking_level, message_count, tokens_total FROM harness_usage_models'
        ) as { thinking_level: string; message_count: number; tokens_total: number }
        expect(model).toEqual({ thinking_level: 'high', message_count: 5, tokens_total: 480 })

        const feedback = db.get('SELECT parent_turn_id, status, model_id FROM turn_feedback') as {
          parent_turn_id: string
          status: string
          model_id: string
        }
        expect(feedback).toEqual({
          parent_turn_id: 'turn-1',
          status: 'success',
          model_id: 'gpt-x'
        })

        // The staging tables were consumed, not left polluting the schema.
        expect(
          db.get(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'harness_usage_models_v2'"
          )
        ).toBeUndefined()
        expect(
          db.get(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'turn_feedback_v2'"
          )
        ).toBeUndefined()

        // The adopted tables were normalized back to the constrained canonical
        // schema (the seeded staging was a bare column copy): primary keys,
        // nullability, and foreign keys must be restored.
        const modelCols = db.raw().pragma('table_info(harness_usage_models)') as Array<{
          name: string
          notnull: number
          pk: number
        }>
        expect(modelCols.find((c) => c.name === 'thinking_level')?.notnull).toBe(1)
        expect(
          modelCols
            .filter((c) => c.pk > 0)
            .map((c) => c.name)
            .join(',')
        ).toBe('thread_id,harness_id,provider_id,model_id,thinking_level')

        const feedbackCols = db.raw().pragma('table_info(turn_feedback)') as Array<{
          name: string
          notnull: number
          pk: number
        }>
        expect(feedbackCols.find((c) => c.name === 'id')?.pk).toBe(1)
        expect(feedbackCols.find((c) => c.name === 'parent_turn_id')?.notnull).toBe(1)
        const feedbackFks = db.raw().pragma('foreign_key_list(turn_feedback)') as Array<{
          table: string
          on_delete: string
        }>
        expect(
          feedbackFks.some((fk) => fk.table === 'threads' && fk.on_delete === 'SET NULL')
        ).toBe(true)
      } finally {
        await db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
