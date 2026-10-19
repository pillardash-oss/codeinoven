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
