import type { Database as DatabaseType } from 'better-sqlite3'
import {
  ASSISTANT_INSTRUCTIONS_HEADING,
  ASSISTANT_PERSONALITY_HEADING,
  hasKnowledgeHeading
} from '../../../../lib/assistant-personality'
import type { SchemaMigration } from '../migration'

/**
 * Repair a knowledge that an earlier build of the personality fold damaged.
 *
 * The first version of the fold put the personality heading directly above the
 * document, so on a knowledge with no headings of its own the heading owned
 * every line under it: the user's whole instruction set showed up as one
 * section called `Personality`. This splits such a document back at the blank
 * line the fold itself inserted, restoring the personality as the first section
 * and the rest as `Instructions`.
 *
 * It only ever touches that exact shape (a document whose only heading is the
 * leading personality one), so it is idempotent and cannot touch a knowledge
 * that has since been repaired or authored properly.
 */
export const repairCollapsedAssistantPersonalityMigration: SchemaMigration = {
  id: '0030-repair-collapsed-assistant-personality',
  summary: 'a knowledge the first personality fold collapsed is split back into sections',
  apply(connection: DatabaseType): void {
    const heading = `${ASSISTANT_PERSONALITY_HEADING}\n`
    const rows = connection
      .prepare(`SELECT id, knowledge FROM assistants WHERE knowledge LIKE ?`)
      .all(`${ASSISTANT_PERSONALITY_HEADING}%`) as Array<{ id: string; knowledge: string }>
    if (rows.length === 0) return
    const update = connection.prepare('UPDATE assistants SET knowledge = ? WHERE id = ?')
    for (const row of rows) {
      const knowledge = row.knowledge ?? ''
      if (!knowledge.startsWith(heading)) continue
      const body = knowledge.slice(heading.length)
      // A document with any heading of its own closed the personality block
      // already, so there is nothing to repair.
      if (hasKnowledgeHeading(body)) continue
      const seam = body.search(/\n[ \t]*\n/)
      if (seam === -1) continue
      const personality = body.slice(0, seam).trim()
      const rest = body.slice(seam).trim()
      if (!personality || !rest) continue
      update.run(
        `${ASSISTANT_PERSONALITY_HEADING}\n${personality}\n\n${ASSISTANT_INSTRUCTIONS_HEADING}\n${rest}`,
        row.id
      )
    }
  }
}
