import { lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { normalizeWorkRoot, sanitizeWorkName, workRootsConflict } from '../../lib/design/work-roots'
import type { DesignEntry, UpdateWorkDetails, UpdateWorkDetailsResult } from '../../lib/ipc/design'
import type { Database } from '../database/database'
import { DesignRepo } from '../database/repositories/design-repo'
import { isInsideProject } from '../preview/served-folder'
import { currentWorkRoots, projectWorkRootPaths, saveProjectWorkRoot } from './work-roots-state'
import { withWorkRegistryLock } from './work-folder-registry'

const pending = new Map<string, Promise<unknown>>()

/** Serialize folder moves within a project, including renames from another board. */
export async function updateWorkDetails(input: {
  database: Database
  projectId: string
  projectPath: string
  details: UpdateWorkDetails
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
    (details.newOnly !== undefined && typeof details.newOnly !== 'boolean') ||
    typeof details.thisOnly !== 'boolean'
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
  if (!selected && (details.directory !== '' || details.thisOnly || !root))
    throw new Error('This work no longer exists. Refresh the board and try again.')
  const moving =
    details.newOnly === true
      ? []
      : root !== undefined && !details.thisOnly
        ? available
        : selected
          ? [selected]
          : []
  if (moving.length > 500) throw new Error('Move at most 500 folders at once')
  const plans = moving
    .map((item) => ({
      from: item.directory,
      to: `${root ?? dirname(item.directory)}/${item === selected ? (name ?? item.name) : item.name}`
    }))
    .filter((plan) => plan.from !== plan.to)
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
    if (root !== undefined && !details.thisOnly) {
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
