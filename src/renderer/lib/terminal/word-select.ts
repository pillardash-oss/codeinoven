import type { GhosttyCell, Terminal } from 'ghostty-web'

/**
 * Right-click word selection for the ghostty-web terminal.
 *
 * The terminal draws its selection on canvas, so a plain right-click on text
 * gives the native context menu nothing to copy. Native terminal emulators
 * handle this by selecting the word under the cursor on right-click; this
 * module reproduces that: it hit-tests the click against the grid, expands to
 * the surrounding whitespace-delimited run, and installs it as the terminal's
 * selection so `term.getSelection()` (the wrap-aware copy path) picks it up.
 *
 * Rows are addressed relative to the viewport: `term.select(col, screenRow,
 * length)` resolves absolute rows itself, including rows scrolled into view
 * from scrollback.
 */

interface GridCell {
  col: number
  screenRow: number
}

/** Hit-test a mouse point against the terminal grid (0-based col and row). */
function cellFromClient(
  term: Terminal,
  host: HTMLElement,
  clientX: number,
  clientY: number
): GridCell | null {
  const canvas = host.querySelector('canvas')
  if (!canvas) return null
  const rect = canvas.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  const col = Math.floor(((clientX - rect.left) / rect.width) * term.cols)
  const screenRow = Math.floor(((clientY - rect.top) / rect.height) * term.rows)
  if (col < 0 || screenRow < 0 || col >= term.cols || screenRow >= term.rows) return null
  return { col, screenRow }
}

/** A cell that belongs to a word: non-blank ink (graphemes count as ink). */
function isWordCell(cell: GhosttyCell | undefined): boolean {
  if (!cell) return false
  if (cell.codepoint === 0 && cell.grapheme_len === 0) return false
  return cell.codepoint === 0 || String.fromCodePoint(cell.codepoint).trim() !== ''
}

/** The absolute-buffer row shown at `screenRow` of the current viewport. */
function lineForViewportRow(
  term: Terminal,
  screenRow: number
): { cells: GhosttyCell[] | null; absoluteRow: number } {
  const absoluteRow = term.viewportY + screenRow
  const scrollbackLength = term.getScrollbackLength()
  const cells =
    absoluteRow < scrollbackLength
      ? term.getScrollbackLine(absoluteRow)
      : (term.wasmTerm?.getLine(absoluteRow - scrollbackLength) ?? null)
  return { cells, absoluteRow }
}

/**
 * Select the word under the right-click point and return the selected text.
 * Returns an empty string (leaving any prior selection untouched) when the
 * click misses the grid or lands on blank space.
 */
export function selectWordAt(
  term: Terminal,
  host: HTMLElement,
  clientX: number,
  clientY: number
): string {
  const cell = cellFromClient(term, host, clientX, clientY)
  if (!cell) return ''
  const { cells } = lineForViewportRow(term, cell.screenRow)
  if (!cells || !isWordCell(cells[cell.col])) return ''

  let start = cell.col
  let end = cell.col
  while (start > 0 && isWordCell(cells[start - 1])) start -= 1
  while (end < cells.length - 1 && isWordCell(cells[end + 1])) end += 1

  term.select(start, cell.screenRow, end - start + 1)
  return term.getSelection()
}
