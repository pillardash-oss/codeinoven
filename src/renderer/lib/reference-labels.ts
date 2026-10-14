/**
 * Reading the number a composer reference displays.
 *
 * The store numbers the labels of the references it holds by position
 * (`Mark 3`, `Design element 2`, `Selection 1`), and every surface that draws a
 * number for a reference must draw the same one: the badge a mark shows on a
 * screenshot, the badge an element pick shows on an artifact, and the block that
 * names it in the prompt are all read together by the agent. Deriving the number
 * from the label the composer shows keeps them in step through removals, which
 * renumber everything after them.
 */
export function referenceLabelNumber(label: string, position: number): number {
  const match = /(\d+)\s*$/u.exec(label)
  return match ? Number(match[1]) : position + 1
}
