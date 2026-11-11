import type { Thread } from '$shared/types'
import { STAGE_ORDER, type ThreadStage } from '$lib/stores/scope-board'

/**
 * The order a relocation destination list is shown in: the project view's own
 * order, so a chat sits where the sidebar already puts it.
 *
 * The picker used to draw the raw database order (pinned, then the manual
 * arrange anchor or last activity), which is not the order the sidebar shows and
 * has two consequences the user sees:
 *
 * 1. a chat holding unsent composer text is staged into the Todo slice, so the
 *    sidebar lifts it to the top of its scope while the database order buried it
 *    where its old activity left it;
 * 2. a project holds more chats than a palette row list can draw at once, and the
 *    raw order put the chats the user came back to days later at the very end,
 *    below everything that had been active since.
 *
 * Walking the board's scopes and their slices is the same walk the sidebar
 * makes, so a destination the user can see there can be found here in the same
 * place.
 *
 * The one thing the sidebar cannot answer is which scope goes first. It draws a
 * single scope at a time, and a picker is one flat list, so ranking the scopes
 * by the board's own order handed the top of the picker to whichever scope
 * merely sorts first: a project whose recent work lives in a later scope opened
 * the picker on last week's threads while the sidebar was showing today's. The
 * scope on screen therefore ranks before every other scope, and only then does
 * the board's order decide.
 */

/** The sidebar slice a destination sits in. */
export interface RelocationDestinationSlice {
  bucketId: string
  stage: ThreadStage
}

export interface RelocationDestinationOrdering {
  /** The project's scopes, in the order the sidebar lists them. */
  buckets: readonly { id: string }[]
  /** Where the sidebar stages the thread: its scope, and its slice. */
  sliceFor: (thread: Thread) => RelocationDestinationSlice
  /**
   * The scope the sidebar is showing, which leads the list.
   *
   * Null when no scope describes this project, in which case the board's own
   * order leads, exactly as it used to.
   */
  currentBucketId?: string | null
}

const STAGE_RANK = new Map<string, number>(STAGE_ORDER.map((stage, index) => [stage, index]))

/** A slice the sidebar does not name sorts after every slice it does. */
const UNRANKED_STAGE = STAGE_ORDER.length

/** A slice's own position for the pin-time order, which is the first one. */
const PINNED_STAGE = STAGE_RANK.get('pinned') ?? 0

export function orderRelocationDestinations(
  threads: readonly Thread[],
  ordering: RelocationDestinationOrdering
): Thread[] {
  const bucketRank = new Map(ordering.buckets.map((bucket, index) => [bucket.id, index]))
  // A thread whose scope the loaded board does not hold is still a destination:
  // it sorts after the scopes the sidebar can name rather than disappearing.
  const unrankedBucket = ordering.buckets.length
  const currentBucketId = ordering.currentBucketId ?? null
  return threads
    .map((thread) => {
      const slice = ordering.sliceFor(thread)
      return {
        thread,
        // Two tiers: the scope on screen, then every other scope in the
        // board's order.
        scopeTier: currentBucketId !== null && slice.bucketId === currentBucketId ? 0 : 1,
        bucket: bucketRank.get(slice.bucketId) ?? unrankedBucket,
        stage: STAGE_RANK.get(slice.stage) ?? UNRANKED_STAGE,
        pinnedAt: thread.pinnedAt ?? -1,
        scopeOrder: thread.scopeSortOrder ?? Number.MAX_SAFE_INTEGER,
        lastActivity: thread.lastActivity
      }
    })
    .sort((a, b) => {
      if (a.scopeTier !== b.scopeTier) return a.scopeTier - b.scopeTier
      if (a.bucket !== b.bucket) return a.bucket - b.bucket
      if (a.stage !== b.stage) return a.stage - b.stage
      if (a.stage === PINNED_STAGE) {
        // Pinned chats share one pin-time order across every surface.
        if (a.pinnedAt !== b.pinnedAt) return b.pinnedAt - a.pinnedAt
      } else if (a.scopeOrder !== b.scopeOrder) {
        // The user's manual arrange order inside the slice wins over recency.
        return a.scopeOrder - b.scopeOrder
      }
      if (a.lastActivity !== b.lastActivity) return b.lastActivity - a.lastActivity
      return a.thread.id.localeCompare(b.thread.id)
    })
    .map((entry) => entry.thread)
}
