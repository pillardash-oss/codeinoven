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

/** A separator that splits a scope name into a head and a tail: the punctuation
 *  a scope name tends to be built with, and a spaced hyphen. */
const SCOPE_SEPARATOR = /\s*[:\u2013\u2014\u00b7|]\s*|\s+-\s+/

/**
 * The short form of a scope name for a cramped surface.
 *
 * A row's scope chip is one of the narrowest places a scope name is drawn, and
 * cutting it at a fixed width truncates it mid-word: the real name
 * `Achievement: Admin Dashboard Requirements for User Roles, Content Management,
 * Events, and Communities` came out as `Achievement: Admin Dashboard Requi…`,
 * which spends the chip's whole width on the part every scope with that prefix
 * shares and leaves the row's project name with none.
 *
 * So the cut happens at the name's own punctuation instead: the head segment is
 * kept whole, together with the first word of the tail, and the rest is dropped.
 * The same name becomes `Achievement: Admin…`, which is both shorter than the
 * fixed-width cut and still says which of several `Achievement:` scopes it is.
 * A name with no separator has no boundary to cut at, so it is returned
 * untouched and any remaining overflow stays with the chip's own ellipsis.
 */
export function abbreviatedScopeName(name: string): string {
  const trimmed = name.trim()
  const separator = SCOPE_SEPARATOR.exec(trimmed)
  if (!separator) return trimmed
  const head = trimmed.slice(0, separator.index + separator[0].length)
  const tail = trimmed.slice(head.length).trim()
  const [firstWord, ...rest] = tail.split(/\s+/)
  // One word after the head is the whole tail: nothing would be dropped, so the
  // name is already as short as this rule can make it.
  if (!firstWord || rest.length === 0) return trimmed
  return `${head}${firstWord}\u2026`
}
