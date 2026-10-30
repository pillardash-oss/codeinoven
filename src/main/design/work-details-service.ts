import { lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import {
  AUTHORED_WORK_KINDS,
  DEFAULT_WORK_ROOTS,
  normalizeWorkRoot,
  sanitizeWorkName,
  workRootForKind,
  workRootsConflict
} from '../../lib/design/work-roots'
import type { DesignEntry, UpdateWorkDetails, UpdateWorkDetailsResult } from '../../lib/ipc/design'
import type { Database } from '../database/database'
import { DesignRepo } from '../database/repositories/design-repo'
import { isInsideProject } from '../preview/served-folder'
import { currentWorkRoots, projectWorkRootPaths, saveProjectWorkRoot } from './work-roots-state'
import { withWorkRegistryLock } from './work-folder-registry'

/**
 * Renaming one design or video, or moving it, and pointing a project's folder for
 * new work somewhere else.
 *
 * The two are separate operations with separate reach, and the caller says which
 * one it is asking for: `scope: 'work'` moves the one folder the request names and
 * writes nothing about the project, `scope: 'project'` records where the project's
 * NEW work is written and moves nothing at all. The scope is the only thing that
 * decides, so a change made from one design's dialog cannot reach the project, and
 * a change made from the board cannot claim to have been about one design.
 *
 * A save-folder change deliberately does not sweep existing work into the new
 * folder. Where new work goes and where work already written lives are two
 * separate facts, and only a move changes the second one: a user who points the
 * save folder at `docs/designs` keeps the designs that are already somewhere else
 * exactly where they are, and moving one design out of the collection leaves the
 * collection - and every design still in it - alone.
 *
 * Everything here is validated against what is on disk before a single folder
 * moves, and a failure puts the folders that already moved back where they were.
 */

const pending = new Map<string, Promise<unknown>>()

/**
 * Whether a folder is one of the project's own collections rather than work.
 *
 * Both the app default and the project's recorded folder are containers: every
 * design or video of the project sits inside one of them. Moving a container moves
 * all of them at once, so a request naming one is refused rather than quietly
 * relocating a whole collection behind a dialog that said "this one only".
 */
function isWorkRootFolder(projectId: string, directory: string): boolean {
  if (directory === '.cio') return true
  return AUTHORED_WORK_KINDS.some((candidate) =>
    [
      workRootForKind(DEFAULT_WORK_ROOTS, candidate),
      ...projectWorkRootPaths(projectId, candidate)
    ].includes(directory)
  )
}

/** Serialize folder moves within a project, including renames from another board. */
export async function updateWorkDetails(input: {
  database: Database
  projectId: string
  projectPath: string
  details: UpdateWorkDetails
  /**
   * Whether this scope records one save root for all of its work.
   *
   * A project does, and the dialog's "change save folder" is that setting: where
   * its next design or composition is written, which is not a move. A conversation
   * workspace does not: its root is the directory it runs in, and every assistant
   * task shares one project id, so a stored root there would repoint every
   * assistant's work at one folder. A single move is still allowed; the
   * project-wide setting is refused.
   */
  projectScope?: boolean
  list: () => Promise<DesignEntry[]>
  relocate: (from: string, to: string) => Promise<void>
  onRelocated?: (moves: Array<{ from: string; to: string }>) => void
}): Promise<UpdateWorkDetailsResult> {
  const previous = pending.get(input.projectId) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(() => moveDetails(input))
  pending.set(input.projectId, operation)
  try {
    return await operation
  } finally {
    if (pending.get(input.projectId) === operation) pending.delete(input.projectId)
  }
}

async function moveDetails(
  input: Parameters<typeof updateWorkDetails>[0]
): Promise<UpdateWorkDetailsResult> {
  const { details, projectId, projectPath, database } = input
  if (
    !details ||
    (details.kind !== 'design' && details.kind !== 'video') ||
    typeof details.directory !== 'string' ||
    details.directory.length > 1024 ||
    (details.scope !== 'work' && details.scope !== 'project')
  ) {
    throw new Error('Invalid work details')
  }
  const roots = currentWorkRoots(projectId)
  const root = details.root === undefined ? undefined : normalizeWorkRoot(details.root)
  if (
    root === null ||
    (root !== undefined && workRootsConflict({ ...roots, [details.kind]: root }))
  ) {
    throw new Error('Choose a project-relative folder separate from the other work folder')
  }
  if (details.scope === 'project' && root === undefined) {
    throw new Error('Choose the project save folder')
  }
  if (details.scope === 'project' && input.projectScope === false) {
    throw new Error(
      'This conversation writes its designs and videos into its own workspace, so move one at a time instead'
    )
  }
  if (details.name !== undefined && (typeof details.name !== 'string' || details.name.length > 240))
    throw new Error('Invalid name')
  if (
    root &&
    projectWorkRootPaths(projectId, details.kind === 'design' ? 'video' : 'design').some(
      (other) => root === other || root.startsWith(`${other}/`) || other.startsWith(`${root}/`)
    )
  )
    throw new Error('Save folder overlaps an existing folder for the other work kind')
  const name = details.name === undefined ? undefined : sanitizeWorkName(details.name)
  if (name === '') throw new Error('Enter a name containing letters or numbers')
  const items = await input.list()
  if (
    root &&
    items.some((item) => root === item.directory || root.startsWith(`${item.directory}/`))
  ) {
    throw new Error('The save folder cannot be inside an existing design or video')
  }
  const available = items.filter((item) => !item.missing)
  const selected = available.find((item) => item.directory === details.directory)
  // A save-folder change needs no folder at all: it records where the next design
  // or composition is written, and the folder the dialog happened to be opened on
  // may well have been removed in the meantime.
  const movesWork = details.scope === 'work'
  if (movesWork && !selected)
    throw new Error('This work no longer exists. Refresh the board and try again.')
  // A folder that is a collection of other work is not a design or a video, and
  // moving one would take every folder inside it along. The board lists work
  // rather than containers, so this only fires on a request that names one
  // directly; refusing it here is what keeps a single move single.
  const moving = selected ? [selected] : []
  if (moving.some((item) => isWorkRootFolder(projectId, item.directory))) {
    throw new Error('Choose a folder for this one design or video, not the project save folder')
  }
  const plans = movesWork
    ? moving
        .map((item) => ({
          from: item.directory,
          to: `${root ?? dirname(item.directory)}/${name ?? item.name}`
        }))
        .filter((plan) => plan.from !== plan.to)
    : []
  const canonicalProject = await realpath(projectPath)
  if (root) {
    let ancestor = resolve(projectPath, root)
    while (!(await lstat(ancestor).catch(() => null))) ancestor = dirname(ancestor)
    const canonical = await realpath(ancestor)
    if (canonical !== canonicalProject && !isInsideProject(canonicalProject, canonical)) {
      throw new Error('Save path escapes the project')
    }
  }
  const targets = new Set<string>()
  const sources = plans.map((plan) => resolve(projectPath, plan.from))
  for (const plan of plans) {
    const source = resolve(projectPath, plan.from)
    const target = resolve(projectPath, plan.to)
    if (!isInsideProject(canonicalProject, await realpath(source)))
      throw new Error('Work folder escapes the project')
    if (
      !isInsideProject(projectPath, target) ||
      sources.some((sourcePath) => target === sourcePath || target.startsWith(`${sourcePath}/`))
    )
      throw new Error('Save path cannot be inside the work being moved')
    let ancestor = dirname(target)
    while (!(await lstat(ancestor).catch(() => null))) ancestor = dirname(ancestor)
    if (
      (await realpath(ancestor)) !== canonicalProject &&
      !isInsideProject(canonicalProject, await realpath(ancestor))
    )
      throw new Error('Save path escapes the project')
    if (targets.has(target) || (await lstat(target).catch(() => null)))
      throw new Error(`A folder named "${basename(target)}" already exists at the destination`)
    targets.add(target)
  }
  const moved: typeof plans = []
  const repo = new DesignRepo(database)
  try {
    for (const plan of plans) {
      await mkdir(dirname(resolve(projectPath, plan.to)), { recursive: true })
      await withWorkRegistryLock(projectId, async () => {
        await input.relocate(plan.from, plan.to)
        moved.push(plan)
        await repo.rebaseRoot({ projectId, ...plan })
      })
      await new Promise<void>((resume) => setImmediate(resume))
    }
    if (details.scope === 'project' && root !== undefined) {
      await saveProjectWorkRoot(database, projectId, details.kind, root)
    }
  } catch (error) {
    for (const plan of moved.reverse()) {
      await withWorkRegistryLock(projectId, async () => {
        await input.relocate(plan.to, plan.from)
        await repo.rebaseRoot({ projectId, from: plan.to, to: plan.from })
      })
    }
    throw error
  }
  if (plans.length > 0) input.onRelocated?.(plans)
  return {
    directory: plans.find((plan) => plan.from === details.directory)?.to ?? details.directory,
    moved: plans.length
  }
}
