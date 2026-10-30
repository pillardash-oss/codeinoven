import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'

/**
 * Land threads a settled audit left parked on `spec`.
 *
 * An audit parks its thread on `spec` while the report waits on the user, and
 * settling the report used to clear the audit state without moving the status:
 * the thread kept reading "Spec ready" with nothing left to review, holding a
 * review count on its project strip forever. `completed` is what a settled
 * audit means, so the thread is done.
 *
 * Only a row whose `spec` can have come from an audit is touched: an
 * independent-audit thread (locked out of the specification flows for its
 * lifetime) and an Achievement coordinator that owns a durable auditor. A
 * thread parked on a specification that is still waiting for approval keeps
 * its status, and so does an audit `offered`, which is still an open question
 * for the user. Idempotent: a database with nothing left to settle is
 * untouched.
 */
export const settledAuditThreadStatusMigration: SchemaMigration = {
  id: '0045-settled-audit-thread-status',
  summary: 'threads a settled audit left parked on spec are marked completed',
  apply(connection: DatabaseType): void {
    connection.exec(
      `UPDATE threads
          SET status = 'completed',
              scope_sort_order = NULL,
              sort_order = NULL
        WHERE status = 'spec'
          AND audit_state IS NULL
          AND (
            independent_audit = 1
            OR (achievement_role = 'coordinator' AND auditor_thread_id IS NOT NULL)
          )`
    )
  }
}
