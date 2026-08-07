import type { Database } from '../database'
import type { HarnessUsage } from '../../../lib/types'

interface HarnessUsageRow {
  project_id: string
  thread_id: string
  harness_id: string
  provider_id: string
  model_id: string | null
  message_count: number
  cost_usd: number
  tokens_in: number
  tokens_out: number
  tokens_reasoning: number
  tokens_cache_read: number
  tokens_cache_write: number
  tokens_total: number
  duration_ms: number
  first_used_at: number
  last_used_at: number
}

function rowToHarnessUsage(row: HarnessUsageRow): HarnessUsage {
  return {
    projectId: row.project_id,
    threadId: row.thread_id,
    harnessId: row.harness_id,
    providerId: row.provider_id,
    ...(row.model_id ? { modelId: row.model_id } : {}),
    messageCount: row.message_count,
    costUsd: row.cost_usd,
    tokens: {
      input: row.tokens_in,
      output: row.tokens_out,
      reasoning: row.tokens_reasoning,
      cacheRead: row.tokens_cache_read,
      cacheWrite: row.tokens_cache_write,
      total: row.tokens_total
    },
    durationMs: row.duration_ms,
    firstUsedAt: row.first_used_at,
    lastUsedAt: row.last_used_at
  }
}

/** Parse a stored tokens_json blob into a token breakdown, or null when malformed. */
function parseTokens(raw: string | null): {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
} | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    return {
      input: typeof record.input === 'number' ? record.input : 0,
      output: typeof record.output === 'number' ? record.output : 0,
      reasoning: typeof record.reasoning === 'number' ? record.reasoning : 0,
      cacheRead: typeof record.cacheRead === 'number' ? record.cacheRead : 0,
      cacheWrite: typeof record.cacheWrite === 'number' ? record.cacheWrite : 0,
      total: typeof record.total === 'number' ? record.total : 0
    }
  } catch {
    return null
  }
}

export class HarnessUsageRepo {
  constructor(private db: Database) {}

  /** Distinct harness ids used across a thread's session, newest activity first. */
  harnessIdsFor(threadId: string): string[] {
    const rows = this.db.all<{ harness_id: string }>(
      `SELECT harness_id FROM harness_usage
       WHERE thread_id = ?
       ORDER BY last_used_at DESC`,
      threadId
    )
    return rows.map((row) => row.harness_id)
  }

  /** All cumulative usage rows for one thread, newest activity first. */
  listByThread(projectId: string, threadId: string): HarnessUsage[] {
    const rows = this.db.all<HarnessUsageRow>(
      `SELECT * FROM harness_usage
       WHERE project_id = ? AND thread_id = ?
       ORDER BY last_used_at DESC`,
      projectId,
      threadId
    )
    return rows.map(rowToHarnessUsage)
  }

  /** Every cumulative usage row across all threads (for analytics/aggregation). */
  listAll(): HarnessUsage[] {
    const rows = this.db.all<HarnessUsageRow>(
      'SELECT * FROM harness_usage ORDER BY last_used_at DESC'
    )
    return rows.map(rowToHarnessUsage)
  }

  /**
   * Rebuild a thread's usage rows from its persisted agent_messages. Idempotent:
   * the thread's rows are replaced wholesale, so repeated reconciles never double
   * count regardless of how many times messages are saved or upserted. Reading
   * from the DB (not the just-written batch) keeps incremental upserts correct.
   */
  reconcile(projectId: string, threadId: string): void {
    this.db.transaction(() => {
      this.db.run(
        'DELETE FROM harness_usage WHERE project_id = ? AND thread_id = ?',
        projectId,
        threadId
      )
      const messageRows = this.db.all<{
        id: string
        role: string
        model_id: string | null
        provider_id: string | null
        harness_id: string | null
        cost: number | null
        tokens_json: string | null
        created_at: number
        completed_at: number | null
      }>(
        `SELECT id, role, model_id, provider_id, harness_id, cost, tokens_json, created_at, completed_at
         FROM agent_messages WHERE thread_id = ? AND role = 'assistant'`,
        threadId
      )
      const byHarness = new Map<
        string,
        Required<Omit<HarnessUsage, 'projectId' | 'threadId' | 'modelId'>> & { modelId?: string }
      >()
      for (const row of messageRows) {
        if (row.role !== 'assistant') continue
        const harnessId = row.harness_id
        if (!harnessId) continue
        const providerId = row.provider_id ?? ''
        const key = `${harnessId}\u0000${providerId}`
        let entry = byHarness.get(key)
        const cost = row.cost ?? 0
        const tokens = parseTokens(row.tokens_json)
        const createdAt = row.created_at
        const completedAt = row.completed_at ?? createdAt
        const duration = completedAt > createdAt ? completedAt - createdAt : 0
        if (!entry) {
          entry = {
            harnessId,
            providerId,
            messageCount: 1,
            costUsd: cost,
            tokens: {
              input: tokens?.input ?? 0,
              output: tokens?.output ?? 0,
              reasoning: tokens?.reasoning ?? 0,
              cacheRead: tokens?.cacheRead ?? 0,
              cacheWrite: tokens?.cacheWrite ?? 0,
              total: tokens?.total ?? 0
            },
            durationMs: duration,
            firstUsedAt: createdAt,
            lastUsedAt: completedAt
          }
          if (row.model_id) entry.modelId = row.model_id
          byHarness.set(key, entry)
          continue
        }
        entry.messageCount += 1
        entry.costUsd += cost
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
      }
      for (const entry of byHarness.values()) {
        this.db.run(
          `INSERT INTO harness_usage(
            project_id, thread_id, harness_id, provider_id, model_id,
            message_count, cost_usd,
            tokens_in, tokens_out, tokens_reasoning, tokens_cache_read, tokens_cache_write, tokens_total,
            duration_ms, first_used_at, last_used_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          projectId,
          threadId,
          entry.harnessId,
          entry.providerId,
          entry.modelId ?? null,
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
    })
  }

  deleteByThread(threadId: string): void {
    this.db.run('DELETE FROM harness_usage WHERE thread_id = ?', threadId)
  }

  deleteByProject(projectId: string): void {
    this.db.run('DELETE FROM harness_usage WHERE project_id = ?', projectId)
  }

  /**
   * Reconcile every thread that has persisted assistant messages with a harness.
   * Used for the one-time startup backfill so the analytics table is populated
   * for threads created before this feature shipped.
   */
  reconcileAll(): void {
    const rows = this.db.all<{ project_id: string; thread_id: string }>(
      `SELECT DISTINCT t.project_id, am.thread_id
       FROM agent_messages am
       JOIN threads t ON t.id = am.thread_id
       WHERE am.role = 'assistant' AND am.harness_id IS NOT NULL AND am.harness_id != ''`
    )
    for (const row of rows) {
      this.reconcile(row.project_id, row.thread_id)
    }
  }
}
