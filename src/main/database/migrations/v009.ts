import type { Database as DatabaseType } from 'better-sqlite3'
import type { DatabaseMigration } from './migration'
import { addColumn, tableColumns } from './migration-helpers'

/**
 * Schema version 9: a conversation can hold more than one speaker.
 *
 * Don, the orchestrator assistant, answers some messages itself and hands the
 * rest to other assistants, whose replies land in the same thread under their own
 * name and icon. That needs three things the schema did not carry:
 *
 *   - `threads.group_participants` / `group_title`: which assistants take part in
 *     a group thread, host first. A thread without them stays an ordinary thread,
 *     so every existing row reads exactly as it did.
 *   - `agent_messages.author`: the speaking assistant, captured as a snapshot so
 *     a rename or a deletion never rewrites what the conversation recorded.
 *   - `assistants.builtin`: an assistant the app seeds and owns, which the
 *     manager refuses to rename, delete or reorder.
 *
 * Idempotent: `ALTER TABLE ... ADD COLUMN` runs only for a column the table does
 * not already list, so a rerun writes nothing and a fresh install (which gets
 * the snapshot instead of this chain) is untouched.
 */
export const versionNineMigration: DatabaseMigration = {
  version: 9,
  summary: 'group threads, per-message speakers and built-in assistants',
  apply(connection: DatabaseType): void {
    const threadColumns = tableColumns(connection, 'threads')
    addColumn(connection, threadColumns, 'threads', 'group_participants', 'TEXT')
    addColumn(connection, threadColumns, 'threads', 'group_title', 'TEXT')

    const messageColumns = tableColumns(connection, 'agent_messages')
    addColumn(connection, messageColumns, 'agent_messages', 'author', 'TEXT')

    const assistantColumns = tableColumns(connection, 'assistants')
    addColumn(connection, assistantColumns, 'assistants', 'builtin', 'INTEGER NOT NULL DEFAULT 0')
  }
}
