import type { ScopeBucket, ScopeTarget, Thread } from '$shared/types'
import { DEFAULT_SCOPE_BUCKET_ID } from '$shared/types'

/**
 * Central derivation of the active scope target. No filesystem paths are ever
 * resolved in the renderer; main owns root resolution through the scope.
 */
export function scopeTargetFor(
  projectId: string | null | undefined,
  bucketId: string
): ScopeTarget {
  return { projectId: projectId ?? '', scopeBucketId: bucketId }
}

/** Derive the target for a thread's own scope, falling back to Default. */
export function threadScopeTarget(
  thread: Pick<Thread, 'projectId' | 'scopeBucketId'>
): ScopeTarget {
  return {
    projectId: thread.projectId,
    scopeBucketId: thread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID
  }
}

/** Stable cache key for target-keyed renderer state (git, files, watchers). */
export function scopeTargetKey(target: ScopeTarget): string {
  return `${target.projectId}:${target.scopeBucketId}`
}

export function isProjectRooted(bucket: ScopeBucket): boolean {
  return bucket.root.kind === 'project'
}

/** Human-friendly label for the scope's working root. */
export function scopeRootLabel(bucket: ScopeBucket): string {
  if (bucket.root.kind === 'project') return 'Project root'
  return `Worktree on ${bucket.root.branch}`
}
