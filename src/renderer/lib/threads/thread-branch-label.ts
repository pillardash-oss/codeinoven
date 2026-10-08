/** Characters of a branch name a compact thread row shows before it truncates. */
const ROW_BRANCH_CHARS = 4

/**
 * The branch as a compact row shows it: at most four characters, with an
 * ellipsis when the name continues.
 *
 * A row only has to say which branch line the thread is on; the full name lives
 * in the row's own tooltip and on the hover card, both of which the user can
 * reach without leaving the list.
 */
export function threadBranchRowLabel(branch: string): string {
  const trimmed = branch.trim()
  return trimmed.length > ROW_BRANCH_CHARS ? `${trimmed.slice(0, ROW_BRANCH_CHARS)}…` : trimmed
}
