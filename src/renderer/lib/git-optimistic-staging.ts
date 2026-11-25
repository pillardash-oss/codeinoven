import type { GitFileChange } from '$shared/types'

/**
 * What the reader asked for, before git has been asked.
 *
 * Staging is a round trip: the panel sends the paths, git rewrites the index,
 * and the new status comes back. Waiting for that before moving a row is what
 * makes a toggle feel like it took a second, so the intended state is painted
 * first and this overlay is what paints it.
 */
export interface StageIntent {
  /** Where the file should end up: in the index, or out of it. */
  staged: boolean
  /**
   * The request that owns this intent.
   *
   * Two quick toggles on one path race, and only the newer request may settle
   * the overlay: the older answer describes a state the reader has already
   * moved past.
   */
  request: number
}

/** One path's intent, keyed by path. */
export type StageIntents = Readonly<Record<string, StageIntent>>

/**
 * Apply the pending stage intents to the status git last reported.
 *
 * Git lists a half-staged file twice: once in the index, once in the working
 * tree (`MM`). Staging it therefore does not flip a row, it collapses two into
 * one, and unstaging it splits one into two. Painting only the flag would leave
 * a copy of the file in both sections and the count wrong, so the overlay
 * resolves the pair the way git will.
 *
 * A file's status word moves with it: staging an untracked file is what makes it
 * added, and unstaging a new file is what makes it untracked again.
 *
 * Everything without an intent is returned untouched, in the order git listed
 * it, so a row never jumps because of a stage that has nothing to do with it.
 */
export function applyStageIntents(
  changes: readonly GitFileChange[],
  intents: StageIntents
): GitFileChange[] {
  if (Object.keys(intents).length === 0) return [...changes]

  const byPath = new Map<string, GitFileChange[]>()
  for (const change of changes) {
    if (!intents[change.path]) continue
    const entries = byPath.get(change.path) ?? []
    entries.push(change)
    byPath.set(change.path, entries)
  }

  const staged = (change: GitFileChange): GitFileChange => ({
    ...change,
    staged: true,
    status: change.status === 'untracked' ? 'added' : change.status
  })

  const unstaged = (change: GitFileChange): GitFileChange => ({
    ...change,
    staged: false,
    status: change.status === 'added' ? 'untracked' : change.status
  })

  const result: GitFileChange[] = []
  const emitted = new Set<string>()
  for (const change of changes) {
    const intent = intents[change.path]
    if (!intent) {
      result.push(change)
      continue
    }
    // Every entry for one path is resolved on the first of them, so the pair
    // collapses (or splits) in place instead of twice.
    if (emitted.has(change.path)) continue
    emitted.add(change.path)
    const entries = byPath.get(change.path) ?? [change]
    if (intent.staged) {
      const already = entries.filter((entry) => entry.staged)
      if (already.length > 0) result.push(...already)
      else result.push(staged(entries[0] as GitFileChange))
      continue
    }
    const out = entries.filter((entry) => !entry.staged)
    if (out.length > 0) result.push(...out)
    else result.push(unstaged(entries[0] as GitFileChange))
  }
  return result
}
