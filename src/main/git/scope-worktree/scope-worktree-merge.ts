import type { ManagedWorktreeDescriptor, ScopeMergeOutcome, ScopeTarget } from '../../../lib/types'
import { getScopeRootPath } from '../../../lib/utils'
import type { ScopeManager } from '../../../lib/engines/scope-manager'
import { runGit, runGitChecked } from '../scope-worktree-process'
import { removeWorktreeCheckout, unmergedFiles } from './scope-worktree-git'

/** Run `git merge <sourceBranch>` in `root`; reports conflicts without failing. */
export async function runIntoMerge(root: string, sourceBranch: string): Promise<ScopeMergeOutcome> {
  try {
    await runGitChecked(['merge', sourceBranch], { cwd: root, timeoutMs: 120_000 })
  } catch (cause) {
    const conflicting = await unmergedFiles(root)
    if (conflicting.length > 0) {
      return { merged: false, conflicted: conflicting }
    }
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`The merge into the target scope could not start: ${detail}`, { cause })
  }
  return { merged: true, conflicted: [] }
}

/**
 * Remove the managed checkout behind a scope, for the destructive lifecycle
 * actions that are meant to end with nothing on disk: delete-scope, and the
 * delete modes of a scope merge. The removal is guaranteed to leave no
 * directory behind, and a removal that cannot complete **throws** so its caller
 * never drops the scope record for a checkout that still exists.
 */
export async function removeManagedWorktree(
  target: ScopeTarget,
  descriptor: ManagedWorktreeDescriptor,
  repoPath: string
): Promise<void> {
  await removeWorktreeCheckout({
    repoPath,
    worktreePath: getScopeRootPath(target.projectId, descriptor.directoryName),
    force: true
  })
}

/**
 * Resolve the filesystem root and current branch of the merge target scope.
 * The Default scope (and any project-rooted scope) resolves to the project
 * directory; a managed scope resolves to its worktree checkout.
 */
export async function resolveMergeTargetRoot(
  scopes: ScopeManager,
  mergeTarget: ScopeTarget,
  repoPath: string | undefined
): Promise<{ root: string; branch: string }> {
  const board = scopes.getBoard(mergeTarget.projectId)
  const bucket = board.buckets.find((candidate) => candidate.id === mergeTarget.scopeBucketId)
  if (!bucket) throw new Error(`Merge target scope not found: ${mergeTarget.scopeBucketId}`)
  if (bucket.root.kind === 'worktree') {
    const root = getScopeRootPath(mergeTarget.projectId, bucket.root.directoryName)
    let branch = bucket.root.branch
    try {
      const resolved = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root })).trim()
      if (resolved && resolved !== 'HEAD') branch = resolved
    } catch {
      // Fall back to the descriptor's branch.
    }
    return { root, branch }
  }
  if (!repoPath) throw new Error('The merge target requires a local project repository')
  let branch = 'HEAD'
  try {
    const resolved = (
      await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: repoPath
      })
    ).trim()
    if (resolved && resolved !== 'HEAD') branch = resolved
  } catch {
    // Unborn/empty repository; the merge will surface a concrete error.
  }
  return { root: repoPath, branch }
}

/** A scope cannot be merged into itself. */
export function assertDistinctMergeTarget(target: ScopeTarget, mergeTarget: ScopeTarget): void {
  if (
    target.projectId === mergeTarget.projectId &&
    target.scopeBucketId === mergeTarget.scopeBucketId
  ) {
    throw new Error('The merge target must be a different scope than the source')
  }
}
