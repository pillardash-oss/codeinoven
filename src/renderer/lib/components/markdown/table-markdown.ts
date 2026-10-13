/**
 * Serialize a rendered markdown table back into GitHub-flavored markdown.
 *
 * The copy control promises the table the reader is looking at, so the rendered
 * markup is the source of truth: sanitized table HTML in, markdown out, with
 * the emphasis, code spans, links and images the cells actually show. Column
 * alignment comes from the `align` attribute marked puts on the header cells,
 * so a copied table keeps the shape it was written with.
 */

const PIPE = /\|/g
const LINE_BREAK = /\r?\n/g
const WHITESPACE_RUN = /\s+/g

/** Markdown for one node inside a cell, recursing through inline children. */
function inlineMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (!(node instanceof HTMLElement)) return ''

  const children = (): string => Array.from(node.childNodes).map(inlineMarkdown).join('')

  switch (node.tagName) {
    case 'BR':
      // A markdown table cell is a single line, so an in-cell break stays the
      // HTML the reader saw rather than a newline that would split the row.
      return '<br>'
    case 'STRONG':
    case 'B':
      return `**${children()}**`
    case 'EM':
    case 'I':
      return `*${children()}*`
    case 'DEL':
    case 'S':
    case 'STRIKE':
      return `~~${children()}~~`
    case 'CODE': {
      const code = (node.textContent ?? '').replace(WHITESPACE_RUN, ' ').trim()
      const fence = code.includes('`') ? '``' : '`'
      return `${fence}${code}${fence}`
    }
    case 'A': {
      const label = children()
      const href = node.getAttribute('href') ?? ''
      return href === '' ? label : `[${label}](${href})`
    }
    case 'IMG': {
      const alt = node.getAttribute('alt') ?? ''
      const src = node.getAttribute('src') ?? ''
      return `![${alt}](${src})`
    }
    default:
      // Bare wrappers the renderer adds (citation chips, spans, divs) carry no
      // markdown of their own: their text is what belongs in the cell.
      return children()
  }
}

/** One cell's text, kept inside its column: no raw pipe, no newline. */
function cellMarkdown(cell: HTMLTableCellElement): string {
  const text = Array.from(cell.childNodes).map(inlineMarkdown).join('')
  return text.replace(PIPE, '\\|').replace(LINE_BREAK, '<br>').trim()
}

/** The divider cell for a column, or plain `---` when the source set none. */
function alignmentMarker(align: string | null): string {
  switch (align) {
    case 'center':
      return ':---:'
    case 'right':
      return '---:'
    case 'left':
      return ':---'
    default:
      return '---'
  }
}

function columnsOf(row: HTMLTableRowElement, columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, index) => {
    const cell = row.cells[index]
    return cell ? cellMarkdown(cell) : ''
  })
}

export function tableHtmlToMarkdown(tableHtml: string): string {
  const parsed = new DOMParser().parseFromString(tableHtml, 'text/html')
  const table = parsed.querySelector('table')
  if (!(table instanceof HTMLTableElement)) return ''

  const rows = [...table.rows]
  if (rows.length === 0) return ''

  // A markdown table always has a header: prefer the real one and fall back to
  // the first row, so a table rendered without a `<thead>` still round-trips.
  const headerRow = table.tHead?.rows[0] ?? rows[0]
  const bodyRows = rows.filter((row) => row !== headerRow)
  const columnCount = rows.reduce((count, row) => Math.max(count, row.cells.length), 0)
  if (columnCount === 0) return ''

  const divider = Array.from({ length: columnCount }, (_, index) =>
    alignmentMarker(headerRow.cells[index]?.getAttribute('align') ?? null)
  )

  return [
    `| ${columnsOf(headerRow, columnCount).join(' | ')} |`,
    `| ${divider.join(' | ')} |`,
    ...bodyRows.map((row) => `| ${columnsOf(row, columnCount).join(' | ')} |`)
  ].join('\n')
}
