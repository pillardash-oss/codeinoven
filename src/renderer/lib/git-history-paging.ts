import type { GitCommitInfo } from '$shared/types'

/** The commits a page contributes, and whether paging continues past it. */
export interface HistoryPageMerge {
  /** Everything already loaded plus what this page added, newest first. */
  commits: GitCommitInfo[]
  /** True while another page is expected below this one. */
  hasMore: boolean
}

/**
 * Append one page of `git log` to the history already on screen.
 *
 * Paging is an offset into a moving log. An agent that commits between two
 * pages shifts every commit below it by one, and two commits sharing a committer
 * second can come back in a different order on the next call, so a page can
 * repeat a hash the previous page already had. The history list is keyed by
 * commit hash, and a repeated key is not cosmetic there: the keyed each block
 * throws while it renders, the throw aborts the flush, and the panel stops
 * repainting until it is remounted. Filtering the overlap here is what keeps the
 * list keyable.
 *
 * A full page that adds nothing is the offset window repeating itself, because
 * the log moved under the skip. Asking again with the same offset would fetch
 * the same page forever, so that is where paging stops rather than spins.
 */
export function mergeHistoryPage(
  loaded: readonly GitCommitInfo[],
  page: readonly GitCommitInfo[],
  pageSize: number
): HistoryPageMerge {
  const known = new Set(loaded.map((commit) => commit.hash))
  const added = page.filter((commit) => !known.has(commit.hash))
  return {
    commits: added.length > 0 ? [...loaded, ...added] : [...loaded],
    hasMore: page.length === pageSize && added.length > 0
  }
}
