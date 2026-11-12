/**
 * The passage a search started right now should begin with.
 *
 * Every search opens from a chord or a button, and the reader may already have
 * highlighted the words they want to look for. The field then starts with that
 * passage instead of an empty box, in the conversation, in a file, in the tree
 * filter and in the spotlight screens alike.
 *
 * A query is matched against text, not against a layout, so the selection is
 * collapsed to single spaces: a passage that wrapped across three lines in the
 * document carries whitespace no match would ever find. A field's own selection
 * counts too, because `window.getSelection()` reports nothing for an input.
 *
 * The query is capped rather than left unbounded: a whole-document selection is
 * not a search term, and every screen behind a search pays for the length of the
 * query it is handed.
 */
const MAX_QUERY_LENGTH = 200

function normalizeSelection(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length > MAX_QUERY_LENGTH
    ? collapsed.slice(0, MAX_QUERY_LENGTH).trimEnd()
    : collapsed
}

/** The highlighted text on screen, including a form field's own selection. */
export function selectedSearchText(): string {
  const active = document.activeElement
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const start = active.selectionStart
    const end = active.selectionEnd
    if (start !== null && end !== null && end > start) {
      return normalizeSelection(active.value.slice(start, end))
    }
  }
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) return ''
  return normalizeSelection(selection.toString())
}
