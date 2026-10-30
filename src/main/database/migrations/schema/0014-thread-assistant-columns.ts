import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/**
 * Existing databases predate assistant-space task columns: assistant grouping,
 * custom row icon, per-task schedule override, and last-run timestamp.
 */
export const threadAssistantColumnsMigration: SchemaMigration = {
  id: '0014-thread-assistant-columns',
  summary: 'threads gain the assistant task columns and are pinned for knowledge threads',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'threads')
    addColumn(connection, columns, 'threads', 'assistant_id', 'TEXT')
    addColumn(connection, columns, 'threads', 'assistant_icon_type', 'TEXT')
    addColumn(connection, columns, 'threads', 'assistant_icon', 'TEXT')
    addColumn(connection, columns, 'threads', 'schedule_override', 'TEXT')
    // A task's own schedule switch: 1 schedules it even when its assistant is
    // unscheduled, 0 keeps it off the clock even when its assistant is scheduled,
    // and NULL inherits the assistant. Tasks predating it read back as inheriting.
    addColumn(connection, columns, 'threads', 'scheduled', 'INTEGER')
    addColumn(connection, columns, 'threads', 'last_run_at', 'INTEGER')
    addColumn(connection, columns, 'threads', 'last_dispatched_at', 'INTEGER')
    addColumn(connection, columns, 'threads', 'last_success_at', 'INTEGER')
    addColumn(
      connection,
      columns,
      'threads',
      'assistant_getting_started',
      'INTEGER NOT NULL DEFAULT 0'
    )
    // Each run of a task executes on its own thread; this column links a run
    // back to the task it belongs to. Tasks predating it read back as tasks.
    addColumn(connection, columns, 'threads', 'assistant_task_id', 'TEXT')
    // An assistant's knowledge ("Getting started") thread is pinned for its whole
    // life: pinning is what keeps it out of automatic eviction. It still renders
    // nested inside its assistant (AssistantSidebar keeps a pinned knowledge thread
    // in place), so the pin is retention, not a move to the Pinned section. Rows
    // created before that rule are pinned once here, and the guard makes the
    // statement a no-op on every later boot.
    connection.exec(
      'UPDATE threads SET pinned = 1, pinned_at = COALESCE(pinned_at, updated_at) ' +
        'WHERE assistant_getting_started = 1 AND pinned = 0'
    )
  }
}
