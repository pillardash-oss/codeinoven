import type { Database } from '../database'
import type { ThreadExpertDecision } from '../../../lib/experts'

/**
 * The durable record of what a thread decided about its experts.
 *
 * The question the card asks is about work, not about a window: whether a session
 * may delegate to the models the user staffed. That answer has to survive a
 * restart, because the alternative is a session that quietly starts delegating
 * again after the app reopens, or one that asks the user the same question on
 * every message. So the decision is a row, and the row follows the thread's
 * deletion through the foreign key.
 *
 * The signature stored with the answer is what lets the card come back. A thread
 * that answered about one set of experts has not answered about a different one,
 * so the row records the set it was about and the surface compares.
 */

interface ThreadExpertRow {
  thread_id: string
  choice: string
  silent: number
  signature: string
  updated_at: number
}

/**
 * The stored choice, read back as a choice the app switches on.
 *
 * The column only ever holds one of the two, so an unexpected value reads as
 * `all`: a permissive answer is the one the user can still correct, while a mute
 * invented by a bad write would silently stop delegation with no visible reason.
 */
function choiceOfRow(value: string): ThreadExpertDecision['choice'] {
  return value === 'off' ? 'off' : 'all'
}

function rowToDecision(row: ThreadExpertRow): ThreadExpertDecision {
  return {
    choice: choiceOfRow(row.choice),
    silent: row.silent === 1,
    signature: row.signature,
    decidedAt: row.updated_at
  }
}

export class ExpertSettingsRepo {
  constructor(private readonly db: Database) {}

  /** The thread's decision, or null when it has never been asked. */
  forThread(threadId: string): ThreadExpertDecision | null {
    const row = this.db.get<ThreadExpertRow>(
      'SELECT * FROM thread_experts WHERE thread_id = ?',
      threadId
    )
    return row ? rowToDecision(row) : null
  }

  /**
   * Record the thread's answer. A thread answers about one expert set at a time,
   * so a second answer replaces the first rather than adding a row.
   */
  upsert(threadId: string, decision: ThreadExpertDecision): void {
    this.db.run(
      `INSERT INTO thread_experts(thread_id, choice, silent, signature, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         choice = excluded.choice,
         silent = excluded.silent,
         signature = excluded.signature,
         updated_at = excluded.updated_at`,
      threadId,
      decision.choice,
      decision.silent ? 1 : 0,
      decision.signature,
      decision.decidedAt
    )
  }

  /** Drop a thread's answer, for a caller that owns the thread's deletion. */
  deleteThread(threadId: string): void {
    this.db.run('DELETE FROM thread_experts WHERE thread_id = ?', threadId)
  }
}
