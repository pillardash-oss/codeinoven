import { cp, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AUTHORED_WORK_KINDS, type WorkRoots } from '../../lib/design/work-roots'
import type { AuthoredWorkKind, WorkRootRelocationReport } from '../../lib/ipc/design'
import type { Database } from '../database/database'
import { DesignRepo } from '../database/repositories/design-repo'
import { isInsideProject } from '../preview/served-folder'
import { Logger } from '../system/logger'

/**
 * Moving authored work when the user points a root somewhere else.
 *
 * The two roots are one app-wide setting, so changing one moves every project's
 * folder: a project left behind would keep its work under a root the board no
 * longer lists, which reads to the user as having lost it. Moving is therefore
 * done here, once, for the whole set, rather than lazily per project, which would
 * need the app to remember what each project's folder used to be.
 *
 * Three rules keep it safe. A folder whose name already exists at the destination
 * is left where it is and reported, because neither folder is the app's to
 * discard and a merge would silently pick a winner per file. The old folder is
 * removed only when it is empty, so a partial move never hides work behind a
 * deleted parent. And the whole pass is bounded and batched, because it runs
 * inside a settings save and must not hold the main thread.
 */

/** Most projects one relocation visits, so a hand-built database cannot stall a save. */
export const MAX_RELOCATION_PROJECTS = 200

/** Most folders moved from one root of one project. */
export const MAX_RELOCATION_FOLDERS = 500

/** One project the relocation may touch. */
export interface WorkRootRelocationProject {
  id: string
  /** Shown in a clash or a failure, so the user knows which project to look at. */
  name: string
  /** Absolute path of the project root. */
  path: string
}

/** What one changed root means: where the work is, and where it is going. */
export interface WorkRootRelocationPlan {
  kind: AuthoredWorkKind
  from: string
  to: string
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether anything already sits at this path, of any kind. */
async function pathExists(path: string): Promise<boolean> {
  const entries = await readdir(path).catch(() => null)
  return entries !== null
}

/** A rename that failed because the two folders are on different devices. */
function isCrossDevice(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EXDEV'
}

/**
 * Move every folder of one project's root into the new one.
 *
 * Answers how many folders moved, so the caller only re-points the thread rows of
 * a project that actually changed and a no-op saves a query.
 */
async function relocateProject(input: {
  project: WorkRootRelocationProject
  plan: WorkRootRelocationPlan
  report: WorkRootRelocationReport
}): Promise<number> {
  const { project, plan, report } = input
  const fromAbsolute = resolve(project.path, plan.from)
  const toAbsolute = resolve(project.path, plan.to)
  // Both ends are read from a setting, so the escape check is repeated here
  // rather than trusted: this is the one place in the app that deletes folders.
  if (!isInsideProject(project.path, fromAbsolute) || !isInsideProject(project.path, toAbsolute)) {
    return 0
  }
  const entries = await readdir(fromAbsolute, { withFileTypes: true }).catch(() => [])
  const candidates = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  const folders = candidates.slice(0, MAX_RELOCATION_FOLDERS)
  if (folders.length === 0) return 0
  if (candidates.length > folders.length) {
    // Refusing the remainder is the honest answer: a partial move that said
    // nothing would leave folders behind that the board no longer lists.
    report.failed.push({
      project: project.name,
      name: `${candidates.length - folders.length} more folders`,
      reason: `only ${MAX_RELOCATION_FOLDERS} folders are moved at once, so the rest are still in ${plan.from}`
    })
  }

  await mkdir(toAbsolute, { recursive: true })
  report.projects += 1
  let moved = 0
  for (const folder of folders) {
    const source = join(fromAbsolute, folder.name)
    const target = join(toAbsolute, folder.name)
    if (await pathExists(target)) {
      report.clashes.push({ project: project.name, name: folder.name })
      continue
    }
    try {
      await rename(source, target)
      moved += 1
      continue
    } catch (error) {
      if (!isCrossDevice(error)) {
        report.failed.push({ project: project.name, name: folder.name, reason: reasonOf(error) })
        continue
      }
    }
    // A rename cannot cross devices, so the one case it refuses is finished by
    // copying and then removing the original. A failed copy leaves the source
    // untouched, which is why the removal is not in a `finally`.
    try {
      await cp(source, target, { recursive: true, errorOnExist: true, force: false })
      await rm(source, { recursive: true, force: true })
      moved += 1
    } catch (error) {
      report.failed.push({ project: project.name, name: folder.name, reason: reasonOf(error) })
    }
  }
  report.moved += moved
  // Only an empty folder is removed: a clash or a failure leaves work behind, and
  // deleting its parent would hide exactly what the report is telling the user.
  if (moved > 0) await rmdir(fromAbsolute).catch(() => undefined)
  return moved
}

/**
 * Move every project's work from the old roots into the new ones.
 *
 * One report per root that changed, in the order the kinds are declared, so the
 * settings page can say what happened to designs and to videos separately. A root
 * that did not change is skipped rather than reported as an empty move.
 */
export async function relocateWorkRoots(input: {
  database: Database
  projects: readonly WorkRootRelocationProject[]
  previous: WorkRoots
  next: WorkRoots
}): Promise<WorkRootRelocationReport[]> {
  const plans: WorkRootRelocationPlan[] = []
  for (const kind of AUTHORED_WORK_KINDS) {
    const from = input.previous[kind]
    const to = input.next[kind]
    if (from !== to) plans.push({ kind, from, to })
  }
  if (plans.length === 0) return []

  const projects = input.projects.slice(0, MAX_RELOCATION_PROJECTS)
  const reports: WorkRootRelocationReport[] = []
  for (const plan of plans) {
    const report: WorkRootRelocationReport = {
      kind: plan.kind,
      from: plan.from,
      to: plan.to,
      projects: 0,
      moved: 0,
      rebased: 0,
      clashes: [],
      failed: []
    }
    for (const project of projects) {
      const moved = await relocateProject({ project, plan, report })
      // A project whose folders all clashed keeps its rows pointing where its
      // folders still are, so the board opens the work rather than a path that
      // was never created.
      if (moved > 0) {
        report.rebased += await new DesignRepo(input.database).rebaseRoot({
          projectId: project.id,
          from: plan.from,
          to: plan.to
        })
      }
      // One yield per project, so a long move is a slow save rather than a frozen
      // window. The cost is a few hundred macrotasks for a very large install.
      await new Promise<void>((resume) => setImmediate(resume))
    }
    if (report.moved > 0 || report.clashes.length > 0 || report.failed.length > 0) {
      Logger.info('Authored-work folders relocated', {
        kind: report.kind,
        from: report.from,
        to: report.to,
        projects: report.projects,
        moved: report.moved,
        rebased: report.rebased,
        clashes: report.clashes.length,
        failed: report.failed.length
      })
    }
    reports.push(report)
  }
  return reports
}
