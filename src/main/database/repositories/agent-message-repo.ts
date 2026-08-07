import type { Database } from '../database'
import type {
  AgentMessage,
  AgentMessageOrigin,
  AgentMessageVisibility,
  AgentPart,
  ThreadMessageCursor,
  ThreadMessagePage
} from '../../../lib/types'

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

interface AgentMessageRow {
  id: string
  thread_id: string
  session_id: string | null
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
  references_json: string | null
  project_references_json: string | null
  created_at: number
  completed_at: number | null
  cost: number | null
  tokens_json: string | null
  rate_limits_json: string | null
  usage_credits_json: string | null
  error: string | null
  structured_output: string | null
}

function rowToMessage(row: AgentMessageRow, includeTransport = false): AgentMessage {
  return {
    id: row.id,
    role: row.role as 'user' | 'assistant',
    ...(row.origin !== 'legacy' ? { origin: row.origin as AgentMessageOrigin } : {}),
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
    error: row.error ?? undefined,
    structuredOutput: row.structured_output ? JSON.parse(row.structured_output) : undefined
  }
}

export class AgentMessageRepo {
  constructor(private db: Database) {}

  upsert(message: AgentMessage, threadId: string, sessionId?: string): void {
    const existing = this.db.get<AgentMessageRow>(
      `SELECT id, thread_id, session_id, role, origin, visibility, parts, search_text,
        transport_parts, transport_origin,
        model_id, provider_id, harness_id,
        references_json, project_references_json,
        created_at, completed_at, cost,
        tokens_json, rate_limits_json, usage_credits_json, error, structured_output
       FROM agent_messages WHERE id = ?`,
      message.id
    )
    const targetSessionId = sessionId ?? null
    const origin = message.origin ?? (sessionId ? 'subagent' : 'legacy')
    const visibility = message.visibility ?? (sessionId ? 'subagent_trace' : 'conversation')
    if (existing && (existing.thread_id !== threadId || existing.session_id !== targetSessionId)) {
      throw new Error(`Message ${message.id} already belongs to another thread or session`)
    }

    const partsJson = JSON.stringify(message.parts)
    const searchText = partsToSearchText(message.parts)
    const transportPartsJson = message.transportParts
      ? JSON.stringify(message.transportParts)
      : null
    const referencesJson = message.references ? JSON.stringify(message.references) : null
    const projectReferencesJson = message.projectReferences
      ? JSON.stringify(message.projectReferences)
      : null
    const tokensJson = message.tokens ? JSON.stringify(message.tokens) : null
    const rateLimitsJson = message.rateLimits ? JSON.stringify(message.rateLimits) : null
    const creditsJson = message.credits ? JSON.stringify(message.credits) : null
    const structuredOutputJson =
      message.structuredOutput !== undefined ? JSON.stringify(message.structuredOutput) : null

    if (
      existing &&
      existing.role === message.role &&
      existing.origin === origin &&
      existing.visibility === visibility &&
      existing.parts === partsJson &&
      existing.search_text === searchText &&
      (existing.transport_parts ?? null) === transportPartsJson &&
      (existing.transport_origin ?? null) === (message.transportOrigin ?? null) &&
      (existing.model_id ?? null) === (message.modelId ?? null) &&
      (existing.provider_id ?? null) === (message.providerId ?? null) &&
      (existing.harness_id ?? null) === (message.harnessId ?? null) &&
      (existing.references_json ?? null) === referencesJson &&
      (existing.project_references_json ?? null) === projectReferencesJson &&
      existing.created_at === message.createdAt &&
      (existing.completed_at ?? null) === (message.completedAt ?? null) &&
      (existing.cost ?? null) === (message.cost ?? null) &&
      (existing.tokens_json ?? null) === tokensJson &&
      (existing.rate_limits_json ?? null) === rateLimitsJson &&
      (existing.usage_credits_json ?? null) === creditsJson &&
      (existing.error ?? null) === (message.error ?? null) &&
      (existing.structured_output ?? null) === structuredOutputJson
    ) {
      return
    }

    this.db.run(
      `INSERT INTO agent_messages(
        id, thread_id, session_id, role, origin, visibility, parts, search_text,
        transport_parts, transport_origin,
        model_id, provider_id, harness_id,
        references_json, project_references_json,
        created_at, completed_at, cost,
        tokens_json, rate_limits_json, usage_credits_json, error, structured_output
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        role = excluded.role,
        origin = excluded.origin,
        visibility = excluded.visibility,
        parts = excluded.parts,
        search_text = excluded.search_text,
        transport_parts = excluded.transport_parts,
        transport_origin = excluded.transport_origin,
        model_id = excluded.model_id,
        provider_id = excluded.provider_id,
        harness_id = excluded.harness_id,
        references_json = excluded.references_json,
        project_references_json = excluded.project_references_json,
        created_at = excluded.created_at,
        completed_at = excluded.completed_at,
        cost = excluded.cost,
        tokens_json = excluded.tokens_json,
        rate_limits_json = excluded.rate_limits_json,
        usage_credits_json = excluded.usage_credits_json,
        error = excluded.error,
        structured_output = excluded.structured_output`,
      message.id,
      threadId,
      targetSessionId,
      message.role,
      origin,
      visibility,
      partsJson,
      searchText,
      transportPartsJson,
      message.transportOrigin ?? null,
      message.modelId ?? null,
      message.providerId ?? null,
      message.harnessId ?? null,
      referencesJson,
      projectReferencesJson,
      message.createdAt,
      message.completedAt ?? null,
      message.cost ?? null,
      tokensJson,
      rateLimitsJson,
      creditsJson,
      message.error ?? null,
      structuredOutputJson
    )
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
