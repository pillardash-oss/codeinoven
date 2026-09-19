import type { Thread } from '../types'
import { THREAD_SCOPED_TABLES } from './thread-cleanup-registry'

export type SqlStatement = { sql: string; params: unknown[] }

export function placeholdersFor(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

/** Build one set-based cleanup transaction for a thread tree. */
export function buildThreadDeletionStatements(
  threads: Thread[],
  assignmentIds: Set<string>
): SqlStatement[] {
  if (threads.length === 0) return []

  const threadIds = threads.map((thread) => thread.id)
  const threadPlaceholders = placeholdersFor(threadIds.length)
  const projectId = threads[0].projectId
  const statements: SqlStatement[] = []
  const assignmentValues = [...assignmentIds]

  // Pending turn-feedback rows are NOT resolved here: they keep their captured
  // grading payload (their thread reference is SET NULL) and are judged by the
  // LLM grader immediately after deletion   a lost-cause thread never scores
  // as a pass just because it was deleted.

  if (assignmentValues.length > 0) {
    const assignmentPlaceholders = placeholdersFor(assignmentValues.length)
    statements.push(
      {
        sql: `DELETE FROM assignment_operations WHERE assignment_id IN (${assignmentPlaceholders})`,
        params: assignmentValues
      },
      {
        sql: `DELETE FROM assignment_coordinator_snapshots WHERE assignment_id IN (${assignmentPlaceholders})`,
        params: assignmentValues
      }
    )
  }

  const capabilityPredicate =
    assignmentValues.length > 0
      ? `assignment_id IN (${placeholdersFor(assignmentValues.length)}) OR thread_id IN (${threadPlaceholders})`
      : `thread_id IN (${threadPlaceholders})`
  statements.push({
    sql: `DELETE FROM assignment_api_capabilities WHERE ${capabilityPredicate}`,
    params: assignmentValues.length > 0 ? [...assignmentValues, ...threadIds] : threadIds
  })

  // Every table that stores a bare `thread_id` column *without* a real
  // `ON DELETE CASCADE` foreign key to `threads` must be registered in
  // `THREAD_SCOPED_TABLES` (thread-cleanup-registry.ts). Tables with a real
  // FK clean themselves up via SQLite cascade (PRAGMA foreign_keys = ON is
  // set on every connection) and never need an entry here.
  for (const table of THREAD_SCOPED_TABLES) {
    if (table.projectColumn) {
      statements.push({
        sql: `DELETE FROM ${table.table} WHERE ${table.projectColumn} = ? AND ${table.threadColumn} IN (${threadPlaceholders})`,
        params: [projectId, ...threadIds]
      })
    } else {
      statements.push({
        sql: `DELETE FROM ${table.table} WHERE ${table.threadColumn} IN (${threadPlaceholders})`,
        params: threadIds
      })
    }
  }

  statements.push({
    sql: `DELETE FROM threads WHERE id IN (${threadPlaceholders})`,
    params: threadIds
  })

  return statements
}
