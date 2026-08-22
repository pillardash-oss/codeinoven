/**
 * Wrap-aware text extraction for ghostty-web terminal selection.
 *
 * ghostty-web's SelectionManager builds copied text by joining every selected
 * row with a literal newline. That corrupts soft-wrapped lines: a long line
 * (a base64 value, a long command, a huge URL) that the terminal wrapped across
 * several visual rows is really ONE logical line, so pasting it back contains
 * bogus line breaks that break the value.
 *
 * This overrides `SelectionManager.prototype.getSelection` — the single method
 * behind mouse-up, double/triple-click, and context-menu copy — so a newline is
 * only emitted between rows that are not soft-wrap continuations of each other.
 * `GhosttyTerminal.isRowWrapped` reports whether a screen row continues the row
 * above it. Scrollback rows expose no wrap metadata in the WASM binding, so they
 * keep the library's join-with-newline behavior (matching the buffer's own
 * `getLine`, which also treats scrollback rows as unwrapped).
 */

import { invoke } from '$lib/ipc.svelte'
import { SelectionManager, type GhosttyTerminal } from 'ghostty-web'

interface SelectionCoordinate {
  col: number
  absoluteRow: number
}

/** Private SelectionManager state the override needs to read. */
interface SelectionManagerInternals {
  selectionStart: SelectionCoordinate | null
  selectionEnd: SelectionCoordinate | null
  wasmTerm: GhosttyTerminal
}

let patched = false

/** Install the wrap-aware selection text extraction once. Idempotent. */
export function patchSelectionCopy(): void {
  if (patched) return
  patched = true

  // Prefer the Electron clipboard (always available in this app) over the
  // browser's `execCommand("copy")` fallback, which logs `❌ execCommand
  // copy failed` noise in the console and is deprecated.
  const originalCopy = (
    SelectionManager.prototype as unknown as {
      copyToClipboard: (text: string) => Promise<void>
    }
  ).copyToClipboard
  ;(SelectionManager.prototype as unknown as { copyToClipboard: (text: string) => Promise<void> }).copyToClipboard =
    async function (this: SelectionManager, text: string): Promise<void> {
      // Try Electron IPC first — works even when the terminal isn't focused.
      try {
        await invoke('clipboard:writeText', text)
        return
      } catch {
        // Fall through to the browser / execCommand path.
      }
      try {
        await originalCopy.call(this, text)
      } catch {
        // Both paths failed — swallow the ghostty-web `console.error` noise.
        // The selection itself is still valid; manual copy remains possible.
      }
    }

  SelectionManager.prototype.getSelection = function (this: SelectionManager): string {
    const { selectionStart, selectionEnd, wasmTerm } = this as unknown as SelectionManagerInternals
    if (!selectionStart || !selectionEnd) return ''

    let startCol = selectionStart.col
    let startAbsRow = selectionStart.absoluteRow
    let endCol = selectionEnd.col
    let endAbsRow = selectionEnd.absoluteRow

    if (startAbsRow > endAbsRow || (startAbsRow === endAbsRow && startCol > endCol)) {
      const swappedCol = startCol
      const swappedRow = startAbsRow
      startCol = endCol
      startAbsRow = endAbsRow
      endCol = swappedCol
      endAbsRow = swappedRow
    }

    const scrollbackLength = wasmTerm.getScrollbackLength()
    let text = ''

    for (let absRow = startAbsRow; absRow <= endAbsRow; absRow += 1) {
      const line =
        absRow < scrollbackLength
          ? wasmTerm.getScrollbackLine(absRow)
          : wasmTerm.getLine(absRow - scrollbackLength)
      if (!line) continue

      let lastNonEmpty = -1
      const colStart = absRow === startAbsRow ? startCol : 0
      const colEnd = absRow === endAbsRow ? endCol : line.length - 1

      let lineText = ''
      for (let col = colStart; col <= colEnd; col += 1) {
        const cell = line[col]
        if (cell && cell.codepoint !== 0) {
          let char: string
          if (cell.grapheme_len > 0) {
            char =
              absRow < scrollbackLength
                ? wasmTerm.getScrollbackGraphemeString(absRow, col)
                : wasmTerm.getGraphemeString(absRow - scrollbackLength, col)
          } else {
            char = String.fromCodePoint(cell.codepoint)
          }
          lineText += char
          if (char.trim()) lastNonEmpty = lineText.length
        } else {
          lineText += ' '
        }
      }

      text += lastNonEmpty >= 0 ? lineText.substring(0, lastNonEmpty) : ''

      // A soft-wrapped row continues onto the next row — joining them with a
      // newline would corrupt the copied value, so only hard line breaks get one.
      if (absRow < endAbsRow && !isSoftWrapContinuation(wasmTerm, absRow + 1, scrollbackLength)) {
        text += '\n'
      }
    }

    return text
  }
}

/**
 * Whether `absRow` continues the row above it (i.e. the previous row soft-wrapped).
 * Only screen rows expose wrap metadata; scrollback rows are treated as hard
 * line starts, matching the library's own buffer semantics.
 */
function isSoftWrapContinuation(
  wasmTerm: GhosttyTerminal,
  absRow: number,
  scrollbackLength: number
): boolean {
  if (absRow < scrollbackLength) return false
  return wasmTerm.isRowWrapped(absRow - scrollbackLength)
}
