import type { Database as DatabaseType } from 'better-sqlite3'
import type { DatabaseMigration } from './migration'

/**
 * Schema version 7: threads that own an Engineering artifact carry the durable
 * Engineering marker.
 *
 * `threads.engineering` is what the sidebar and the conversation view read
 * without a lifecycle round trip, and the view hydrates a thread's Engineering
 * state only while it is set. The marker used to be written by one caller, the
 * lifecycle selection handler, so a thread whose Assignment, Spec, Brainstorm
 * or PRD was created by an agent tool owned the artifact but not the marker:
 * the card and the header's Studio control never appeared, because the view had
 * no reason to read state that existed. Artifact engines now write the marker
 * beside the artifact; this repairs the rows written before they did.
 *
 * One guarded `UPDATE` with `EXISTS` lookups against the indexed artifact
 * tables, idempotent on re-run because it only ever widens the marked set by
 * rows that genuinely own an artifact or an engaged lifecycle.
 */
export const versionSevenMigration: DatabaseMigration = {
  version: 7,
  summary: 'threads that own an engineering artifact carry the engineering marker',
  apply(connection: DatabaseType): void {
    connection.exec(`
UPDATE threads
   SET engineering = 1
 WHERE engineering = 0
   AND (
     EXISTS (
       SELECT 1 FROM assignment_workflow workflow
        WHERE workflow.project_id = threads.project_id
          AND workflow.coordinator_thread_id = threads.id
     )
     OR EXISTS (
       SELECT 1 FROM spec_versions spec
        WHERE spec.project_id = threads.project_id
          AND spec.thread_id = threads.id
     )
     OR EXISTS (
       SELECT 1 FROM brainstorm_versions brainstorm
        WHERE brainstorm.project_id = threads.project_id
          AND brainstorm.thread_id = threads.id
     )
     OR EXISTS (
       SELECT 1 FROM prd_versions prd
        WHERE prd.project_id = threads.project_id
          AND prd.thread_id = threads.id
     )
     OR EXISTS (
       SELECT 1 FROM engineering_lifecycle lifecycle
        WHERE lifecycle.project_id = threads.project_id
          AND lifecycle.thread_id = threads.id
          AND (lifecycle.selection != 'none' OR lifecycle.started_at IS NOT NULL)
     )
   );
`)
  }
}
