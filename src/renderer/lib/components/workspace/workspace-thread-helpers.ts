import { isThreadLiveWorking } from '$lib/thread-status-badge'
import { scopeState } from '$lib/stores/scope.svelte'
import { settledThreadReadsUnread, threadStatusPolicy } from '$shared/thread-status-policy'
import {
  GLOBAL_BROWSER_PROJECT_ID,
  isConversationContainer,
  type Thread,
  type ThreadSearchResult
} from '$shared/types'
import {
  coordinatorHasActiveDelegates,
  coordinatorHasUnreadWorkers,
  isOrchestrationChildThread
} from '$shared/types'
import type { ThreadGroup } from '$lib/stores/thread-grouping.svelte'
import { temporaryChatUnread } from '$lib/stores/temporary-chat-unread.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { threadVisitKey } from '$lib/stores/recent-visits.svelte'

/**
 * Partition the already-filtered rows once, preserving their order within each group.
 *
 * `Drafts` holds the two threads the user still has to finish writing: one that
 * nothing has been sent into yet, and one whose run is over while its composer
 * holds unsent typing. A thread whose run is live is not a draft   that typing
 * rides the row's secondary slot while the run keeps the row   so it stays under
 * Working. Errors, Attention, and Spec keep their precedence above the draft
 * section, matching the row badge, which shows a parked or failed state over the
 * pen.
 *
 * Two key sets, because there are two questions. `draftThreadKeys` is everything
 * waiting in the composer, unsent typing plus messages already sent and queued
 * behind a turn: that is what pins a row to the top of its list, and it keeps a
 * running thread under Working even for a caller that hands over no more than it.
 * `typingThreadKeys` is only the unfinished writing, and only that earns the
 * Drafts section   a queued message is a finished action waiting its turn, not a
 * thread the user has to come back to. Both sets come from the workspace; asking
 * the recovery store about every thread instead would materialize an empty draft
 * entry per row on each keystroke.
 */
export function groupThreadsByStatus(
  threads: Thread[],
  draftThreadKeys?: ReadonlySet<string> | null,
  typingThreadKeys?: ReadonlySet<string> | null
): { label: ThreadGroup; threads: Thread[] }[] {
  // The literal's order is the display order: the rows below return
  // `Object.keys` of this record, so a group added here is a group drawn where
  // it is written. Drafts sits above Unread   unfinished writing of the user's
  // own asks for them the way an unopened result does, and it is theirs to
  // finish rather than theirs to read. Attention still leads both, because a gate
  // on the user stops every other thing.
  const groups: Record<ThreadGroup, Thread[]> = {
    Attention: [],
    Drafts: [],
    Unread: [],
    Errors: [],
    Spec: [],
    Working: [],
    Done: []
  }
  for (const thread of threads) {
    let group: ThreadGroup
    // A failure is an Error whether or not the user has opened it, exactly as
    // the row's own mark reports it: unread is reserved for a completed run
    // nobody has opened (see `settledThreadReadsUnread`).
    if (thread.status === 'failed') group = 'Errors'
    else if (thread.status === 'awaiting_approval') group = 'Attention'
    else if (thread.status === 'spec') group = 'Spec'
    else if (isDraftSectionThread(thread, typingThreadKeys)) group = 'Drafts'
    else if (
      threadHasVisibleWork(thread) ||
      thread.status === 'working-paused' ||
      thread.status === 'created' ||
      (draftThreadKeys?.has(threadVisitKey(thread)) ?? false) ||
      rendererRecovery.queuedMessageCount(thread.projectId, thread.id) > 0 ||
      rendererRecovery.hasStartAfterPending(thread.projectId, thread.id)
    )
      group = 'Working'
    else if (
      (!isOrchestrationChildThread(thread) &&
        (settledThreadReadsUnread(thread, thread.read) ||
          coordinatorHasUnreadWorkers(thread, scopeState.allScopeThreads))) ||
      temporaryChatUnread.hasUnread(thread.projectId, thread.id)
    )
      group = 'Unread'
    else group = 'Done'
    groups[group].push(thread)
  }
  return (Object.keys(groups) as ThreadGroup[])
    .filter((label) => groups[label].length > 0)
    .map((label) => ({ label, threads: groups[label] }))
}

/**
 * Whether the thread belongs in the sidebar's Drafts section: a thread nothing
 * has been sent into yet, or a run that is over while the user writes its next
 * message.
 *
 * `created` is the new thread   the one the user just made and has not written
 * a first message into. Nothing else counts as new: the moment a turn starts the
 * thread is doing something, and the section is for what is waiting on the user
 * alone. The second case reads the settled statuses (`completed`, `interrupted`)
 * rather than a run flag, so a finished thread the user is typing into is a draft
 * however long ago it settled, and a thread that is merely between turns of a live
 * run is not.
 */
function isDraftSectionThread(
  thread: Thread,
  typingThreadKeys?: ReadonlySet<string> | null
): boolean {
  if (thread.status === 'created') return true
  if (threadStatusPolicy(thread.status).scopeSlice !== 'done') return false
  return typingThreadKeys?.has(threadVisitKey(thread)) ?? false
}

/** Threads matching the view's search query. */
export function filterThreadsByQuery(threads: Thread[], query: string): Thread[] {
  const q = query.trim().toLowerCase()
  if (!q) return threads
  return threads.filter((t) => t.title.toLowerCase().includes(q))
}

/**
 * Whether a thread belongs to the family the Threads view lists: a real project's
 * thread, never the inbox chats, an assistant's tasks, or the hidden browser
 * container that share the same threads table. The row's container is what
 * decides this, so a search result can be checked before it is ever rendered in
 * a view that does not own it.
 */
export function isProjectFamilyThread(projectId: string): boolean {
  return !isConversationContainer(projectId) && projectId !== GLOBAL_BROWSER_PROJECT_ID
}

/**
 * Narrow search results to the projects a view is currently showing.
 *
 * The predicate is passed in rather than read here so the view owns its filter:
 * the Threads view hands in its persisted project filter, and a view with no
 * filter hands in an always-true one. Applied where the rows are rendered, so a
 * filter change re-filters what is already on screen instead of waiting for
 * another query.
 */
export function filterSearchResultsByProject(
  results: readonly ThreadSearchResult[],
  matchesProject: (projectId: string) => boolean
): ThreadSearchResult[] {
  return results.filter((result) => matchesProject(result.thread.projectId))
}

/**
 * Fold several per-project search batches into one ranked list.
 *
 * A search run with a project filter fans out one query per selected project so
 * every filtered project is asked on its own terms, rather than hoping its
 * matches survive a single cross-project result cap. Each batch arrives already
 * ranked for its own project by the one search ranking, so a batch is never
 * re-ordered here: batches are placed by the quality of their best hit (a batch
 * led by a title match comes before a message-only one, recency breaking the
 * tie) and each batch keeps its own order inside that placement. A single batch
 * therefore comes back exactly as the search returned it. Threads are deduped by
 * id, and the merged list is capped so a wide filter can never hand the sidebar
 * more rows than one unfiltered search would.
 */
export function mergeThreadSearchBatches(
  batches: readonly (readonly ThreadSearchResult[])[],
  limit: number
): ThreadSearchResult[] {
  const ranked = batches
    .map((batch) => ({ batch, head: batch[0] }))
    .filter(
      (entry): entry is { batch: readonly ThreadSearchResult[]; head: ThreadSearchResult } =>
        entry.head !== undefined
    )
    .sort((left, right) => {
      const leftTitle = left.head.kind === 'title' ? 0 : 1
      const rightTitle = right.head.kind === 'title' ? 0 : 1
      if (leftTitle !== rightTitle) return leftTitle - rightTitle
      return right.head.thread.lastActivity - left.head.thread.lastActivity
    })
  const merged: ThreadSearchResult[] = []
  const seen = new Set<string>()
  for (const { batch } of ranked) {
    for (const result of batch) {
      if (seen.has(result.thread.id)) continue
      seen.add(result.thread.id)
      merged.push(result)
      if (merged.length === limit) return merged
    }
  }
  return merged
}

/**
 * Whether the thread has work to show in the header's activity stat. It reads
 * the one live-working rule, so a thread parked on the user (a question,
 * permission, or secret card) reports as waiting for the user rather than as
 * work in progress.
 */
export function threadHasVisibleWork(thread: Thread): boolean {
  return (
    isThreadLiveWorking(thread) || coordinatorHasActiveDelegates(thread, scopeState.allScopeThreads)
  )
}
