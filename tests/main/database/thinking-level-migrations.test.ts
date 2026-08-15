import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  HARNESS_USAGE_MODELS_ADD_THINKING_LEVEL_MIGRATION_SQL,
  HARNESS_USAGE_MODELS_NORMALIZE_THINKING_LEVEL_MIGRATION_SQL,
  TURN_FEEDBACK_SET_NULL_MIGRATION_SQL
} from '../../../src/main/database/schema'

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
    const db = new Database(':memory:')
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
    const db = new Database(':memory:')
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
    const db = new Database(':memory:')
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
    const db = new Database(':memory:')
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
    const db = new Database(':memory:')
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
    const db = new Database(':memory:')
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
