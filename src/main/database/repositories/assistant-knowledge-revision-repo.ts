import type {
  AssistantKnowledgeRevision,
  AssistantKnowledgeRevisionCause,
  AssistantKnowledgeRevisionDetail
} from '../../../lib/types'
import type { Database } from '../database'

/**
 * The durable side of an assistant's instruction history.
 *
 * Knowledge is not patched, it is replaced: every save writes a whole new
 * document over the previous one, and until now the only copy of the old
 * document was the agent's own context. A save that lost the page therefore lost
 * it for good. This table keeps each version as one row, so the panel can show
 * what was saved and when, and a restore writes an earlier version back as a new
 * one instead of rewriting history.
 *
 * Two rules shape the reads. A timeline row carries no body: `characters`,
 * `lines` and `excerpt` are written once with the text, so listing versions reads
 * a small row each and the document travels only when the user opens it. And the
 * history is capped per assistant, because an assistant is edited for years and
 * an unbounded table would grow with every keystroke's save.
 */
export interface NewAssistantKnowledgeRevision {
  id: string
  assistantId: string
  knowledge: string
  cause: AssistantKnowledgeRevisionCause
  label?: string
  createdAt: number
}

/** How many versions one assistant keeps. Older ones are pruned on write. */
export const ASSISTANT_KNOWLEDGE_REVISION_LIMIT = 40

/** How much of the document a timeline row shows. */
const EXCERPT_LENGTH = 160

interface RevisionRow {
  id: string
  assistant_id: string
  sequence: number
  cause: AssistantKnowledgeRevisionCause
  label: string | null
  characters: number
  lines: number
  excerpt: string
  created_at: number
}

interface RevisionDetailRow extends RevisionRow {
  knowledge: string
}

/**
 * The counted view of a document, written beside it on save.
 *
 * Lines are counted the way a reader counts them, as non-empty lines, so two
 * versions of the same instructions do not read as different sizes because one
 * has an extra blank line. The excerpt is the first line with its whitespace
 * collapsed, which is the first instruction the assistant follows.
 */
export function summarizeKnowledgeDocument(knowledge: string): {
  characters: number
  lines: number
  excerpt: string
} {
  const lines = knowledge.split('\n')
  const firstLine = lines.find((line) => line.trim().length > 0)?.trim() ?? ''
  return {
    characters: knowledge.length,
    lines: lines.filter((line) => line.trim().length > 0).length,
    excerpt:
      firstLine.length > EXCERPT_LENGTH ? `${firstLine.slice(0, EXCERPT_LENGTH)}…` : firstLine
  }
}

function toRevision(row: RevisionRow): AssistantKnowledgeRevision {
  return {
    id: row.id,
    assistantId: row.assistant_id,
    sequence: row.sequence,
    cause: row.cause,
    label: row.label ?? undefined,
    characters: row.characters,
    lines: row.lines,
    excerpt: row.excerpt,
    createdAt: row.created_at
  }
}

export class AssistantKnowledgeRevisionRepo {
  constructor(private db: Database) {}

  /**
   * Append one version and prune the oldest beyond the cap.
   *
   * The sequence is read and the row written inside one transaction, so two
   * saves that land together cannot claim the same position in the history. This
   * is a write path, which is why its two reads stay on the primary connection;
   * reading history for the panel goes through the worker.
   */
  append(input: NewAssistantKnowledgeRevision): AssistantKnowledgeRevision {
    const summary = summarizeKnowledgeDocument(input.knowledge)
    return this.db.transaction(() => {
      const next = this.db.get<{ sequence: number | null }>(
        'SELECT MAX(sequence) AS sequence FROM assistant_knowledge_revisions WHERE assistant_id = ?',
        input.assistantId
      )
      const sequence = (next?.sequence ?? 0) + 1
      this.db.run(
        `INSERT INTO assistant_knowledge_revisions(
           id, assistant_id, sequence, cause, label, knowledge, characters, lines, excerpt,
           created_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        input.id,
        input.assistantId,
        sequence,
        input.cause,
        input.label ?? null,
        input.knowledge,
        summary.characters,
        summary.lines,
        summary.excerpt,
        input.createdAt
      )
      this.db.run(
        `DELETE FROM assistant_knowledge_revisions WHERE id IN (
           SELECT id FROM assistant_knowledge_revisions
            WHERE assistant_id = ?
            ORDER BY sequence ASC LIMIT ?
         )`,
        input.assistantId,
        Math.max(0, this.countRows(input.assistantId) - ASSISTANT_KNOWLEDGE_REVISION_LIMIT)
      )
      return {
        id: input.id,
        assistantId: input.assistantId,
        sequence,
        cause: input.cause,
        label: input.label,
        ...summary,
        createdAt: input.createdAt
      }
    })
  }

  /** Every version of an assistant's instructions, newest first. */
  async listViaWorker(assistantId: string): Promise<AssistantKnowledgeRevision[]> {
    const result = await this.db.queryViaWorker(
      `SELECT id, assistant_id, sequence, cause, label, characters, lines, excerpt, created_at
         FROM assistant_knowledge_revisions
        WHERE assistant_id = ?
        ORDER BY sequence DESC`,
      [assistantId],
      ASSISTANT_KNOWLEDGE_REVISION_LIMIT
    )
    if (!result.ok) throw new Error('The instruction history could not be read')
    return (result.rows as unknown as RevisionRow[]).map(toRevision)
  }

  /** One version with its text, or null when it belongs to another assistant. */
  async getViaWorker(
    assistantId: string,
    revisionId: string
  ): Promise<AssistantKnowledgeRevisionDetail | null> {
    const result = await this.db.queryViaWorker(
      `SELECT id, assistant_id, sequence, cause, label, knowledge, characters, lines, excerpt,
              created_at
         FROM assistant_knowledge_revisions
        WHERE assistant_id = ? AND id = ?`,
      [assistantId, revisionId],
      1
    )
    if (!result.ok) throw new Error('This version of the instructions could not be read')
    const row = result.rows[0] as unknown as RevisionDetailRow | undefined
    return row ? { ...toRevision(row), knowledge: row.knowledge } : null
  }

  /**
   * How many versions this assistant has, so a caller knows whether any exist.
   *
   * Synchronous on purpose: the only caller is the save that appends a version,
   * and it asks this inside that save's own transaction.
   */
  count(assistantId: string): number {
    return this.countRows(assistantId)
  }

  private countRows(assistantId: string): number {
    const row = this.db.get<{ total: number }>(
      'SELECT COUNT(*) AS total FROM assistant_knowledge_revisions WHERE assistant_id = ?',
      assistantId
    )
    return row?.total ?? 0
  }
}
