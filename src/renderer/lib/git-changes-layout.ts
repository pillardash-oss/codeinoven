/**
 * How the Changes column splits its height between the sections it shows.
 *
 * The rule the column follows is not "every section gets a share": a section with
 * three files does not need a quarter of the panel, and padding it out to its
 * share is what leaves a hole under the last row while a long section is clipped
 * behind a scrollbar. It is water filling: every section asks for what it
 * actually holds, and whatever is left over is split equally between the sections
 * that still want more. A short section therefore hugs its content, and a long
 * one grows into everything the short ones did not use, only falling back to a
 * scrollbar when every section is full and the column itself is the limit.
 *
 * The result is deterministic for a given set of natural heights, which is why it
 * lives here as a plain function: the view measures, this decides.
 */

/**
 * The height each section should take.
 *
 * @param available The column's usable height, gaps and padding already removed.
 * @param natural The height each section would take if nothing limited it.
 * @returns One height per section, in the same order, summing to at most
 *   `available` and never exceeding the matching natural height.
 */
export function waterFillHeights(available: number, natural: readonly number[]): number[] {
  const count = natural.length
  const heights = new Array<number>(count).fill(0)
  if (count === 0 || available <= 0) return heights

  let remaining = available
  const open: number[] = []
  for (let index = 0; index < count; index += 1) open.push(index)

  while (open.length > 0) {
    const fairShare = remaining / open.length
    const small = open.filter((index) => (natural[index] ?? 0) <= fairShare)
    if (small.length === 0) {
      // Everyone still open wants more than an equal share of what is left, so
      // an equal share is exactly what is fair.
      for (const index of open) heights[index] = fairShare
      break
    }
    // The sections that fit take what they asked for and leave the dividers
    // first, so closing ranks on an empty section never shrinks the others.
    for (let cursor = small.length - 1; cursor >= 0; cursor -= 1) {
      const index = small[cursor]
      if (index === undefined) continue
      heights[index] = natural[index] ?? 0
      remaining -= heights[index]
      open.splice(open.indexOf(index), 1)
    }
  }

  return heights
}
