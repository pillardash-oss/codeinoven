import { createHash } from 'crypto'
import type { Database } from '../database'
import type {
  AgentMessage,
  AgentMessageOrigin,
  AgentMessageVisibility,
  AgentPart,
  ThinkingLevel,
  ThreadMessageCursor,
  ThreadMessagePage,
  UserMessageSummary
} from '../../../lib/types'
import { attachmentGrantStatements, syncAttachmentGrants } from './attachment-grant-repo'

/** Plain-text content of a user-authored agent message (mirrors the renderer). */
function userMessageText(partsJson: string): string {
  const parts = JSON.parse(partsJson) as AgentPart[]
  return parts
    .filter((p): p is Extract<AgentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

/** Plain-text content of an agent message used for full-text search indexing. */
export function partsToSearchText(parts: AgentPart[]): string {
  const chunks: string[] = []
  for (const part of parts) {
    switch (part.type) {
      case 'text':
      case 'reasoning':
        if (part.text) chunks.push(part.text)
        break
      case 'question': {
        const answer = part.question.answer?.trim()
        chunks.push(`Question: ${part.question.prompt}${answer ? `\nAnswer: ${answer}` : ''}`)
        break
      }
      case 'user-presentation': {
        const { action, body } = part.presentation
        chunks.push(`${action}${body ? `\n${body}` : ''}`)
        break
      }
      case 'subagent': {
        const { activity } = part
        if (activity.description) chunks.push(activity.description)
        if (activity.prompt) chunks.push(activity.prompt)
        if (activity.output) chunks.push(activity.output)
        break
      }
      default:
        break
    }
  }
  return chunks.join('\n')
}

/** Persisted column values that participate in a message's content identity. */
export interface PersistedMessageRow {
  role: string
  origin: string
  visibility: string
  parts: string
  search_text: string
  transport_parts: string | null
  transport_origin: string | null
  model_id: string | null
  provider_id: string | null
  harness_id: string | null
  thinking_level: string | null
  references_json: string | null
  project_references_json: string | null
  created_at: number
  completed_at: number | null
  cost: number | null
  tokens_json: string | null
  rate_limits_json: string | null
  usage_credits_json: string | null
  context_window: number | null
  context_used: number | null
  error: string | null
  structured_output: string | null
}

/**
 * Stable content fingerprint of a persisted agent message row. The delta sync
 * compares this hash against the stored `content_hash` so unchanged messages —
 * identical JSON, search text, and metadata — are never re-stringified or
 * rewritten on a transcript sync.
 */
export function hashPersistedRow(row: PersistedMessageRow): string {
  const parts = [
    row.role,
    row.origin,
    row.visibility,
    row.parts,
    row.search_text,
    row.transport_parts ?? '',
    row.transport_origin ?? '',
    row.model_id ?? '',
    row.provider_id ?? '',
    row.harness_id ?? '',
    row.thinking_level ?? '',
    row.references_json ?? '',
    row.project_references_json ?? '',
    String(row.created_at),
    String(row.completed_at ?? ''),
    String(row.cost ?? ''),
    row.tokens_json ?? '',
    row.rate_limits_json ?? '',
    row.usage_credits_json ?? '',
    String(row.context_window ?? ''),
    String(row.context_used ?? ''),
    row.error ?? '',
    row.structured_output ?? ''
  ]
  return createHash('sha256').update(parts.join('\u0000')).digest('hex')
}

export interface AgentMessageRow {
  id: string
  thread_id: string
  session_id: string | null
  role: string
  origin: string
  visibility: string
  parts: string
  search_text: string
  content_hash: string | null
  transport_parts: string | null
  transport_origin: string | null
  model_id: string | null
  provider_id: string | null
  harness_id: string | null
  thinking_level: string | null
  references_json: string | null
  project_references_json: string | null
  created_at: number
  completed_at: number | null
  cost: number | null
  tokens_json: string | null
  rate_limits_json: string | null
  usage_credits_json: string | null
  context_window: number | null
  context_used: number | null
  error: string | null
  structured_output: string | null
}

/** Per-thread watermark of the last provider transcript sync. */
export interface ProviderSyncCursor {
  sessionId: string
  messageCount: number
  lastMessageId: string
  syncedAt: number
}

/** Explicit outcome of a delta-only transcript sync. */
export interface ProviderDeltaSyncResult {
  /** Messages appended or updated by this sync. */
  applied: number
  /** Messages already persisted with identical content (no write performed). */
  skipped: number
  /** Messages skipped because the id already belongs to another thread/session. */
  collisions: number
  /** Total mirrored conversation messages after this sync. */
  total: number
  /** Cursor advanced by this sync; null on a true noop (nothing was written). */
  cursor: ProviderSyncCursor | null
  /** True when nothing changed and zero database writes were performed. */
  noop: boolean
}

function rowToMessage(row: AgentMessageRow, includeTransport = false): AgentMessage {
  return {
    id: row.id,
    role: row.role as 'user' | 'assistant',
    origin: row.origin as AgentMessageOrigin,
    ...(row.visibility !== 'conversation'
      ? { visibility: row.visibility as AgentMessageVisibility }
      : {}),
    parts: JSON.parse(row.parts),
    ...(includeTransport && row.transport_parts
      ? { transportParts: JSON.parse(row.transport_parts) }
      : {}),
    ...(includeTransport && row.transport_origin
      ? { transportOrigin: row.transport_origin as AgentMessageOrigin }
      : {}),
    modelId: row.model_id ?? undefined,
    providerId: row.provider_id ?? undefined,
    harnessId: row.harness_id ?? undefined,
    thinkingLevel: row.thinking_level ? (row.thinking_level as ThinkingLevel) : undefined,
    references: row.references_json ? JSON.parse(row.references_json) : undefined,
    projectReferences: row.project_references_json
      ? JSON.parse(row.project_references_json)
      : undefined,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
    cost: row.cost ?? undefined,
    tokens: row.tokens_json ? JSON.parse(row.tokens_json) : undefined,
    rateLimits: row.rate_limits_json ? JSON.parse(row.rate_limits_json) : undefined,
    credits: row.usage_credits_json ? JSON.parse(row.usage_credits_json) : undefined,
    contextWindow: row.context_window ?? undefined,
    contextUsed: row.context_used ?? undefined,
    error: row.error ?? undefined,
    structuredOutput: row.structured_output ? JSON.parse(row.structured_output) : undefined
  }
}

/**
 * Minimal SQL executor surface shared by the main-thread repo and the database
 * maintenance worker so the delta-sync core has a single source of truth.
 * `Database` and the worker's connection adapter both satisfy it.
 */
export interface ProviderDeltaSyncExecutor {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[]
  run(sql: string, ...params: unknown[]): void
  transaction<T>(fn: () => T): T
}

/** Persisted column values of one encoded agent message. */
export interface EncodedAgentMessage {
  id: string
  threadId: string
  sessionId: string | null
  role: string
  origin: string
  visibility: string
  partsJson: string
  searchText: string
  contentHash: string
  transportPartsJson: string | null
  transportOrigin: string | null
  modelId: string | null
  providerId: string | null
  harnessId: string | null
  thinkingLevel: string | null
  referencesJson: string | null
  projectReferencesJson: string | null
  createdAt: number
  completedAt: number | null
  cost: number | null
  tokensJson: string | null
  tokensTotal: number | null
  rateLimitsJson: string | null
  creditsJson: string | null
  contextWindow: number | null
  contextUsed: number | null
  error: string | null
  structuredOutputJson: string | null
}

/**
 * Encode a message into its persisted column values plus the content hash.
 * Shared by the single-message upsert, the batched delta sync, and the
 * maintenance worker so every path hashes and serializes identically.
 */
export function encodeAgentMessage(
  message: AgentMessage,
  threadId: string,
  sessionId?: string
): EncodedAgentMessage {
  const targetSessionId = sessionId ?? null
  const origin = message.origin ?? (sessionId ? 'subagent' : 'provider')
  const visibility = message.visibility ?? (sessionId ? 'subagent_trace' : 'conversation')
  const partsJson = JSON.stringify(message.parts)
  const searchText = partsToSearchText(message.parts)
  const transportPartsJson = message.transportParts ? JSON.stringify(message.transportParts) : null
  const transportOrigin = message.transportOrigin ?? null
  const modelId = message.modelId ?? null
  const providerId = message.providerId ?? null
  const harnessId = message.harnessId ?? null
  const thinkingLevel = message.thinkingLevel ?? null
  const referencesJson = message.references ? JSON.stringify(message.references) : null
  const projectReferencesJson = message.projectReferences
    ? JSON.stringify(message.projectReferences)
    : null
  const createdAt = message.createdAt
  const completedAt = message.completedAt ?? null
  const cost = message.cost ?? null
  const tokensJson = message.tokens ? JSON.stringify(message.tokens) : null
  const tokensTotal = message.tokens?.total ?? null
  const rateLimitsJson = message.rateLimits ? JSON.stringify(message.rateLimits) : null
  const creditsJson = message.credits ? JSON.stringify(message.credits) : null
  const contextWindow = message.contextWindow ?? null
  const contextUsed = message.contextUsed ?? null
  const error = message.error ?? null
  const structuredOutputJson =
    message.structuredOutput !== undefined ? JSON.stringify(message.structuredOutput) : null
  const contentHash = hashPersistedRow({
    role: message.role,
    origin,
    visibility,
    parts: partsJson,
    search_text: searchText,
    transport_parts: transportPartsJson,
    transport_origin: transportOrigin,
    model_id: modelId,
    provider_id: providerId,
    harness_id: harnessId,
    thinking_level: thinkingLevel,
    references_json: referencesJson,
    project_references_json: projectReferencesJson,
    created_at: createdAt,
    completed_at: completedAt,
    cost,
    tokens_json: tokensJson,
    rate_limits_json: rateLimitsJson,
    usage_credits_json: creditsJson,
    context_window: contextWindow,
    context_used: contextUsed,
    error,
    structured_output: structuredOutputJson
  })
  return {
    id: message.id,
    threadId,
    sessionId: targetSessionId,
    role: message.role,
    origin,
    visibility,
    partsJson,
    searchText,
    contentHash,
    transportPartsJson,
    transportOrigin,
    modelId,
    providerId,
    harnessId,
    thinkingLevel,
    referencesJson,
    projectReferencesJson,
    createdAt,
    completedAt,
    cost,
    tokensJson,
    tokensTotal,
    rateLimitsJson,
    creditsJson,
    contextWindow,
    contextUsed,
    error,
    structuredOutputJson
  }
}

/** The INSERT ... ON CONFLICT statement for one encoded message. */
export function encodeWriteStatement(encoded: EncodedAgentMessage): {
  sql: string
  params: unknown[]
} {
  return {
    sql: `INSERT INTO agent_messages(
      id, thread_id, session_id, role, origin, visibility, parts, search_text, content_hash,
      transport_parts, transport_origin,
      model_id, provider_id, harness_id, thinking_level,
      references_json, project_references_json,
      created_at, completed_at, cost,
      tokens_json, tokens_total, rate_limits_json, usage_credits_json,
      context_window, context_used, error, structured_output
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      role = excluded.role,
      origin = excluded.origin,
      visibility = excluded.visibility,
      parts = excluded.parts,
      search_text = excluded.search_text,
      content_hash = excluded.content_hash,
      transport_parts = excluded.transport_parts,
      transport_origin = excluded.transport_origin,
      model_id = excluded.model_id,
      provider_id = excluded.provider_id,
      harness_id = excluded.harness_id,
      thinking_level = excluded.thinking_level,
      references_json = excluded.references_json,
      project_references_json = excluded.project_references_json,
      created_at = excluded.created_at,
      completed_at = excluded.completed_at,
      cost = excluded.cost,
      tokens_json = excluded.tokens_json,
      tokens_total = excluded.tokens_total,
      rate_limits_json = excluded.rate_limits_json,
      usage_credits_json = excluded.usage_credits_json,
      context_window = excluded.context_window,
      context_used = excluded.context_used,
      error = excluded.error,
      structured_output = excluded.structured_output`,
    params: [
      encoded.id,
      encoded.threadId,
      encoded.sessionId,
      encoded.role,
      encoded.origin,
      encoded.visibility,
      encoded.partsJson,
      encoded.searchText,
      encoded.contentHash,
      encoded.transportPartsJson,
      encoded.transportOrigin,
      encoded.modelId,
      encoded.providerId,
      encoded.harnessId,
      encoded.thinkingLevel,
      encoded.referencesJson,
      encoded.projectReferencesJson,
      encoded.createdAt,
      encoded.completedAt,
      encoded.cost,
      encoded.tokensJson,
      encoded.tokensTotal,
      encoded.rateLimitsJson,
      encoded.creditsJson,
      encoded.contextWindow,
      encoded.contextUsed,
      encoded.error,
      encoded.structuredOutputJson
    ]
  }
}

/** Persist one fully-encoded message (INSERT or UPDATE by id). */
export function writeEncodedMessage(
  executor: ProviderDeltaSyncExecutor,
  encoded: EncodedAgentMessage
): void {
  const statement = encodeWriteStatement(encoded)
  executor.run(statement.sql, ...statement.params)
  syncAttachmentGrants(executor, encoded)
}

/**
 * Atomic replace of a thread's conversation mirror: delete conversation rows
 * and any provider cursors, then upsert every message — as a statement batch
 * runnable on the worker's `transaction` command or on the primary connection.
 */
export function buildSaveMessagesStatements(
  threadId: string,
  messages: AgentMessage[]
): Array<{ sql: string; params: unknown[] }> {
  const statements: Array<{ sql: string; params: unknown[] }> = [
    {
      sql: 'DELETE FROM agent_messages WHERE thread_id = ? AND session_id IS NULL',
      params: [threadId]
    },
    { sql: 'DELETE FROM provider_sync_cursors WHERE thread_id = ?', params: [threadId] }
  ]
  for (const message of messages) {
    const encoded = encodeAgentMessage(message, threadId)
    statements.push(encodeWriteStatement(encoded), ...attachmentGrantStatements(encoded))
  }
  return statements
}

/**
 * Append-only, delta-only transcript synchronization.
 *
 * Same-length, same-final-id transcripts are still reconciled message by
 * message against the persisted `content_hash`, so in-place edits to any
 * message are detected and persisted. Only new or changed messages are written,
 * and every write is batched inside a single transaction. When nothing changed
 * (a true noop) the database is not written to at all — not even the cursor row.
 *
 * `sessionId` is the thread's current harness session and keys the cursor.
 */
export function runProviderDeltaSync(
  executor: ProviderDeltaSyncExecutor,
  threadId: string,
  sessionId: string,
  messages: AgentMessage[]
): ProviderDeltaSyncResult {
  const sorted = [...messages].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  )
  const last = sorted[sorted.length - 1]
  const lastId = last?.id ?? ''

  // Bulk-load existing identities so unchanged rows are never rewritten and a
  // foreign id (belonging to another thread/session) is never clobbered.
  const existing = new Map<
    string,
    { contentHash: string | null; threadId: string; sessionId: string | null }
  >(
    executor
      .all<{
        id: string
        content_hash: string | null
        thread_id: string
        session_id: string | null
      }>(
        'SELECT id, content_hash, thread_id, session_id FROM agent_messages WHERE thread_id = ?',
        threadId
      )
      .map(
        (row) =>
          [
            row.id,
            { contentHash: row.content_hash, threadId: row.thread_id, sessionId: row.session_id }
          ] as const
      )
  )

  let skipped = 0
  let collisions = 0
  const writes: EncodedAgentMessage[] = []
  for (const message of sorted) {
    const existingRow = existing.get(message.id)
    if (existingRow && (existingRow.threadId !== threadId || existingRow.sessionId !== null)) {
      collisions++
      continue
    }
    const encoded = encodeAgentMessage(message, threadId)
    if (existingRow?.contentHash !== null && existingRow?.contentHash === encoded.contentHash) {
      skipped++
      continue
    }
    writes.push(encoded)
  }

  // True noop: nothing changed, so write nothing — not even the cursor row.
  if (writes.length === 0 && collisions === 0) {
    return {
      applied: 0,
      skipped,
      collisions,
      total: existing.size,
      cursor: null,
      noop: true
    }
  }

  executor.transaction(() => {
    for (const encoded of writes) {
      writeEncodedMessage(executor, encoded)
    }
  })

  executor.run(
    `INSERT INTO provider_sync_cursors(thread_id, session_id, message_count, last_message_id, synced_at)
     VALUES(?,?,?,?,?)
     ON CONFLICT(thread_id, session_id) DO UPDATE SET
       message_count = excluded.message_count,
       last_message_id = excluded.last_message_id,
       synced_at = excluded.synced_at`,
    threadId,
    sessionId,
    sorted.length,
    lastId,
    Date.now()
  )

  return {
    applied: writes.length,
    skipped,
    collisions,
    total: sorted.length,
    cursor: { sessionId, messageCount: sorted.length, lastMessageId: lastId, syncedAt: Date.now() },
    noop: false
  }
}

export class AgentMessageRepo {
  constructor(private db: Database) {}

  upsert(message: AgentMessage, threadId: string, sessionId?: string): void {
    const existing = this.db.get<AgentMessageRow>(
      `SELECT id, thread_id, session_id, role, origin, visibility, parts, search_text,
        content_hash,
        transport_parts, transport_origin,
        model_id, provider_id, harness_id,
        references_json, project_references_json,
        created_at, completed_at, cost,
        tokens_json, rate_limits_json, usage_credits_json,
        context_window, context_used, error, structured_output
       FROM agent_messages WHERE id = ?`,
      message.id
    )
    const encoded = encodeAgentMessage(message, threadId, sessionId)
    if (
      existing &&
      (existing.thread_id !== encoded.threadId || existing.session_id !== encoded.sessionId)
    ) {
      throw new Error(`Message ${message.id} already belongs to another thread or session`)
    }

    // The content hash is a stable fingerprint of every persisted field, so a
    // matching hash means no rewrite is needed (unchanged JSON/search text are
    // never rewritten).
    if (existing && existing.content_hash === encoded.contentHash) {
      return
    }

    writeEncodedMessage(this.db, encoded)
  }

  // ── Provider cursors and delta-only transcript sync ────────────────────

  /** Per-thread watermark of the last provider transcript sync. */
  getProviderCursor(threadId: string, sessionId: string): ProviderSyncCursor | null {
    const row = this.db.get<{
      session_id: string
      message_count: number
      last_message_id: string
      synced_at: number
    }>(
      `SELECT session_id, message_count, last_message_id, synced_at
       FROM provider_sync_cursors WHERE thread_id = ? AND session_id = ?`,
      threadId,
      sessionId
    )
    if (!row) return null
    return {
      sessionId: row.session_id,
      messageCount: row.message_count,
      lastMessageId: row.last_message_id,
      syncedAt: row.synced_at
    }
  }

  saveProviderCursor(
    threadId: string,
    sessionId: string,
    messageCount: number,
    lastMessageId: string
  ): void {
    this.db.run(
      `INSERT INTO provider_sync_cursors(thread_id, session_id, message_count, last_message_id, synced_at)
       VALUES(?,?,?,?,?)
       ON CONFLICT(thread_id, session_id) DO UPDATE SET
         message_count = excluded.message_count,
         last_message_id = excluded.last_message_id,
         synced_at = excluded.synced_at`,
      threadId,
      sessionId,
      messageCount,
      lastMessageId,
      Date.now()
    )
  }

  /** Forget the transcript watermark after a replace/truncate of the mirror. */
  clearProviderCursor(threadId: string, sessionId: string): void {
    this.db.run(
      'DELETE FROM provider_sync_cursors WHERE thread_id = ? AND session_id = ?',
      threadId,
      sessionId
    )
  }

  /** Forget every transcript watermark for a thread. */
  clearProviderCursorsByThread(threadId: string): void {
    this.db.run('DELETE FROM provider_sync_cursors WHERE thread_id = ?', threadId)
  }

  /** Count of mirrored parent-session (conversation) messages for a thread. */
  countConversationByThread(threadId: string): number {
    const row = this.db.get<{ cnt: number }>(
      'SELECT count(*) as cnt FROM agent_messages WHERE thread_id = ? AND session_id IS NULL',
      threadId
    )
    return row?.cnt ?? 0
  }

  /**
   * Delta-only transcript synchronization (see `runProviderDeltaSync`). Runs on
   * the caller's executor; `ThreadManager` routes this through the maintenance
   * worker in production so the reconciliation never blocks the main process.
   */
  syncProviderDeltas(
    threadId: string,
    sessionId: string,
    messages: AgentMessage[]
  ): ProviderDeltaSyncResult {
    return runProviderDeltaSync(this.db, threadId, sessionId, messages)
  }

  loadByThread(threadId: string): AgentMessage[] {
    const rows = this.db.all<AgentMessageRow>(
      `SELECT * FROM agent_messages
       WHERE thread_id = ? AND session_id IS NULL
         AND visibility IN ('conversation', 'working_trace')
       ORDER BY created_at ASC`,
      threadId
    )
    return rows.map((row) => rowToMessage(row))
  }

  loadPageByThread(
    threadId: string,
    before: ThreadMessageCursor | undefined,
    limit: number
  ): ThreadMessagePage {
    const rows = before
      ? this.db.all<AgentMessageRow>(
          `SELECT * FROM agent_messages
           WHERE thread_id = ? AND session_id IS NULL
             AND visibility IN ('conversation', 'working_trace')
             AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
          threadId,
          before.createdAt,
          before.createdAt,
          before.id,
          limit + 1
        )
      : this.db.all<AgentMessageRow>(
          `SELECT * FROM agent_messages
           WHERE thread_id = ? AND session_id IS NULL
             AND visibility IN ('conversation', 'working_trace')
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
          threadId,
          limit + 1
        )
    const hasOlder = rows.length > limit
    const pageRows = hasOlder ? rows.slice(0, limit) : rows
    return {
      messages: pageRows.reverse().map((row) => rowToMessage(row)),
      hasOlder
    }
  }

  /**
   * Load a contiguous window of conversation history centered on an arbitrary
   * message id — half older and half newer around the anchor. Used to jump to a
   * message far outside the currently loaded window.
   */
  loadPageAroundByThread(threadId: string, anchorId: string, limit: number): ThreadMessagePage {
    const anchor = this.db.get<{ created_at: number }>(
      'SELECT created_at FROM agent_messages WHERE thread_id = ? AND id = ?',
      threadId,
      anchorId
    )
    if (!anchor) return { messages: [], hasOlder: false, hasNewer: false }

    const half = Math.max(1, Math.floor(limit / 2))
    const olderRows = this.db.all<AgentMessageRow>(
      `SELECT * FROM agent_messages
       WHERE thread_id = ? AND session_id IS NULL
         AND visibility IN ('conversation', 'working_trace')
         AND (created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      threadId,
      anchor.created_at,
      anchor.created_at,
      anchorId,
      half + 1
    )
    const newerRows = this.db.all<AgentMessageRow>(
      `SELECT * FROM agent_messages
       WHERE thread_id = ? AND session_id IS NULL
         AND visibility IN ('conversation', 'working_trace')
         AND (created_at > ? OR (created_at = ? AND id > ?))
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
      threadId,
      anchor.created_at,
      anchor.created_at,
      anchorId,
      half + 1
    )
    const hasOlder = olderRows.length > half
    const hasNewer = newerRows.length > half
    const anchorRow = this.db.get<AgentMessageRow>(
      'SELECT * FROM agent_messages WHERE thread_id = ? AND id = ?',
      threadId,
      anchorId
    )
    const rows = [
      ...olderRows.slice(0, half).reverse(),
      ...(anchorRow ? [anchorRow] : []),
      ...newerRows.slice(0, half)
    ]
    return {
      messages: rows.map((row) => rowToMessage(row)),
      hasOlder,
      hasNewer
    }
  }

  /** Every user-authored conversation message, oldest to newest. */
  loadUserMessagesByThread(threadId: string): UserMessageSummary[] {
    const rows = this.db.all<{ id: string; parts: string; created_at: number }>(
      `SELECT id, parts, created_at FROM agent_messages
       WHERE thread_id = ? AND session_id IS NULL AND role = 'user'
         AND visibility IN ('conversation', 'working_trace')
       ORDER BY created_at ASC, id ASC`,
      threadId
    )
    return rows.map((row) => ({
      id: row.id,
      content: userMessageText(row.parts),
      createdAt: row.created_at
    }))
  }

  loadAllByThread(threadId: string): AgentMessage[] {
    const rows = this.db.all<AgentMessageRow>(
      `SELECT * FROM agent_messages
       WHERE thread_id = ? AND session_id IS NULL
       ORDER BY created_at ASC`,
      threadId
    )
    return rows.map((row) => rowToMessage(row, true))
  }

  deleteConversationByThread(threadId: string): void {
    this.db.run('DELETE FROM agent_messages WHERE thread_id = ? AND session_id IS NULL', threadId)
  }

  loadBySession(threadId: string, sessionId: string): AgentMessage[] {
    const rows = this.db.all<AgentMessageRow>(
      'SELECT * FROM agent_messages WHERE thread_id = ? AND session_id = ? ORDER BY created_at ASC',
      threadId,
      sessionId
    )
    return rows.map((row) => rowToMessage(row))
  }

  deleteByThread(threadId: string): void {
    this.db.run('DELETE FROM agent_messages WHERE thread_id = ?', threadId)
  }

  deleteBySession(threadId: string, sessionId: string): void {
    this.db.run(
      'DELETE FROM agent_messages WHERE thread_id = ? AND session_id = ?',
      threadId,
      sessionId
    )
  }

  countByThread(threadId: string): number {
    const row = this.db.get<{ cnt: number }>(
      'SELECT count(*) as cnt FROM agent_messages WHERE thread_id = ?',
      threadId
    )
    return row?.cnt ?? 0
  }
}

// ── Shared SQL builders and row mapping (main + worker) ───────────────────

/** Map raw `agent_messages` rows to display-facing messages. */
export function mapMessageRows(rows: unknown[], includeTransport = false): AgentMessage[] {
  return rows.map((row) => rowToMessage(row as AgentMessageRow, includeTransport))
}

/** Map raw `id/parts/created_at` rows to lightweight user-message summaries. */
export function mapUserMessageRows(rows: unknown[]): UserMessageSummary[] {
  return rows.map((row) => {
    const r = row as { id: string; parts: string; created_at: number }
    return { id: r.id, content: userMessageText(r.parts), createdAt: r.created_at }
  })
}

/** ASC cursor condition: strictly after (created_at, id) — for paged loops. */
function afterCursor(after: ThreadMessageCursor | undefined): string {
  return after ? ` AND (created_at > ? OR (created_at = ? AND id > ?))` : ''
}

/**
 * SQL for one bounded page of the mirrored conversation (parent-session rows),
 * ascending, cursor-paged. The worker's `query` command applies the LIMIT.
 */
export function buildLoadByThreadPageSql(
  threadId: string,
  after: ThreadMessageCursor | undefined
): { sql: string; params: unknown[] } {
  const params: unknown[] = [threadId]
  const cursor = afterCursor(after)
  if (after) params.push(after.createdAt, after.createdAt, after.id)
  return {
    sql: `SELECT * FROM agent_messages
      WHERE thread_id = ? AND session_id IS NULL
        AND visibility IN ('conversation', 'working_trace')${cursor}
      ORDER BY created_at ASC, id ASC`,
    params
  }
}

/** SQL for one bounded page of parent-session records (incl. transport prompts). */
export function buildLoadAllPageSql(
  threadId: string,
  after: ThreadMessageCursor | undefined
): { sql: string; params: unknown[] } {
  const params: unknown[] = [threadId]
  const cursor = afterCursor(after)
  if (after) params.push(after.createdAt, after.createdAt, after.id)
  return {
    sql: `SELECT * FROM agent_messages WHERE thread_id = ? AND session_id IS NULL${cursor}
      ORDER BY created_at ASC, id ASC`,
    params
  }
}

/** SQL for one bounded page of user-authored conversation messages. */
export function buildLoadUserMessagesPageSql(
  threadId: string,
  after: ThreadMessageCursor | undefined
): { sql: string; params: unknown[] } {
  const params: unknown[] = [threadId]
  const cursor = afterCursor(after)
  if (after) params.push(after.createdAt, after.createdAt, after.id)
  return {
    sql: `SELECT id, parts, created_at FROM agent_messages
      WHERE thread_id = ? AND session_id IS NULL AND role = 'user'
        AND visibility IN ('conversation', 'working_trace')${cursor}
      ORDER BY created_at ASC, id ASC`,
    params
  }
}

/** SQL for one bounded page of a child-agent (subagent) transcript. */
export function buildLoadSessionPageSql(
  threadId: string,
  sessionId: string,
  after: ThreadMessageCursor | undefined
): { sql: string; params: unknown[] } {
  const params: unknown[] = [threadId, sessionId]
  const cursor = afterCursor(after)
  if (after) params.push(after.createdAt, after.createdAt, after.id)
  return {
    sql: `SELECT * FROM agent_messages WHERE thread_id = ? AND session_id = ?${cursor}
      ORDER BY created_at ASC, id ASC`,
    params
  }
}

/** Atomic replace of a child-agent transcript: delete session + upsert all. */
export function buildSaveSubagentStatements(
  threadId: string,
  sessionId: string,
  messages: AgentMessage[]
): Array<{ sql: string; params: unknown[] }> {
  const statements: Array<{ sql: string; params: unknown[] }> = [
    {
      sql: 'DELETE FROM agent_messages WHERE thread_id = ? AND session_id = ?',
      params: [threadId, sessionId]
    }
  ]
  for (const message of messages) {
    statements.push(encodeWriteStatement(encodeAgentMessage(message, threadId, sessionId)))
  }
  return statements
}

/** SQL for one bounded page (newest first, cursor-based), no LIMIT. */
export function buildLoadPageSql(
  threadId: string,
  before: ThreadMessageCursor | undefined
): { sql: string; params: unknown[] } {
  const params: unknown[] = [threadId]
  const cursor = before ? ` AND (created_at < ? OR (created_at = ? AND id < ?))` : ''
  if (before) {
    params.push(before.createdAt, before.createdAt, before.id)
  }
  return {
    sql: `SELECT * FROM agent_messages
      WHERE thread_id = ? AND session_id IS NULL
        AND visibility IN ('conversation', 'working_trace')${cursor}
      ORDER BY created_at DESC, id DESC`,
    params
  }
}
