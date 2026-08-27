/**
 * Single source of truth for tables that store a bare `thread_id` column
 * without a real `ON DELETE CASCADE` foreign key to `threads`. SQLite can't
 * clean these up on its own, so `thread-manager.ts` deletes them explicitly
 * whenever a thread (or every thread in a project) is removed.
 *
 * When a future feature adds a new table keyed by `thread_id` — specs,
 * generated work, anything — register it here instead of hand-writing a
 * `DELETE` statement at the call site. It will automatically be covered by
 * both single-thread deletion and project deletion.
 *
 * Prefer a real foreign key (`REFERENCES threads(id) ON DELETE CASCADE`) in
 * `schema.ts` when possible; only add an entry here for tables that can't
 * use one (e.g. because they're also keyed by `project_id`, or predate FK
 * enforcement and can't be safely migrated).
 */
export interface ThreadScopedTable {
  table: string
  threadColumn: string
  /** Set when the table is also scoped by `project_id` and both must match. */
  projectColumn?: string
}

export const THREAD_SCOPED_TABLES: ThreadScopedTable[] = [
  { table: 'spec_workflow', threadColumn: 'thread_id', projectColumn: 'project_id' },
  { table: 'spec_versions', threadColumn: 'thread_id', projectColumn: 'project_id' },
  { table: 'plans', threadColumn: 'thread_id' },
  { table: 'checklists', threadColumn: 'thread_id' },
  { table: 'audit_reports', threadColumn: 'thread_id', projectColumn: 'project_id' },
  { table: 'turn_checkpoints', threadColumn: 'thread_id', projectColumn: 'project_id' },
  { table: 'active_turns', threadColumn: 'thread_id', projectColumn: 'project_id' },
  { table: 'provider_sync_cursors', threadColumn: 'thread_id' },
  // The following also cascade via a real FK; kept here as an explicit,
  // redundant belt-and-suspenders delete since they're the highest-volume
  // tables (message/usage history) and were historically deleted manually.
  { table: 'agent_messages', threadColumn: 'thread_id' },
  { table: 'harness_usage', threadColumn: 'thread_id' },
  { table: 'harness_usage_messages', threadColumn: 'thread_id' },
  { table: 'harness_usage_models', threadColumn: 'thread_id' }
]
