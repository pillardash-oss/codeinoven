import {
  DEFAULT_CIO_CLEANUP_EXCLUDED_CATEGORIES,
  type CioCleanupCategoryId,
  type CioCleanupExclusion,
  type CioCleanupMount
} from './types/cio-cleanup'
import { PROJECT_UTILITIES_DIRECTORY } from './utility-scope-paths'
import type { AuthoredWorkKind } from './ipc/design'
import {
  DEFAULT_WORK_ROOTS,
  normalizeWorkRoot,
  workRootForKind,
  type WorkRoots
} from './design/work-roots'

/**
 * The scratch folder every workspace CodeInOven stages agent work in. It is the
 * folder CIO Cleanup sweeps, and the one the agent behavior prompt routes every
 * harness's scratch, plan, report, and temporary file into.
 *
 * It lives here because both the project artifact paths (main) and the file
 * tree's context menu (renderer) need the same name, and this module is the
 * only CIO Cleanup module that is safe to bundle in the renderer: no Node
 * built-ins, no Electron, no Svelte state.
 */
export const CIO_SCRATCH_DIRECTORY = '.cio'

/** The `.cio` folder holding feature specs, plans, and assignment documents. */
export const CIO_CLEANUP_SPECS_FOLDER = 'specs'

/**
 * One `.cio` folder the settings page lists, with the sentence that explains it.
 *
 * The copy lives beside the ids so the sweep's vocabulary and the settings page
 * cannot drift: a category added here reaches the page, the config validation,
 * and the protection rule together.
 */
export interface CioCleanupCategoryDefinition {
  id: CioCleanupCategoryId
  label: string
  description: string
}

export const CIO_CLEANUP_CATEGORIES: readonly CioCleanupCategoryDefinition[] = [
  {
    id: 'scratch',
    label: 'Scratch',
    description: 'Temporary files, staged attachments, and probe output, in .cio/tmp.'
  },
  {
    id: 'work',
    label: 'Work artifacts',
    description: 'Plans, walkthroughs, and reports written while a task runs, in .cio/work.'
  },
  {
    id: 'specs',
    label: 'Feature specs',
    description: 'Spec, plan, and assignment documents for a feature, in .cio/specs.'
  },
  {
    id: 'git',
    label: 'Pull request reports',
    description: 'Per pull request reports and audits, in .cio/git.'
  },
  {
    id: 'designs',
    label: 'Designs',
    description: 'Authored design folders, wherever the design root points.'
  },
  {
    id: 'videos',
    label: 'Videos',
    description: 'Authored video folders, wherever the video root points.'
  },
  {
    id: 'utilities',
    label: 'Installed utilities',
    description: 'Skills and MCP servers installed for a project, in .cio/utilities.'
  }
]

/** Normalize a workspace-relative path to forward slashes without a leading `./`. */
export function normalizeCioCleanupPath(path: string): string {
  return path
    .replaceAll('\\', '/')
    .replace(/^\.\/+/u, '')
    .replace(/\/+$/u, '')
}

/**
 * The workspace-relative folders one category owns.
 *
 * Fixed names for the four scratch folders and the utilities install root; the
 * two authored categories follow the work-roots setting, and answer with both
 * the configured root and the shipped default, so work left behind by a root
 * that moved is still named here. A caller turns these into `.cio`-relative
 * paths with {@link cioScratchRelativePath}, which is also what drops a root the
 * user pointed outside `.cio`.
 */
export function cioCleanupCategoryPaths(
  category: CioCleanupCategoryId,
  workRoots: WorkRoots = DEFAULT_WORK_ROOTS
): string[] {
  switch (category) {
    case 'scratch':
      return [`${CIO_SCRATCH_DIRECTORY}/tmp`]
    case 'work':
      return [`${CIO_SCRATCH_DIRECTORY}/work`]
    case 'specs':
      return [`${CIO_SCRATCH_DIRECTORY}/${CIO_CLEANUP_SPECS_FOLDER}`]
    case 'git':
      return [`${CIO_SCRATCH_DIRECTORY}/git`]
    case 'utilities':
      return [`${CIO_SCRATCH_DIRECTORY}/${PROJECT_UTILITIES_DIRECTORY}`]
    case 'designs':
      return authoredWorkRootPaths('design', workRoots)
    case 'videos':
      return authoredWorkRootPaths('video', workRoots)
  }
}

/** One authored kind's configured root plus the shipped default, normalized and deduped. */
function authoredWorkRootPaths(kind: AuthoredWorkKind, workRoots: WorkRoots): string[] {
  const paths = new Set<string>()
  for (const roots of [workRoots, DEFAULT_WORK_ROOTS]) {
    const root = normalizeWorkRoot(workRootForKind(roots, kind))
    if (root) paths.add(root)
  }
  return [...paths]
}

/**
 * Every `.cio`-relative folder a sweep must keep, whatever its age.
 *
 * The categories the user excluded name them. A fresh install excludes designs,
 * videos, and installed utilities while the four scratch folders stay
 * sweepable, because deleting a design nobody opened for a month, or an
 * installed skill the registry still resolves, reclaims nothing and loses work.
 * Excluding a folder only keeps it: the sweeper never enters a protected folder,
 * so nothing inside is judged by its age either.
 */
export function cioCleanupProtectedPaths(
  workRoots: WorkRoots = DEFAULT_WORK_ROOTS,
  excludedCategories: readonly CioCleanupCategoryId[] = DEFAULT_CIO_CLEANUP_EXCLUDED_CATEGORIES
): readonly string[] {
  const paths = new Set<string>()
  for (const category of excludedCategories) {
    for (const folder of cioCleanupCategoryPaths(category, workRoots)) {
      const relative = cioScratchRelativePath(folder)
      // `''` is the `.cio` folder itself, and the sweep root is never a candidate.
      if (relative) paths.add(relative)
    }
  }
  return [...paths].sort()
}

/** Whether a `.cio`-relative path is content a sweep must keep. */
export function isCioCleanupProtectedPath(
  relativePath: string,
  protectedPaths: readonly string[]
): boolean {
  const normalized = normalizeCioCleanupPath(relativePath)
  return protectedPaths.some((protectedPath) => cioCleanupPathCovers(protectedPath, normalized))
}

/**
 * The `.cio`-relative path an exclusion would store for a workspace-relative
 * path, or null when the path is not inside the scratch folder. The scratch
 * folder itself returns `''` and is never excludable: excluding it would switch
 * cleanup off for that workspace behind the user's back.
 */
export function cioScratchRelativePath(workspaceRelativePath: string): string | null {
  const normalized = normalizeCioCleanupPath(workspaceRelativePath)
  if (normalized === CIO_SCRATCH_DIRECTORY) return ''
  const prefix = `${CIO_SCRATCH_DIRECTORY}/`
  if (!normalized.startsWith(prefix)) return null
  return normalized.slice(prefix.length)
}

/** Whether an exclusion path covers a `.cio`-relative path or one of its children. */
export function cioCleanupPathCovers(excludedPath: string, candidatePath: string): boolean {
  return candidatePath === excludedPath || candidatePath.startsWith(`${excludedPath}/`)
}

/**
 * Stable key of one workspace mount. A scope id alone is not enough because a
 * conversation's own workspace (`chats-cwd/<threadId>`, `assistant-cwd/<routine>`,
 * `browser-cwd/<threadId>`) is a separate scratch folder under the same project.
 */
export function cioCleanupMountKey(mount: CioCleanupMount): string {
  return `${mount.projectId}\u0000${mount.scopeBucketId}\u0000${mount.threadId ?? ''}`
}

/** Whether two mounts name the same scratch folder. */
export function cioCleanupMountsMatch(left: CioCleanupMount, right: CioCleanupMount): boolean {
  return cioCleanupMountKey(left) === cioCleanupMountKey(right)
}

/**
 * The exclusion that covers a `.cio`-relative path, preferring the exact match
 * over an ancestor. Toggling "Include in CIO Cleanup" removes this entry, so the
 * control always undoes the exclusion the user can see.
 */
export function findCioCleanupExclusion(
  exclusions: readonly CioCleanupExclusion[],
  mount: CioCleanupMount,
  relativePath: string
): CioCleanupExclusion | null {
  const normalized = normalizeCioCleanupPath(relativePath)
  let ancestor: CioCleanupExclusion | null = null
  for (const exclusion of exclusions) {
    if (!cioCleanupMountsMatch(exclusion, mount)) continue
    if (exclusion.path === normalized) return exclusion
    if (!ancestor && cioCleanupPathCovers(exclusion.path, normalized)) ancestor = exclusion
  }
  return ancestor
}

/** Whether a `.cio`-relative path is protected from a sweep. */
export function isCioCleanupExcluded(
  exclusions: readonly CioCleanupExclusion[],
  mount: CioCleanupMount,
  relativePath: string
): boolean {
  return findCioCleanupExclusion(exclusions, mount, relativePath) !== null
}
