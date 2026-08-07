#!/usr/bin/env node
/**
 * One-time backfill migration for harness usage analytics.
 *
 * Rebuilds the `harness_usage` snapshot table (and its idempotency ledger,
 * `harness_usage_messages`) from every thread's stored agent messages. This is
 * how pre-existing threads — created before incremental accumulation shipped —
 * get an accurate entry per (thread, harness, provider) with cumulative cost,
 * token usage, duration, and first/last used timestamps.
 *
 * Idempotent: run it as many times as you like. It replaces each thread's rows
 * wholesale and repopulates the ledger, so future per-turn accumulation never
 * double counts.
 *
 * Usage:
 *   node scripts/migrate-harness-usage.mjs
 *   node scripts/migrate-harness-usage.mjs --db /custom/path/codeinoven.db
 *   node scripts/migrate-harness-usage.mjs --dry-run
 */
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ORG_SLUG = 'pillardash'
const APP_SLUG = 'codeinoven'

function configRoot() {
  return join(homedir(), '.config', ORG_SLUG, APP_SLUG)
}

function parseArgs(argv) {
  const opts = { db: null, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--db') {
      opts.db = argv[++i]
    } else if (arg === '--dry-run') {
      opts.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true
    }
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
if (opts.help) {
  console.log(
    [
      'Usage: node scripts/migrate-harness-usage.mjs [options]',
      '',
      'Rebuilds harness_usage + harness_usage_messages from agent messages.',
      '',
      'Options:',
      '  --db <path>    SQLite database path (default: ~/.config/pillardash/codeinoven/codeinoven.db)',
      '  --dry-run      Report what would change without writing anything',
      '  --help, -h     Show this help',
      ''
    ].join('\n')
  )
  process.exit(0)
}

const dbPath = opts.db ?? join(configRoot(), 'codeinoven.db')
if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`)
  console.error('Pass the path with --db <path>.')
  process.exit(1)
}

const db = new Database(dbPath)
db.pragma('busy_timeout = 5000')

/** Parse a stored tokens_json blob, or null when malformed. */
function parseTokens(raw) {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    return {
      input: typeof value.input === 'number' ? value.input : 0,
      output: typeof value.output === 'number' ? value.output : 0,
      reasoning: typeof value.reasoning === 'number' ? value.reasoning : 0,
      cacheRead: typeof value.cacheRead === 'number' ? value.cacheRead : 0,
      cacheWrite: typeof value.cacheWrite === 'number' ? value.cacheWrite : 0,
      total: typeof value.total === 'number' ? value.total : 0
    }
  } catch {
    return null
  }
}

function tableExists(name) {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?"
      )
      .get(name) !== undefined
  )
}

/** Create the harness_usage and ledger tables if they don't already exist. */
function ensureSchema() {
  if (!tableExists('harness_usage')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS harness_usage (
        project_id           TEXT NOT NULL,
        thread_id            TEXT NOT NULL,
        harness_id           TEXT NOT NULL,
        provider_id          TEXT NOT NULL,
        model_id             TEXT,
        message_count        INTEGER NOT NULL DEFAULT 0,
        cost_usd             REAL NOT NULL DEFAULT 0,
        tokens_in            INTEGER NOT NULL DEFAULT 0,
        tokens_out           INTEGER NOT NULL DEFAULT 0,
        tokens_reasoning     INTEGER NOT NULL DEFAULT 0,
        tokens_cache_read    INTEGER NOT NULL DEFAULT 0,
        tokens_cache_write   INTEGER NOT NULL DEFAULT 0,
        tokens_total         INTEGER NOT NULL DEFAULT 0,
        duration_ms          INTEGER NOT NULL DEFAULT 0,
        first_used_at        INTEGER NOT NULL,
        last_used_at         INTEGER NOT NULL,
        PRIMARY KEY (project_id, thread_id, harness_id, provider_id)
      );
      CREATE INDEX IF NOT EXISTS idx_harness_usage_thread
        ON harness_usage(project_id, thread_id);
      CREATE INDEX IF NOT EXISTS idx_harness_usage_harness
        ON harness_usage(harness_id);
    `)
  }
  if (!tableExists('harness_usage_messages')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS harness_usage_messages (
        thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        PRIMARY KEY (thread_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_harness_usage_messages_thread
        ON harness_usage_messages(thread_id);
    `)
  }
}

/**
 * Rebuild one thread's usage rows and its ledger. Returns a per-harness tally
 * for reporting.
 */
function rebuildThread(projectId, threadId) {
  const messageRows = db
    .prepare(
      `SELECT id, model_id, provider_id, harness_id, cost, tokens_json, created_at, completed_at
       FROM agent_messages
       WHERE thread_id = ? AND role = 'assistant' AND harness_id IS NOT NULL AND harness_id != ''`
    )
    .all(threadId)

  const byHarness = new Map()
  const countedIds = []
  for (const row of messageRows) {
    const key = `${row.harness_id}\u0000${row.provider_id ?? ''}`
    const createdAt = row.created_at
    const completedAt = row.completed_at ?? createdAt
    const duration = completedAt > createdAt ? completedAt - createdAt : 0
    const tokens = parseTokens(row.tokens_json)
    let entry = byHarness.get(key)
    if (!entry) {
      entry = {
        harnessId: row.harness_id,
        providerId: row.provider_id ?? '',
        modelId: row.model_id ?? null,
        messageCount: 0,
        costUsd: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        durationMs: 0,
        firstUsedAt: createdAt,
        lastUsedAt: completedAt
      }
      byHarness.set(key, entry)
    }
    entry.messageCount += 1
    entry.costUsd += row.cost ?? 0
    if (tokens) {
      entry.tokens.input += tokens.input ?? 0
      entry.tokens.output += tokens.output ?? 0
      entry.tokens.reasoning += tokens.reasoning ?? 0
      entry.tokens.cacheRead += tokens.cacheRead ?? 0
      entry.tokens.cacheWrite += tokens.cacheWrite ?? 0
      entry.tokens.total += tokens.total ?? 0
    }
    entry.durationMs += duration
    if (createdAt < entry.firstUsedAt) entry.firstUsedAt = createdAt
    if (completedAt > entry.lastUsedAt) entry.lastUsedAt = completedAt
    if (row.model_id) entry.modelId = row.model_id
    countedIds.push(row.id)
  }

  return { projectId, threadId, entries: [...byHarness.values()], countedIds }
}

function writeThread(projectId, threadId, entries, countedIds) {
  db.transaction(() => {
    db.prepare(
      'DELETE FROM harness_usage WHERE project_id = ? AND thread_id = ?'
    ).run(projectId, threadId)
    db.prepare('DELETE FROM harness_usage_messages WHERE thread_id = ?').run(threadId)

    const insertUsage = db.prepare(
      `INSERT INTO harness_usage(
        project_id, thread_id, harness_id, provider_id, model_id,
        message_count, cost_usd,
        tokens_in, tokens_out, tokens_reasoning, tokens_cache_read, tokens_cache_write, tokens_total,
        duration_ms, first_used_at, last_used_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    const insertLedger = db.prepare(
      'INSERT OR IGNORE INTO harness_usage_messages(thread_id, message_id) VALUES(?, ?)'
    )
    for (const entry of entries) {
      insertUsage.run(
        projectId,
        threadId,
        entry.harnessId,
        entry.providerId,
        entry.modelId,
        entry.messageCount,
        entry.costUsd,
        entry.tokens.input,
        entry.tokens.output,
        entry.tokens.reasoning,
        entry.tokens.cacheRead,
        entry.tokens.cacheWrite,
        entry.tokens.total,
        entry.durationMs,
        entry.firstUsedAt,
        entry.lastUsedAt
      )
    }
    for (const messageId of countedIds) {
      insertLedger.run(threadId, messageId)
    }
  })()
}

function main() {
  ensureSchema()

  const threads = db
    .prepare(
      `SELECT DISTINCT t.project_id, am.thread_id
       FROM agent_messages am
       JOIN threads t ON t.id = am.thread_id
       WHERE am.role = 'assistant' AND am.harness_id IS NOT NULL AND am.harness_id != ''`
    )
    .all()

  const before = db.prepare('SELECT COUNT(*) c FROM harness_usage').get().c
  const beforeLedger = db.prepare('SELECT COUNT(*) c FROM harness_usage_messages').get().c

  console.log(`Backfilling ${threads.length} threads...`)
  console.log(`Before: ${before} harness_usage rows, ${beforeLedger} ledger rows.`)

  let usageRows = 0
  let counted = 0
  const harnessCounts = new Map()
  for (const thread of threads) {
    const { projectId, threadId, entries, countedIds } = rebuildThread(
      thread.project_id,
      thread.thread_id
    )
    for (const entry of entries) {
      harnessCounts.set(entry.harnessId, (harnessCounts.get(entry.harnessId) ?? 0) + 1)
      usageRows += 1
    }
    counted += countedIds.length
    if (!opts.dryRun) {
      writeThread(projectId, threadId, entries, countedIds)
    }
  }

  const after = opts.dryRun
    ? null
    : db.prepare('SELECT COUNT(*) c FROM harness_usage').get().c
  const afterLedger = opts.dryRun
    ? null
    : db.prepare('SELECT COUNT(*) c FROM harness_usage_messages').get().c

  console.log(
    `\nWould write ${usageRows} harness_usage rows across ${threads.length} threads, ` +
      `marking ${counted} messages in the ledger.`
  )
  console.log('Per-harness thread counts:')
  for (const [harnessId, count] of [...harnessCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${harnessId}: ${count}`)
  }

  if (!opts.dryRun) {
    console.log(`\nAfter: ${after} harness_usage rows (was ${before}), ` +
      `${afterLedger} ledger rows (was ${beforeLedger}).`)
    console.log('Migration complete.')
  } else {
    console.log('\nDry run — no changes written. Re-run without --dry-run to apply.')
  }

  db.close()
}

main()
