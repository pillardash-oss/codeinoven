import type { Database as DatabaseType } from 'better-sqlite3'
import type { DatabaseMigration } from './migration'
import { partsToSearchText } from '../repositories/agent-message-repo'
import type { AgentPart } from '../../../lib/types'

/**
 * Schema version 15: rebuild `search_text` from the conversation's words only.
 *
 * Search is what a person recognises — the user's request and the agent's reply —
 * and it is the same index an agent reads through `search_threads`. Rows written
 * before the corpus was narrowed also carried reasoning and sub-agent cards, so
 * those searches still matched text the user was never shown. This repair rewrites
 * an affected row's `search_text`, which the FTS trigger picks up on its own.
 *
 * The thread's `updated_at` is bumped for every thread whose text changed, because
 * that is the stamp the embedding index compares to decide whether a thread's
 * windows are stale. `last_activity` is untouched, so no listing or recency order
 * moves: only the vector index notices and re-embeds.
 *
 * A fresh install gets the narrowed corpus from the writer and runs nothing here,
 * because a migration only applies to a database already on disk.
 */
export const versionFifteenMigration: DatabaseMigration = {
  version: 15,
  summary: 'rebuild the search text from the conversation words only',
  apply(connection: DatabaseType): void {
    // A rowid cursor keeps the pass bounded: a thread can hold tens of thousands
    // of messages, and rewriting them all in one transaction would hold the write
    // lock for the whole parse.
    const read = connection.prepare(
      `SELECT rowid AS row_id, id, thread_id, parts, search_text FROM agent_messages
        WHERE rowid > ?
          AND (parts LIKE '%"type":"reasoning"%' OR parts LIKE '%"type":"subagent"%')
        ORDER BY rowid LIMIT 500`
    )
    const rewrite = connection.prepare('UPDATE agent_messages SET search_text = ? WHERE id = ?')
    const touch = connection.prepare(
      'UPDATE threads SET updated_at = MAX(updated_at, ?) WHERE id = ?'
    )
    const now = Date.now()
    const touched = new Set<string>()

    const repair = connection.transaction((): void => {
      let cursor = 0
      for (;;) {
        const rows = read.all(cursor) as Array<{
          row_id: number
          id: string
          thread_id: string
          parts: string
          search_text: string
        }>
        if (rows.length === 0) return
        for (const row of rows) {
          cursor = row.row_id
          let parts: AgentPart[]
          try {
            parts = JSON.parse(row.parts) as AgentPart[]
          } catch {
            // A row whose parts cannot be parsed is left exactly as it was: a
            // repair must never invent a search text for content it cannot read.
            continue
          }
          const repaired = partsToSearchText(parts)
          if (repaired === row.search_text) continue
          rewrite.run(repaired, row.id)
          touched.add(row.thread_id)
        }
      }
    })
    repair()

    for (const threadId of touched) {
      touch.run(now, threadId)
    }
  }
}
