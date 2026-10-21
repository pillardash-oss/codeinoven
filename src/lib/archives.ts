/** Explicit archives preserve descendants without changing their individual state. */
export type ArchiveKind = 'project' | 'thread' | 'assistant'
export type ArchiveTab = 'projects' | 'threads' | 'chats' | 'assistants'
export interface ArchiveEntry {
  kind: ArchiveKind
  id: string
  name: string
  projectId: string | null
  ownerName?: string
  archivedAt: number
}

/** SQL identifiers are internal constants, never user input. */
export function unarchivedEntitySql(kind: ArchiveKind, alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM archives a WHERE a.kind = '${kind}' AND a.entity_id = ${alias}.id)`
}

/**
 * WHERE fragment asserting a thread's own subtree holds no archived thread.
 *
 * Deleting a thread sweeps its descendants (a task owns its runs, a coordinator
 * its workers), so archiving any thread in that subtree protects the whole
 * subtree: automatic eviction must never carry an archived thread down with an
 * evictable one, and an archive row must never outlive the conversation the
 * user asked to keep.
 */
export function unarchivedSubtreeSql(alias = 'threads'): string {
  return `NOT EXISTS (
    SELECT 1 FROM threads archived_child
    WHERE (archived_child.assistant_task_id = ${alias}.id
        OR archived_child.coordinator_thread_id = ${alias}.id)
      AND (archived_child.archived = 1 OR EXISTS (
        SELECT 1 FROM archives child_archive
        WHERE child_archive.kind = 'thread' AND child_archive.entity_id = archived_child.id))
  )`
}

/** Inherited archives are checked without rewriting every descendant. */
export function unarchivedThreadSql(alias = 'threads'): string {
  return `${alias}.archived = 0
    AND NOT EXISTS (SELECT 1 FROM archives a WHERE
      (a.kind = 'thread' AND a.entity_id = ${alias}.id) OR
      (a.kind = 'project' AND a.entity_id = ${alias}.project_id) OR
      (a.kind = 'assistant' AND a.entity_id = ${alias}.assistant_id))
    AND NOT EXISTS (SELECT 1 FROM threads archive_parent
      WHERE archive_parent.id IN (${alias}.assistant_task_id, ${alias}.coordinator_thread_id)
        AND (archive_parent.archived = 1 OR EXISTS (
          SELECT 1 FROM archives parent_archive
          WHERE parent_archive.kind = 'thread' AND parent_archive.entity_id = archive_parent.id)))`
}
