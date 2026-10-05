import type { CioCleanupExclusion, CioCleanupMount } from './types/cio-cleanup'
import { PROJECT_UTILITIES_DIRECTORY } from './utility-scope-paths'

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

/**
 * `.cio` folders that hold installed content rather than scratch, so no sweep
 * may touch them.
 *
 * `.cio/utilities` is where a project's own scoped skills and MCP servers are
 * installed. A sweep that deleted it would leave the utility registry pointing
 * at an install that only comes back the next time that utility is written, so
 * the sweeper keeps the folder whole.
 */
export const CIO_CLEANUP_INSTALLED_PATHS: readonly string[] = [PROJECT_UTILITIES_DIRECTORY]

/** Normalize a workspace-relative path to forward slashes without a leading `./`. */
export function normalizeCioCleanupPath(path: string): string {
  return path
    .replaceAll('\\', '/')
    .replace(/^\.\/+/u, '')
    .replace(/\/+$/u, '')
}

/** Whether a `.cio`-relative path is installed content a sweep must keep. */
export function isCioCleanupInstalledPath(relativePath: string): boolean {
  const normalized = normalizeCioCleanupPath(relativePath)
  return CIO_CLEANUP_INSTALLED_PATHS.some(
    (installedPath) => normalized === installedPath || normalized.startsWith(`${installedPath}/`)
  )
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
