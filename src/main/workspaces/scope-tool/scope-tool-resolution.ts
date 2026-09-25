/**
 * Resolution of a scope reference (bucket id or display name) against a project
 * board. Pure functions over the board so the service keeps no lookup state.
 */

import { DEFAULT_SCOPE_BUCKET_ID } from '../../../lib/types'
import type { ScopeBoard, ScopeBucket } from '../../../lib/types'

export function requireScopeBucket(board: ScopeBoard, bucketId: string): ScopeBucket {
  const bucket = board.buckets.find((candidate) => candidate.id === bucketId)
  if (!bucket) throw new Error(`Scope no longer exists: ${bucketId}`)
  return bucket
}

/** Resolve `scope` by bucket id or display name, defaulting to the caller's scope. */
export function resolveScopeBucket(
  board: ScopeBoard,
  reference: string | undefined,
  scopeBucketId: string
): ScopeBucket {
  if (reference === undefined) {
    const active =
      board.buckets.find((candidate) => candidate.id === scopeBucketId) ??
      board.buckets.find((candidate) => candidate.id === DEFAULT_SCOPE_BUCKET_ID)
    if (!active) throw new Error('The project has no scope to act on')
    return active
  }
  const trimmed = reference.trim()
  const byId = board.buckets.find((candidate) => candidate.id === trimmed)
  if (byId) return byId
  const lowered = trimmed.toLowerCase()
  const named = board.buckets.filter((candidate) => candidate.name.trim().toLowerCase() === lowered)
  if (named.length === 1) return named[0]
  if (named.length > 1) {
    throw new Error(
      `Multiple scopes are named “${trimmed}”. Pass the scope id instead: ${named
        .map((candidate) => candidate.id)
        .join(', ')}`
    )
  }
  throw new Error(
    `No scope matches “${trimmed}”. Available scopes: ${board.buckets
      .map((candidate) => `${candidate.name} (${candidate.id})`)
      .join(', ')}`
  )
}

export function resolveCustomScopeBucket(
  board: ScopeBoard,
  reference: string | undefined,
  scopeBucketId: string,
  verb: string
): ScopeBucket {
  const bucket = resolveScopeBucket(board, reference, scopeBucketId)
  if (bucket.id === DEFAULT_SCOPE_BUCKET_ID) {
    throw new Error(
      `The Default scope cannot be ${verb}: it always uses the project directory and has no worktree.`
    )
  }
  return bucket
}
