import type { Database as DatabaseType } from 'better-sqlite3'
import { DON_ACCENT_COLOR, DON_ASSISTANT_ID } from '../../../lib/don-assistant'
import type { DatabaseMigration } from './migration'

/**
 * Schema version 10: Don wears a neutral accent.
 *
 * Don is seeded with an accent chosen at random, like any assistant built by
 * talking, so every install ended up with an orchestrator in some unrelated
 * colour. Don is not one of the user's teammates: it is the door the rest of them
 * stand under, and it now wears a neutral from the project palette everywhere it
 * appears. The seed carries that colour for installs created from here on, and
 * this sets it on the row an existing install already has.
 *
 * Only Don's row is touched, and only once: the version ledger means a colour the
 * user picks afterwards is never rewritten by this build again. A fresh install
 * gets the colour from the seed and never walks the chain, so both paths agree.
 *
 * Idempotent: the statement writes the same value if it runs twice.
 */
export const versionTenMigration: DatabaseMigration = {
  version: 10,
  summary: "Don's accent colour is set to the app's neutral",
  apply(connection: DatabaseType): void {
    connection
      .prepare('UPDATE assistants SET color = ? WHERE id = ?')
      .run(DON_ACCENT_COLOR, DON_ASSISTANT_ID)
  }
}
