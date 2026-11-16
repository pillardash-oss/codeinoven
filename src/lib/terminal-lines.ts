/**
 * Program output read the way a terminal draws it.
 *
 * A program that redraws one line, such as a download progress bar, separates its
 * redraws with a carriage return instead of a newline. Splitting such a stream on
 * both characters turns one progress bar into hundreds of near-identical lines,
 * so this folds a chunk back exactly like the screen does: `\n` finishes the line
 * being written, and `\r` sends the cursor back to where the line began, which
 * makes the text after it replace what the line already held.
 */

/** Output split into the lines it finished and the line still being written. */
export interface TerminalLines {
  /** Lines the chunk completed, in the order the terminal showed them. */
  lines: string[]
  /** The line still open after the chunk, possibly rewritten many times. */
  pending: string
}

/**
 * Fold one chunk of output into display lines.
 *
 * `pending` is the line left open by the previous chunk, so a redraw that lands
 * on a chunk boundary still replaces the right text. A redraw replaces the whole
 * line rather than overwriting it character for character: an engine that pads its
 * bar already reports the entire line, and a shorter redraw that kept the stale
 * tail would read as garbage.
 */
export function terminalLines(chunk: string, pending = ''): TerminalLines {
  const segments = chunk.split('\n')
  const open = segments.pop() ?? ''
  const lines: string[] = []
  for (const [index, segment] of segments.entries()) {
    lines.push(redrawLine(index === 0 ? pending : '', segment))
  }
  return { lines, pending: redrawLine(segments.length === 0 ? pending : '', open) }
}

/** One line of output, with every carriage return rewriting what came before it. */
function redrawLine(prefix: string, segment: string): string {
  if (!segment.includes('\r')) return prefix + segment
  const redraws = segment.split('\r')
  let line = prefix + redraws[0]
  // The final redraw is what the line ends up showing; an empty one clears it.
  for (const redraw of redraws.slice(1)) line = redraw
  return line
}
