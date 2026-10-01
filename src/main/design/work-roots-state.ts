import { DEFAULT_WORK_ROOTS, workRootForKind, type WorkRoots } from '../../lib/design/work-roots'
import type { AuthoredWorkKind, WorkRootRelocationReport } from '../../lib/ipc/design'

/**
 * The roots the app is using right now, and what the last change moved.
 *
 * The setting lives in the config file, which is asynchronous to read, while its
 * readers are everywhere: the two path resolvers run on every capability call,
 * the board reads it on every list, and the tab recogniser reads it on every
 * navigation. Reading the file in each of them would put a disk read on a
 * navigation and would still let two of them see different values while a save
 * was in flight.
 *
 * So one value is held here, seeded at startup and replaced on every save, and
 * every main-process reader takes it from here. That is the same shape the
 * prototype preview server uses for its CDN policy, and for the same reason: the
 * thing a setting configures reads the setting, not a copy of it.
 *
 * The reports live beside it because they belong to the same question. A change
 * moves folders across every project, and the only moment the user can be told
 * what moved is the save that caused it, which happens before the renderer asks.
 */

let roots: WorkRoots = { ...DEFAULT_WORK_ROOTS }
let reports: WorkRootRelocationReport[] = []

/** Seed or replace the live roots. Called at startup and after every config save. */
export function setWorkRoots(next: WorkRoots): void {
  roots = { ...next }
}

/** A copy, so a caller cannot change the live value by accident. */
export function currentWorkRoots(): WorkRoots {
  return { ...roots }
}

/** One kind's folder, which is what a resolver defaults to. */
export function currentWorkRoot(kind: AuthoredWorkKind): string {
  return workRootForKind(roots, kind)
}

/** Remember what the last change moved, for the surfaces that report it. */
export function setWorkRootReports(next: readonly WorkRootRelocationReport[]): void {
  reports = next.map((report) => ({ ...report }))
}

/** What the last change moved, oldest kind first. Empty until a root is changed. */
export function currentWorkRootReports(): WorkRootRelocationReport[] {
  return reports.map((report) => ({ ...report }))
}
