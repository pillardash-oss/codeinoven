import hljs from 'highlight.js/lib/common'

/** Highlighting beyond this budget is skipped; the tail renders as escaped text. */
const HIGHLIGHT_BUDGET = 32 * 1024

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Highlight known languages without blocking on unbounded code blocks. */
export function highlightCode(code: string, lang?: string): string {
  if (lang && hljs.getLanguage(lang)) {
    const budgeted = code.length > HIGHLIGHT_BUDGET ? code.slice(0, HIGHLIGHT_BUDGET) : code
    try {
      const highlighted = hljs.highlight(budgeted, { language: lang, ignoreIllegals: true }).value
      if (budgeted.length < code.length) {
        return highlighted + escapeHtml(code.slice(HIGHLIGHT_BUDGET))
      }
      return highlighted
    } catch {
      // A grammar failure falls back to safe plain text.
    }
  }
  return escapeHtml(code)
}
