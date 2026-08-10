import type { Database } from '../database'
import type {
  AgentMessage,
  AgentTokenUsage,
  HarnessModelUsage,
  HarnessUsage
} from '../../../lib/types'

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

interface HarnessModelUsageRow {
  thread_id: string
  harness_id: string
  provider_id: string
  model_id: string
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

function tokensFromRow(
  row: Pick<
    HarnessUsageRow | HarnessModelUsageRow,
    | 'tokens_in'
    | 'tokens_out'
    | 'tokens_reasoning'
    | 'tokens_cache_read'
    | 'tokens_cache_write'
    | 'tokens_total'
  >
): AgentTokenUsage {
  return {
    input: row.tokens_in,
    output: row.tokens_out,
    reasoning: row.tokens_reasoning,
    cacheRead: row.tokens_cache_read,
    cacheWrite: row.tokens_cache_write,
    total: row.tokens_total
  }
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
    tokens: tokensFromRow(row),
    durationMs: row.duration_ms,
    firstUsedAt: row.first_used_at,
    lastUsedAt: row.last_used_at
  }
}

function rowToHarnessModelUsage(row: HarnessModelUsageRow): HarnessModelUsage {
  return {
    threadId: row.thread_id,
    harnessId: row.harness_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    messageCount: row.message_count,
    costUsd: row.cost_usd,
    tokens: tokensFromRow(row),
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

/** Sum of step-finish cost parts on an assistant message, mirroring the renderer. */
function messageCost(message: AgentMessage): number {
  let stepCost = 0
  for (const part of message.parts) {
    if (part.type === 'step-finish' && typeof part.cost === 'number') stepCost += part.cost
  }
  return message.cost ?? stepCost
}

export class HarnessUsageRepo {
  constructor(private db: Database) {}

  /** Distinct harness ids used across a thread's session, newest activity first. */
  harnessIdsFor(threadId: string): string[] {
    const rows = this.db.all<{ harness_id: string }>(
      `SELECT harness_id FROM harness_usage
       WHERE thread_id = ?
       GROUP BY harness_id
       ORDER BY MAX(last_used_at) DESC`,
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
    const usages = rows.map(rowToHarnessUsage)
    const models = this.modelsFor(threadId)
    if (models.length > 0) {
      const byKey = new Map<string, HarnessModelUsage[]>()
      for (const model of models) {
        const key = `${model.harnessId}:${model.providerId}`
        const list = byKey.get(key)
        if (list) list.push(model)
        else byKey.set(key, [model])
      }
      for (const usage of usages) {
        const key = `${usage.harnessId}:${usage.providerId}`
        const modelList = byKey.get(key)
        if (modelList) usage.models = modelList
      }
    }
    return usages
  }

  /** Per-model cumulative usage rows for one thread, cost descending. */
  modelsFor(threadId: string): HarnessModelUsage[] {
    const rows = this.db.all<HarnessModelUsageRow>(
      `SELECT * FROM harness_usage_models
       WHERE thread_id = ?
       ORDER BY cost_usd DESC, last_used_at DESC`,
      threadId
    )
    return rows.map(rowToHarnessModelUsage)
  }

  /** Every cumulative usage row across all threads (for analytics/aggregation). */
  listAll(): HarnessUsage[] {
    const rows = this.db.all<HarnessUsageRow>(
      'SELECT * FROM harness_usage ORDER BY last_used_at DESC'
    )
    return rows.map(rowToHarnessUsage)
  }

  private markCounted(threadId: string, messageId: string): void {
    this.db.run(
      'INSERT OR IGNORE INTO harness_usage_messages(thread_id, message_id) VALUES(?, ?)',
      threadId,
      messageId
    )
  }

  /**
   * Accumulate one completed turn into the snapshot table. Called at the end of
   * each agent turn (success or failure). Each assistant message is counted once
   * (guarded by the harness_usage_messages ledger), so cost/tokens/duration are
   * added to whatever the thread's harness row already holds — never double
   * counted across retries, compaction, or restart.
   *
   * The ledger is read once up front and every write is batched into a single
   * worker transaction (primary-connection fallback), so the accumulation never
   * blocks the Electron main thread and issues O(messages) statements in one
   * atomic batch instead of a per-message read + writes.
   */
  async accumulateTurn(
    projectId: string,
    threadId: string,
    messages: AgentMessage[]
  ): Promise<{ ok: boolean; error?: string }> {
    const counted = new Set(
      this.db
        .all<{ message_id: string }>(
          'SELECT message_id FROM harness_usage_messages WHERE thread_id = ?',
          threadId
        )
        .map((row) => row.message_id)
    )

    const statements: Array<{ sql: string; params: unknown[] }> = []
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      const harnessId = message.harnessId
      if (!harnessId) continue
      if (counted.has(message.id)) continue

      const providerId = message.providerId ?? ''
      const modelId = message.modelId
      const cost = messageCost(message)
      const tokens = message.tokens
      const createdAt = message.createdAt
      const completedAt = message.completedAt ?? createdAt
      const duration = completedAt > createdAt ? completedAt - createdAt : 0

      statements.push({
        sql: `INSERT INTO harness_usage(
          project_id, thread_id, harness_id, provider_id, model_id,
          message_count, cost_usd,
          tokens_in, tokens_out, tokens_reasoning, tokens_cache_read, tokens_cache_write, tokens_total,
          duration_ms, first_used_at, last_used_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(project_id, thread_id, harness_id, provider_id) DO UPDATE SET
          model_id = COALESCE(excluded.model_id, harness_usage.model_id),
          message_count = harness_usage.message_count + excluded.message_count,
          cost_usd = harness_usage.cost_usd + excluded.cost_usd,
          tokens_in = harness_usage.tokens_in + excluded.tokens_in,
          tokens_out = harness_usage.tokens_out + excluded.tokens_out,
          tokens_reasoning = harness_usage.tokens_reasoning + excluded.tokens_reasoning,
          tokens_cache_read = harness_usage.tokens_cache_read + excluded.tokens_cache_read,
          tokens_cache_write = harness_usage.tokens_cache_write + excluded.tokens_cache_write,
          tokens_total = harness_usage.tokens_total + excluded.tokens_total,
          duration_ms = harness_usage.duration_ms + excluded.duration_ms,
          first_used_at = MIN(harness_usage.first_used_at, excluded.first_used_at),
          last_used_at = MAX(harness_usage.last_used_at, excluded.last_used_at)`,
        params: [
          projectId,
          threadId,
          harnessId,
          providerId,
          modelId ?? null,
          1,
          cost,
          tokens?.input ?? 0,
          tokens?.output ?? 0,
          tokens?.reasoning ?? 0,
          tokens?.cacheRead ?? 0,
          tokens?.cacheWrite ?? 0,
          tokens?.total ?? 0,
          duration,
          createdAt,
          completedAt
        ]
      })
      if (modelId) {
        statements.push({
          sql: `INSERT INTO harness_usage_models(
            thread_id, harness_id, provider_id, model_id,
            message_count, cost_usd,
            tokens_in, tokens_out, tokens_reasoning, tokens_cache_read, tokens_cache_write, tokens_total,
            duration_ms, first_used_at, last_used_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(thread_id, harness_id, provider_id, model_id) DO UPDATE SET
            message_count = harness_usage_models.message_count + excluded.message_count,
            cost_usd = harness_usage_models.cost_usd + excluded.cost_usd,
            tokens_in = harness_usage_models.tokens_in + excluded.tokens_in,
            tokens_out = harness_usage_models.tokens_out + excluded.tokens_out,
            tokens_reasoning = harness_usage_models.tokens_reasoning + excluded.tokens_reasoning,
            tokens_cache_read = harness_usage_models.tokens_cache_read + excluded.tokens_cache_read,
            tokens_cache_write = harness_usage_models.tokens_cache_write + excluded.tokens_cache_write,
            tokens_total = harness_usage_models.tokens_total + excluded.tokens_total,
            duration_ms = harness_usage_models.duration_ms + excluded.duration_ms,
            first_used_at = MIN(harness_usage_models.first_used_at, excluded.first_used_at),
            last_used_at = MAX(harness_usage_models.last_used_at, excluded.last_used_at)`,
          params: [
            threadId,
            harnessId,
            providerId,
            modelId,
            1,
            cost,
            tokens?.input ?? 0,
            tokens?.output ?? 0,
            tokens?.reasoning ?? 0,
            tokens?.cacheRead ?? 0,
            tokens?.cacheWrite ?? 0,
            tokens?.total ?? 0,
            duration,
            createdAt,
            completedAt
          ]
        })
      }
      statements.push({
        sql: 'INSERT OR IGNORE INTO harness_usage_messages(thread_id, message_id) VALUES(?, ?)',
        params: [threadId, message.id]
      })
    }

    if (statements.length === 0) return { ok: true }
    return this.db.transactionViaWorker(statements)
  }

  /**
   * Rebuild a thread's usage rows from its persisted agent_messages and reset
   * its ledger. Used only by the one-time startup backfill for threads that
   * predate incremental accumulation.
   */
  reconcile(projectId: string, threadId: string): void {
    this.db.transaction(() => {
      this.db.run(
        'DELETE FROM harness_usage WHERE project_id = ? AND thread_id = ?',
        projectId,
        threadId
      )
      this.db.run('DELETE FROM harness_usage_messages WHERE thread_id = ?', threadId)
      this.db.run('DELETE FROM harness_usage_models WHERE thread_id = ?', threadId)
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
        Required<Omit<HarnessUsage, 'projectId' | 'threadId' | 'modelId' | 'models'>> & {
          modelId?: string
        }
      >()
      const byModel = new Map<string, HarnessModelUsage>()
      for (const row of messageRows) {
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
        } else {
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

        const modelId = row.model_id
        if (modelId) {
          const modelKey = `${harnessId}\u0000${providerId}\u0000${modelId}`
          const modelEntry = byModel.get(modelKey)
          if (modelEntry) {
            modelEntry.messageCount += 1
            modelEntry.costUsd += cost
            if (tokens) {
              modelEntry.tokens.input += tokens.input ?? 0
              modelEntry.tokens.output += tokens.output ?? 0
              modelEntry.tokens.reasoning += tokens.reasoning ?? 0
              modelEntry.tokens.cacheRead += tokens.cacheRead ?? 0
              modelEntry.tokens.cacheWrite += tokens.cacheWrite ?? 0
              modelEntry.tokens.total += tokens.total ?? 0
            }
            modelEntry.durationMs += duration
            if (createdAt < modelEntry.firstUsedAt) modelEntry.firstUsedAt = createdAt
            if (completedAt > modelEntry.lastUsedAt) modelEntry.lastUsedAt = completedAt
          } else {
            byModel.set(modelKey, {
              threadId,
              harnessId,
              providerId,
              modelId,
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
            })
          }
        }
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
      for (const model of byModel.values()) {
        this.db.run(
          `INSERT INTO harness_usage_models(
            thread_id, harness_id, provider_id, model_id,
            message_count, cost_usd,
            tokens_in, tokens_out, tokens_reasoning, tokens_cache_read, tokens_cache_write, tokens_total,
            duration_ms, first_used_at, last_used_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          model.threadId,
          model.harnessId,
          model.providerId,
          model.modelId,
          model.messageCount,
          model.costUsd,
          model.tokens.input,
          model.tokens.output,
          model.tokens.reasoning,
          model.tokens.cacheRead,
          model.tokens.cacheWrite,
          model.tokens.total,
          model.durationMs,
          model.firstUsedAt,
          model.lastUsedAt
        )
      }
      for (const row of messageRows) {
        if (row.harness_id) this.markCounted(threadId, row.id)
      }
    })
  }

  deleteByThread(threadId: string): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM harness_usage WHERE thread_id = ?', threadId)
      this.db.run('DELETE FROM harness_usage_messages WHERE thread_id = ?', threadId)
      this.db.run('DELETE FROM harness_usage_models WHERE thread_id = ?', threadId)
    })
  }

  deleteByProject(projectId: string): void {
    this.db.run('DELETE FROM harness_usage WHERE project_id = ?', projectId)
  }

  /**
   * Reconcile every thread that has persisted assistant messages with a harness.
   * Used for the one-time startup backfill so the analytics table is populated
   * for threads created before this feature shipped.
   *
   * Runs once, gated behind a `db_meta` flag — mirroring the `content_hash` and
   * `search_text` backfills — so the O(total-assistant-messages) rebuild never
   * repeats on every launch.
   */
  reconcileAll(): void {
    const backfilled =
      this.db.get<{ value: string }>(
        "SELECT value FROM db_meta WHERE key = 'harness_usage_backfilled'"
      )?.value === '1'
    if (backfilled) return

    const rows = this.db.all<{ project_id: string; thread_id: string }>(
      `SELECT DISTINCT t.project_id, am.thread_id
       FROM agent_messages am
       JOIN threads t ON t.id = am.thread_id
       WHERE am.role = 'assistant' AND am.harness_id IS NOT NULL AND am.harness_id != ''`
    )
    for (const row of rows) {
      this.reconcile(row.project_id, row.thread_id)
    }

    this.db.run(
      "INSERT OR REPLACE INTO db_meta(key, value) VALUES('harness_usage_backfilled', '1')"
    )
  }
}
