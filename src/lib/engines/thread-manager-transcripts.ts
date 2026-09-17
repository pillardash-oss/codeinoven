import type { Database } from '../../main/database/database'
import {
  AgentMessageRepo,
  type ProviderDeltaSyncResult,
  buildLoadAllPageSql,
  buildLoadByThreadPageSql,
  buildLoadPageSql,
  buildLoadSessionPageSql,
  buildLoadUserMessagesPageSql,
  buildSaveMessagesStatements,
  buildSaveSubagentStatements,
  buildLoadThreadSubagentUsageSql,
  decodeUsageBearingRow
} from '../../main/database/repositories/agent-message-repo'
import type {
  AgentMessage,
  ThreadMessageCursor,
  ThreadMessagePage,
  UsageBearingMessage,
  UserMessageSummary
} from '../types'

/**
 * Owns every mirrored-transcript read and write for a thread: the rich
 * conversation, bounded history pages, the user-message jump list, and
 * child-agent transcripts. All heavy reads are cursor-paged through the
 * database worker so no single query is unbounded.
 */
export class ThreadTranscriptStore {
  /** Bounded page size for worker transcript reads. */
  private static readonly TRANSCRIPT_PAGE_SIZE = 1000
  /** Safety cap on the number of cursor pages read through the worker. */
  private static readonly MAX_TRANSCRIPT_PAGES = 100_000
  /** Row cap for the narrow sub-agent usage read (analytics, not display). */
  private static readonly SUBAGENT_USAGE_MAX_ROWS = 20_000

  /**
   * Per-thread cache of the full user-message jump list (keyed by
   * `${projectId}:${threadId}`), populated on first async worker-backed load
   * and busted only when a new user message is applied to that thread or the
   * thread is deleted   repeated menu-opens never re-scan the database.
   */
  private readonly userMessageHistoryCache = new Map<string, UserMessageSummary[]>()

  constructor(
    private readonly db: Database,
    private readonly agentMessageRepo: AgentMessageRepo
  ) {}

  private userMessageHistoryCacheKey(projectId: string, threadId: string): string {
    return `${projectId}:${threadId}`
  }

  /** Drop the cached jump list for one thread (new user message or deletion). */
  forgetUserMessages(projectId: string, threadId: string): void {
    this.userMessageHistoryCache.delete(this.userMessageHistoryCacheKey(projectId, threadId))
  }

  /**
   * Persist the mirrored agent conversation (rich messages) for offline access.
   * Runs as one atomic transaction on the worker's connection when available
   * (falls back to the primary connection).
   */
  async saveMessages(threadId: string, messages: AgentMessage[]): Promise<void> {
    // Batch the statements so one huge transcript never materializes a single
    // multi-megabyte transaction payload in memory. Every batch is its own
    // transaction; the delete+upsert sequence below preserves the same
    // end state because the delete always precedes the first upsert batch.
    const BATCH = 16
    for (let offset = 0; offset < Math.max(1, messages.length); offset += BATCH) {
      const statements = buildSaveMessagesStatements(
        threadId,
        messages.slice(offset, offset + BATCH)
      )
      const batch = offset === 0 ? statements : statements.slice(2)
      if (offset > 0) await new Promise<void>((resolve) => setImmediate(resolve))
      const outcome = await this.db.transactionViaWorker(batch)
      if (!outcome.ok) {
        // Fallback: identical batching semantics on the primary connection.
        this.db.transaction(() => {
          for (const statement of batch) {
            this.db.run(statement.sql, ...statement.params)
          }
        })
      }
    }
  }

  /**
   * Add or update mirrored messages without replacing the transcript.
   *
   * Provider retries can finish out of order. Their snapshots must not delete
   * user messages persisted by a newer turn while the older request was in
   * flight.
   *
   * The provider transcript is synchronized incrementally: only new or changed
   * messages are written inside one transaction, keyed by a persisted provider
   * cursor for the thread's current harness session. In production this runs on
   * the database maintenance worker so the reconciliation never blocks the
   * main process; the primary connection is the fallback. Returns the delta
   * outcome.
   */
  async upsertMessages(
    projectId: string,
    threadId: string,
    sessionId: string,
    messages: AgentMessage[]
  ): Promise<ProviderDeltaSyncResult> {
    const result = await this.db.syncProviderDeltasViaWorker(threadId, sessionId, messages)
    if (result.applied > 0 && messages.some((message) => message.role === 'user')) {
      this.forgetUserMessages(projectId, threadId)
    }
    return result
  }

  /** Load the mirrored agent conversation, or an empty list when absent. */
  async loadMessages(threadId: string): Promise<AgentMessage[]> {
    const page = await this.pagedAgentMessages((after) => buildLoadByThreadPageSql(threadId, after))
    if (!page.ok) return this.agentMessageRepo.loadByThread(threadId)
    return page.messages
  }

  /** Load one bounded page of mirrored conversation history, newest page first. */
  async loadMessagePage(
    threadId: string,
    before: ThreadMessageCursor | undefined,
    limit: number
  ): Promise<ThreadMessagePage> {
    const built = buildLoadPageSql(threadId, before)
    const result = await this.db.queryMessagesViaWorker(built.sql, built.params, limit + 1)
    if (result.ok) {
      const hasOlder = result.messages.length > limit
      const pageMessages = hasOlder ? result.messages.slice(0, limit) : result.messages
      return { messages: pageMessages.reverse(), hasOlder }
    }
    return this.agentMessageRepo.loadPageByThread(threadId, before, limit)
  }

  /** Load a contiguous mirrored window centered on an arbitrary message id. */
  async loadMessagePageAround(
    threadId: string,
    anchorId: string,
    limit: number
  ): Promise<ThreadMessagePage> {
    return this.loadPageAroundViaWorker(threadId, anchorId, limit)
  }

  /** Load every mirrored user-authored conversation message, oldest to newest. */
  async loadUserMessages(projectId: string, threadId: string): Promise<UserMessageSummary[]> {
    const cacheKey = this.userMessageHistoryCacheKey(projectId, threadId)
    const cached = this.userMessageHistoryCache.get(cacheKey)
    if (cached) return cached
    const page = await this.pagedUserMessages((after) =>
      buildLoadUserMessagesPageSql(threadId, after)
    )
    if (!page.ok) return this.agentMessageRepo.loadUserMessagesByThread(threadId)
    this.userMessageHistoryCache.set(cacheKey, page.messages)
    return page.messages
  }

  /** Load every parent-session record, including hidden transport-only prompts. */
  async loadMessageRecords(threadId: string): Promise<AgentMessage[]> {
    const page = await this.pagedAgentMessages(
      (after) => buildLoadAllPageSql(threadId, after),
      true
    )
    if (!page.ok) return this.agentMessageRepo.loadAllByThread(threadId)
    return page.messages
  }

  /**
   * Persist one provider-neutral child-agent transcript for durable audit.
   * Runs as one atomic worker transaction when available.
   */
  async saveSubagentMessages(
    threadId: string,
    sessionId: string,
    messages: AgentMessage[]
  ): Promise<void> {
    const outcome = await this.db.transactionViaWorker(
      buildSaveSubagentStatements(threadId, sessionId, messages)
    )
    if (!outcome.ok) {
      this.db.transaction(() => {
        for (const statement of buildSaveSubagentStatements(threadId, sessionId, messages)) {
          this.db.run(statement.sql, ...statement.params)
        }
      })
    }
  }

  /** Load a mirrored child-agent transcript without contacting the provider. */
  async loadSubagentMessages(threadId: string, sessionId: string): Promise<AgentMessage[]> {
    const page = await this.pagedAgentMessages((after) =>
      buildLoadSessionPageSql(threadId, sessionId, after)
    )
    if (!page.ok) return this.agentMessageRepo.loadBySession(threadId, sessionId)
    return page.messages
  }

  /**
   * Every sub-agent turn of a thread that reported usage, read as a narrow
   * projection through the database worker. Used by usage accounting, which
   * needs a handful of columns per turn and never the message parts.
   */
  async listSubagentUsageMessages(threadId: string): Promise<UsageBearingMessage[]> {
    const built = buildLoadThreadSubagentUsageSql(threadId)
    const result = await this.db.queryViaWorker(
      built.sql,
      built.params,
      ThreadTranscriptStore.SUBAGENT_USAGE_MAX_ROWS
    )
    if (!result.ok) return []
    return result.rows.map((row) => decodeUsageBearingRow(row))
  }

  /**
   * Read the full mirrored conversation by cursor-paging through the worker
   * in bounded chunks, so no single worker query is unbounded (no
   * `maxRows = 0`). Decoding (`parts` JSON parse + oversized-output cap) runs
   * on the worker thread via `queryMessagesViaWorker`, so a legacy row's
   * multi-megabyte tool output is never parsed on the main process. Returns
   * `ok: false` when the worker path is unavailable so the caller can fall back.
   */
  private async pagedAgentMessages(
    buildPage: (after: ThreadMessageCursor | undefined) => { sql: string; params: unknown[] },
    includeTransport = false
  ): Promise<{ ok: true; messages: AgentMessage[] } | { ok: false }> {
    const messages: AgentMessage[] = []
    let after: ThreadMessageCursor | undefined
    for (let page = 0; page < ThreadTranscriptStore.MAX_TRANSCRIPT_PAGES; page++) {
      const built = buildPage(after)
      const result = await this.db.queryMessagesViaWorker(
        built.sql,
        built.params,
        ThreadTranscriptStore.TRANSCRIPT_PAGE_SIZE,
        includeTransport
      )
      if (!result.ok) return { ok: false }
      messages.push(...result.messages)
      if (!result.truncated || result.messages.length === 0) break
      if (result.messages.length < ThreadTranscriptStore.TRANSCRIPT_PAGE_SIZE) break
      const last = result.messages[result.messages.length - 1]
      after = { createdAt: last.createdAt, id: last.id }
    }
    return { ok: true, messages }
  }

  /** Same paging strategy as `pagedAgentMessages`, decoded to lightweight user-message summaries. */
  private async pagedUserMessages(
    buildPage: (after: ThreadMessageCursor | undefined) => { sql: string; params: unknown[] }
  ): Promise<{ ok: true; messages: UserMessageSummary[] } | { ok: false }> {
    const messages: UserMessageSummary[] = []
    let after: ThreadMessageCursor | undefined
    for (let page = 0; page < ThreadTranscriptStore.MAX_TRANSCRIPT_PAGES; page++) {
      const built = buildPage(after)
      const result = await this.db.queryUserMessagesViaWorker(
        built.sql,
        built.params,
        ThreadTranscriptStore.TRANSCRIPT_PAGE_SIZE
      )
      if (!result.ok) return { ok: false }
      messages.push(...result.messages)
      if (!result.truncated || result.messages.length === 0) break
      if (result.messages.length < ThreadTranscriptStore.TRANSCRIPT_PAGE_SIZE) break
      const last = result.messages[result.messages.length - 1]
      after = { createdAt: last.createdAt, id: last.id }
    }
    return { ok: true, messages }
  }

  /** Centered window around a message id, read through bounded worker queries. */
  private async loadPageAroundViaWorker(
    threadId: string,
    anchorId: string,
    limit: number
  ): Promise<ThreadMessagePage> {
    const anchor = await this.db.queryViaWorker(
      'SELECT created_at FROM agent_messages WHERE thread_id = ? AND id = ?',
      [threadId, anchorId],
      1
    )
    if (!anchor.ok || anchor.rows.length === 0) {
      return this.agentMessageRepo.loadPageAroundByThread(threadId, anchorId, limit)
    }
    const anchorCreatedAt = Number(anchor.rows[0].created_at)
    const half = Math.max(1, Math.floor(limit / 2))
    const cursor = (older: boolean): string =>
      older
        ? ` AND (created_at < ? OR (created_at = ? AND id < ?))`
        : ` AND (created_at > ? OR (created_at = ? AND id > ?))`
    const order = (older: boolean): string => (older ? 'DESC, id DESC' : 'ASC, id ASC')
    const older = await this.db.queryMessagesViaWorker(
      `SELECT * FROM agent_messages
       WHERE thread_id = ? AND session_id IS NULL
         AND visibility IN ('conversation','working_trace')${cursor(true)}
       ORDER BY created_at ${order(true)}`,
      [threadId, anchorCreatedAt, anchorCreatedAt, anchorId],
      half + 1
    )
    if (!older.ok) return this.agentMessageRepo.loadPageAroundByThread(threadId, anchorId, limit)
    const newer = await this.db.queryMessagesViaWorker(
      `SELECT * FROM agent_messages
       WHERE thread_id = ? AND session_id IS NULL
         AND visibility IN ('conversation','working_trace')${cursor(false)}
       ORDER BY created_at ${order(false)}`,
      [threadId, anchorCreatedAt, anchorCreatedAt, anchorId],
      half + 1
    )
    if (!newer.ok) return this.agentMessageRepo.loadPageAroundByThread(threadId, anchorId, limit)
    const anchorRow = await this.db.queryMessagesViaWorker(
      'SELECT * FROM agent_messages WHERE thread_id = ? AND id = ?',
      [threadId, anchorId],
      1
    )
    if (!anchorRow.ok)
      return this.agentMessageRepo.loadPageAroundByThread(threadId, anchorId, limit)
    const olderMessages = older.messages
    const newerMessages = newer.messages
    const hasOlder = olderMessages.length > half
    const hasNewer = newerMessages.length > half
    const messages = [
      ...olderMessages.slice(0, half).reverse(),
      ...anchorRow.messages.slice(0, 1),
      ...newerMessages.slice(0, half)
    ]
    return { messages, hasOlder, hasNewer }
  }
}
