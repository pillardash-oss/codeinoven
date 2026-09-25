import { scopeState } from '$lib/stores/scope.svelte'
import { DEFAULT_SCOPE_BUCKET_ID, type ScopeBucket, type Thread } from '$shared/types'

/**
 * The scope a thread belongs to, or null when it sits in the project-rooted
 * Default scope (the absence of a scope) or when its project's board is not
 * cached yet.
 *
 * Every surface that shows a thread's scope resolves it here, so the sidebar
 * row, the hover card, and the thread search palette can never disagree about
 * which scope a thread is in. The function reads the reactive scope store, so
 * calling it inside `$derived` keeps the chip live when a board arrives.
 */
export function threadScopeBucket(thread: Thread): ScopeBucket | null {
  const bucketId = scopeState.bucketForThread(thread)
  if (bucketId === DEFAULT_SCOPE_BUCKET_ID) return null
  return scopeState.bucketFor(thread.projectId, bucketId)
}
