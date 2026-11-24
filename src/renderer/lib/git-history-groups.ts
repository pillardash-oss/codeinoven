import type { GitRemoteUpdate } from '$shared/types'
import type { GitGraphRemotePlacement, GitGraphRow } from './git-graph'

/**
 * How one batch of history reached the upstream.
 *
 * `unpushed` is the local-only run above the boundary: it never moved a ref, so
 * it has no movement of its own. `pushed` is a batch this checkout published,
 * `received` one this clone only learned about on a fetch, pull or clone, and a
 * `pushed` batch without an update is the fallback for a clone that kept no
 * reflog for the ref: the split with the upstream is still real, only its
 * moment is unknown.
 */
export type GitHistoryGroupKind = 'unpushed' | 'pushed' | 'received'

/** One commit of a group, with the row index it has in the whole history. */
export interface GitHistoryGroupEntry {
  /** Index into the full row list, which is what the placement maps key off. */
  index: number
  row: GitGraphRow
}

/** One batch of commits that share a moment with the upstream. */
export interface GitHistoryGroup {
  /** Stable identity for the keyed `each`. */
  key: string
  kind: GitHistoryGroupKind
  /** The movement that opened the batch, or null for the unpushed run and for
   *  a clone that recorded no reflog. */
  update: GitRemoteUpdate | null
  /** The ref the batch belongs to, when the panel knows one. */
  ref: string | null
  /** The batch's rows, newest first. */
  entries: GitHistoryGroupEntry[]
}

export interface GitHistoryGroupSource {
  /** The rows the graph assigned, newest first. */
  rows: readonly GitGraphRow[]
  /** Where the recorded ref movements landed on those rows. */
  placement: GitGraphRemotePlacement
  /** How many of the newest rows are not on the upstream. */
  unpushedCount: number
  /** The upstream ref name, for the group labels. */
  upstream: string | null
}

/**
 * Split the rows into the batches the upstream saw, newest first.
 *
 * The walk keeps one open group and only opens a new one when the story
 * changes: the local-only run starts the list, the boundary into the pushed
 * history always starts a batch, and every later recorded movement starts the
 * batch below it. Rows between two boundaries stay with the newer one, which is
 * exactly how the movement is stamped: a movement sits on the newest commit it
 * carried.
 *
 * A row whose boundary is missing is never dropped, and a group is never
 * invented for a commit that is not loaded: the grouping only re-shapes what the
 * graph already placed.
 */
export function gitHistoryGroups(source: GitHistoryGroupSource): GitHistoryGroup[] {
  const groups: GitHistoryGroup[] = []
  let current: GitHistoryGroup | null = null

  for (let index = 0; index < source.rows.length; index += 1) {
    const row = source.rows[index]
    if (!row) continue
    const boundary = source.placement.boundaries.get(index) ?? null
    const unpushed = index < source.unpushedCount

    if (unpushed) {
      if (current === null || current.kind !== 'unpushed') {
        current = {
          key: 'unpushed',
          kind: 'unpushed',
          update: null,
          ref: source.upstream,
          entries: []
        }
        groups.push(current)
      }
    } else if (current === null || current.kind === 'unpushed' || boundary !== null) {
      const kind: GitHistoryGroupKind =
        boundary === null ? 'pushed' : boundary.kind === 'push' ? 'pushed' : 'received'
      current = {
        // The opening row index is part of the key because the movement alone is
        // not unique: two pushes of the same ref in the same second carry the
        // same ref and the same `at`, and a repeated key throws while the keyed
        // each renders, which freezes the list instead of drawing it.
        key: boundary === null ? 'pushed' : `update:${String(index)}:${boundary.ref}`,
        kind,
        update: boundary,
        ref: boundary?.ref ?? source.upstream,
        entries: []
      }
      groups.push(current)
    }

    current.entries.push({ index, row })
  }

  return groups
}
