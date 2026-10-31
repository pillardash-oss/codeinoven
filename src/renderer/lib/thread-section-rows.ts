/**
 * The one row a folded thread section still shows: the thread the user is on.
 *
 * Folding a section hides its threads, and a folded section that owns the active
 * thread used to take that thread off screen with them. The section the user is
 * working in therefore stays temporarily open by exactly one row, so the active
 * thread is never out of view while its section keeps its fold state. Unfolding
 * the section reveals the rest of its threads as it always did.
 *
 * A section that does not hold the active thread reveals nothing, which is the
 * ordinary folded section.
 *
 * It lives on its own, with no imports, because every section in the sidebar
 * draws thread rows: a row list that pulled the sidebar's store graph in just to
 * decide what to mount would make each of them pay for it.
 */
export function foldedSectionRows<T extends { id: string }>(
  rows: readonly T[],
  activeId: string | null
): T[] {
  if (!activeId) return []
  const active = rows.find((row) => row.id === activeId)
  return active ? [active] : []
}
