import type { Database as DatabaseType } from 'better-sqlite3'
import type { DatabaseMigration } from './migration'

/**
 * Schema version 6: a thread can run in a project scope that is not its home,
 * records the commit its run started from, and records who dispatched it.
 *
 * `project_id` used to answer three questions at once: where a thread is
 * listed, which checkout its session reads, and whether a project board row
 * arrived on its own. They coincide for every thread the app had before bound
 * assistant tasks, so nothing ever had to tell them apart.
 *
 * The columns are additive and every one of them is nullable, so no backfill is
 * needed and every existing row keeps resolving exactly where it resolved
 * before:
 *
 * - `bound_scope_*` is the pair, plus the home container for an honest unbind.
 *   A path is deliberately not stored: a worktree can be moved, a project
 *   relocated or a worktree repaired, and a persisted path would outlive all
 *   three as a lie.
 * - `run_base` is the commit a run started from, as JSON, written once when the
 *   run begins and never when it settles, so a resumed run keeps its original
 *   base.
 * - `dispatch_origin` is the assistant origin of an orchestrated dispatch, as
 *   JSON, written once at creation so a board row states origin rather than
 *   inferring it.
 * - `park_reason` is the typed reason a run parked on its bound scope's health.
 *   Stored so a parked run still explains itself after a restart, and cleared
 *   the moment the run leaves the parked state.
 */
export const versionSixMigration: DatabaseMigration = {
  version: 6,
  summary:
    'threads record the project scope they run in, their run base, and their dispatch origin',
  apply(connection: DatabaseType): void {
    connection.exec(`
ALTER TABLE threads ADD COLUMN bound_scope_project_id TEXT;
ALTER TABLE threads ADD COLUMN bound_scope_scope_id TEXT;
ALTER TABLE threads ADD COLUMN bound_scope_home_project_id TEXT;
ALTER TABLE threads ADD COLUMN run_base TEXT;
ALTER TABLE threads ADD COLUMN dispatch_origin TEXT;
ALTER TABLE threads ADD COLUMN park_reason TEXT;
`)
  }
}
