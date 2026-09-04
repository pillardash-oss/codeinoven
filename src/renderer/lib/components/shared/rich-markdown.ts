import {
  isDoubleQuoteOpen,
  isInsideUnclosedInlineCode,
  isQuotedMentionPosition
} from '$shared/mention-context'

const INLINE_CODE_CLASS =
  'rounded border border-border bg-elevated px-1 py-0.5 font-mono text-[0.9em]'
const INLINE_BADGE_CLASS =
  'mx-0.5 inline-flex max-w-48 items-center gap-1 whitespace-nowrap rounded-md border border-border bg-elevated px-1.5 py-0.5 align-baseline text-[0.85em] font-medium leading-none text-foreground'
const INLINE_BADGE_ICON_CLASS = 'h-3.5 w-3.5 shrink-0'
const INLINE_BADGE_LABEL_CLASS = 'min-w-0 truncate'
const LIST_CLASS = 'my-1 pl-5'
const CODE_BLOCK_CLASS = 'group overflow-hidden rounded-lg border border-border bg-elevated'
const CODE_HEADER_CLASS = 'flex h-7 items-center justify-between border-b border-border px-3'
const CODE_LANG_CLASS =
  'code-lang-indicator font-mono text-[10px] uppercase tracking-wide text-dimmed outline-none'
const CODE_CONTENT_CLASS =
  'overflow-x-auto p-3 font-mono text-xs leading-relaxed text-foreground outline-none'
const CODE_DELETE_BUTTON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>'
const CODE_DELETE_BUTTON_CLASS =
  'grid h-5 w-5 place-items-center rounded text-dimmed opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-surface hover:text-foreground focus:opacity-100 focus:outline-none'
const CODE_DELETE_BUTTON_HTML = `<button type="button" data-editor-codeblock-delete="true" title="Delete code block" aria-label="Delete code block" class="${CODE_DELETE_BUTTON_CLASS}">${CODE_DELETE_BUTTON_SVG}</button>`

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface RichInlineBadge {
  iconSrc?: string
  label: string
  title: string
  value: string
}

interface EditorLinkReference {
  url: string
  title?: string
}

/** Document-scoped state shared by every `renderInline` call: reference-link
 *  definitions, footnote definitions, and footnote numbering in reference order. */
interface EditorRenderContext {
  linkRefs: Map<string, EditorLinkReference>
  footnoteLabels: Set<string>
  footnoteNumbers: Map<string, number>
  nextFootnoteNumber: number
}

interface EditorDefinitions {
  context: EditorRenderContext
  /** Line indexes that are `[label]: url` or `[^label]: text` definitions. They
   *  render as escaped literal text so their own `[label]`/`[^label]` never
   *  becomes a link or footnote reference. */
  definitionLines: Set<number>
}

const FOOTNOTE_REF_PATTERN = /\[\^([^\]]+)\]/gu
const INLINE_LINK_PATTERN = /(?<![!])\[([^\]]+)\]\(([^)\n]+)\)/gu
const REFERENCE_LINK_PATTERN = /\[([^\]]+)\]\[([^\]]*)\]/gu
// A shortcut reference `[text]` is only valid when not followed by `(` (inline
// link) or `[` (an explicit reference label) — otherwise it is plain prose.
const SHORTCUT_LINK_PATTERN = /\[([^\]]+)\](?!\(|\[)/gu

function normalizeReferenceLabel(label: string): string {
  return label.trim().toLowerCase()
}

/** Reject `javascript:`/`data:`-style schemes; allow http(s), mailto, fragment
 *  links and scheme-less relative targets. */
function safeLinkUrl(url: string): boolean {
  const trimmed = url.trim()
  if (!trimmed) return false
  if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) {
    return /^(https?|mailto):/iu.test(trimmed)
  }
  return true
}

/** Parse an inline link target `url "title"` into its parts. */
function parseLinkTarget(target: string): { url: string; title?: string } {
  const trimmed = target.trim()
  const match = /^(?:<([^>\n]+)>|(\S+))(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?$/u.exec(trimmed)
  if (!match) return { url: trimmed }
  return {
    url: (match[1] ?? match[2] ?? trimmed).trim(),
    title: match[3] ?? match[4] ?? match[5]
  }
}

function collectEditorDefinitions(lines: string[]): EditorDefinitions {
  const linkRefs = new Map<string, EditorLinkReference>()
  const footnoteLabels = new Set<string>()
  const definitionLines = new Set<number>()
  const referencePattern = /^\[([^\]]+)\]:\s*(.+)$/u
  const footnotePattern = /^\[\^([^\]]+)\]:\s*(.+)$/u

  lines.forEach((line, index) => {
    const footnote = footnotePattern.exec(line)
    if (footnote) {
      footnoteLabels.add((footnote[1] ?? '').trim())
      definitionLines.add(index)
      return
    }
    const reference = referencePattern.exec(line)
    if (!reference) return
    const label = (reference[1] ?? '').trim()
    const parsed = parseLinkTarget(reference[2] ?? '')
    if (!parsed.url) return
    linkRefs.set(normalizeReferenceLabel(label), { url: parsed.url, title: parsed.title })
    definitionLines.add(index)
  })

  return {
    context: {
      linkRefs,
      footnoteLabels,
      footnoteNumbers: new Map(),
      nextFootnoteNumber: 0
    },
    definitionLines
  }
}

function renderInline(
  source: string,
  inlineBadges: readonly RichInlineBadge[],
  context: EditorRenderContext,
  quoteOpenAtLineStart = false
): string {
  const code: string[] = []
  const badges: string[] = []
  const tokens: string[] = []
  const stashCode = (_match: string, content: string): string => {
    const index = code.push(`<code class="${INLINE_CODE_CLASS}">${escapeHtml(content)}</code>`)
    return `\uE000${index - 1}\uE001`
  }
  const stashToken = (html: string): string => {
    const index = tokens.push(html)
    return `\uE004${index - 1}\uE005`
  }

  // The empty pair `` `` `` is a valid inline code span: the input rule creates one
  // whenever the user types two backticks intending to type content between them.
  let prepared = source.replace(/`([^`\n]*)`/g, stashCode)
  for (const badge of [...inlineBadges].sort(
    (left, right) => right.value.length - left.value.length
  )) {
    if (!badge.value) continue
    prepared = prepared.replaceAll(badge.value, (match, offset: number, text: string) => {
      // Mentions and other badge values never become badges inside a block
      // quote, an open double-quoted passage, or an unclosed inline code span —
      // there the text must stay literal. (Closed inline code and fenced code
      // blocks are already safe: they are stashed or block-rendered before this
      // loop runs.)
      if (
        quoteOpenAtLineStart ||
        isQuotedMentionPosition(text, offset) ||
        isInsideUnclosedInlineCode(text.slice(0, offset))
      ) {
        return match
      }
      const icon = badge.iconSrc
        ? `<img src="${escapeHtml(badge.iconSrc)}" alt="" class="${INLINE_BADGE_ICON_CLASS}">`
        : ''
      const html = `<span contenteditable="false" data-editor-inline-badge="true" data-editor-value="${escapeHtml(badge.value)}" title="${escapeHtml(badge.title)}" class="${INLINE_BADGE_CLASS}">${icon}<span class="${INLINE_BADGE_LABEL_CLASS}">${escapeHtml(badge.label)}</span></span>`
      const index = badges.push(html)
      const caretSeparator = offset + badge.value.length === source.length ? '\u00a0' : ''
      return `\uE002${index - 1}\uE003${caretSeparator}`
    })
  }

  // Footnote references become numbered superscripts; only defined labels count.
  prepared = prepared.replace(FOOTNOTE_REF_PATTERN, (match, label: string) => {
    const normalized = label.trim()
    if (!context.footnoteLabels.has(normalized)) return match
    let number = context.footnoteNumbers.get(normalized)
    if (number === undefined) {
      number = context.nextFootnoteNumber + 1
      context.nextFootnoteNumber = number
      context.footnoteNumbers.set(normalized, number)
    }
    // Zero-width anchors keep the caret out of the non-editable superscript.
    const html = `<sup contenteditable="false" data-editor-footnote-ref="${escapeHtml(normalized)}">${String(number)}</sup>`
    return `\u200b${stashToken(html)}\u200b`
  })

  // Inline links `[text](url)` (never `![alt](url)` images).
  prepared = prepared.replace(INLINE_LINK_PATTERN, (match, text: string, target: string) => {
    const parsed = parseLinkTarget(target)
    if (!safeLinkUrl(parsed.url)) return match
    const titleAttr = parsed.title ? ` title="${escapeHtml(parsed.title)}"` : ''
    const html = `<a data-editor-link="true" data-editor-link-title="${escapeHtml(parsed.title ?? '')}" href="${escapeHtml(parsed.url)}"${titleAttr}>${escapeHtml(text.trim())}</a>`
    return stashToken(html)
  })

  // Reference links `[text][label]` and collapsed `[text][]`.
  prepared = prepared.replace(REFERENCE_LINK_PATTERN, (match, text: string, rawLabel: string) => {
    const label = rawLabel.trim()
    const reference = context.linkRefs.get(normalizeReferenceLabel(label || text))
    if (!reference) return match
    const html = `<a data-editor-link="true" data-editor-link-label="${escapeHtml(label || text)}" data-editor-link-text="${escapeHtml(text.trim())}" data-editor-link-raw="${escapeHtml(match)}" href="${escapeHtml(reference.url)}">${escapeHtml(text.trim())}</a>`
    return stashToken(html)
  })

  // Shortcut references `[text]` — only when a matching definition exists.
  prepared = prepared.replace(SHORTCUT_LINK_PATTERN, (match, text: string) => {
    const reference = context.linkRefs.get(normalizeReferenceLabel(text))
    if (!reference) return match
    const html = `<a data-editor-link="true" data-editor-link-label="${escapeHtml(text.trim())}" data-editor-link-text="${escapeHtml(text.trim())}" data-editor-link-raw="${escapeHtml(match)}" href="${escapeHtml(reference.url)}">${escapeHtml(text.trim())}</a>`
    return stashToken(html)
  })

  let html = escapeHtml(prepared)
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong class="font-semibold">$1</strong>')
  html = html.replace(
    /(?<![A-Za-z0-9])__([^\s_](?:[^\n]*?[^\s])?)__(?![A-Za-z0-9])/g,
    '<strong class="font-semibold">$1</strong>'
  )
  html = html.replace(/~~([^~\n]+)~~/g, '<del class="text-muted line-through">$1</del>')
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em class="italic">$1</em>')
  html = html.replace(
    /(?<![A-Za-z0-9_])_([^\s_](?:[^\n]*?[^\s])?)_(?![A-Za-z0-9])/g,
    '<em class="italic">$1</em>'
  )
  return html
    .replace(/\uE000(\d+)\uE001/g, (_match, index: string) => code[Number(index)] ?? '')
    .replace(/\uE002(\d+)\uE003/g, (_match, index: string) => badges[Number(index)] ?? '')
    .replace(/\uE004(\d+)\uE005/g, (_match, index: string) => tokens[Number(index)] ?? '')
}

function renderCodeBlockHTML(language: string, content: string): string {
  const escapedContent = escapeHtml(content) || '<br>'
  return `<div class="${CODE_BLOCK_CLASS}" contenteditable="false" data-editor-codeblock="true"><div class="${CODE_HEADER_CLASS}"><span contenteditable="true" role="textbox" aria-label="Language" class="${CODE_LANG_CLASS}">${escapeHtml(language)}</span>${CODE_DELETE_BUTTON_HTML}</div><pre class="${CODE_CONTENT_CLASS}"><code contenteditable="true" class="outline-none" data-language="${escapeHtml(language)}">${escapedContent}</code></pre></div>`
}

export function renderRichMarkdown(
  markdown: string,
  inlineBadges: readonly RichInlineBadge[] = []
): string {
  if (!markdown.trim()) return '<p><br></p>'

  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const { context, definitionLines } = collectEditorDefinitions(lines)
  const blocks: string[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (!line.trim()) {
      index += 1
      continue
    }

    const fence = line.match(/^```(\S*)/)
    if (fence) {
      const language = fence[1] || 'text'
      const codeLines: string[] = []
      index += 1
      while (index < lines.length) {
        const l = lines[index] ?? ''
        if (l.trim() === '```') {
          index += 1
          break
        }
        codeLines.push(l)
        index += 1
      }
      const codeContent = codeLines.join('\n')
      blocks.push(renderCodeBlockHTML(language, codeContent))
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const level = heading[1]?.length ?? 1
      blocks.push(
        `<h${level} class="${headingClass(level)}">${renderInline(heading[2] ?? '', inlineBadges, context)}</h${level}>`
      )
      index += 1
      continue
    }

    const unordered = line.match(/^\s*[-+*]\s+(.+)$/)
    if (unordered) {
      const items: string[] = []
      while (index < lines.length) {
        const match = (lines[index] ?? '').match(/^\s*[-+*]\s+(.+)$/)
        if (!match) break
        items.push(`<li class="my-0.5">${renderInline(match[1] ?? '', inlineBadges, context)}</li>`)
        index += 1
      }
      blocks.push(`<ul class="${LIST_CLASS} list-disc">${items.join('')}</ul>`)
      continue
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/)
    if (ordered) {
      const items: string[] = []
      while (index < lines.length) {
        const match = (lines[index] ?? '').match(/^\s*\d+[.)]\s+(.+)$/)
        if (!match) break
        items.push(`<li class="my-0.5">${renderInline(match[1] ?? '', inlineBadges, context)}</li>`)
        index += 1
      }
      blocks.push(`<ol class="${LIST_CLASS} list-decimal">${items.join('')}</ol>`)
      continue
    }

    const paragraph: string[] = []
    const paragraphLineIndexes: number[] = []
    while (index < lines.length) {
      const candidate = lines[index] ?? ''
      if (
        /^```(\S*)/.test(candidate) ||
        /^(#{1,6})\s+(.+)$/.test(candidate) ||
        /^\s*[-+*]\s+(.+)$/.test(candidate) ||
        /^\s*\d+[.)]\s+(.+)$/.test(candidate)
      ) {
        break
      }
      paragraph.push(candidate)
      paragraphLineIndexes.push(index)
      index += 1
    }
    let quotePrefix = ''
    blocks.push(
      `<p class="mb-1 last:mb-0">${paragraph
        .map((line, lineIndex) => {
          // Carry double-quote state across the paragraph's lines so a quote
          // opened on an earlier line keeps later lines badge-free too.
          const quoteOpen = isDoubleQuoteOpen(quotePrefix)
          quotePrefix += `${line}\n`
          return definitionLines.has(paragraphLineIndexes[lineIndex] ?? 0)
            ? escapeHtml(line)
            : renderInline(line, inlineBadges, context, quoteOpen)
        })
        .join('<br>')}</p>`
    )
  }

  return blocks.join('')
}

function headingClass(level: number): string {
  if (level === 1) return 'mb-1 text-xl font-semibold leading-7'
  if (level === 2) return 'mb-1 text-lg font-semibold leading-6'
  if (level === 3) return 'mb-1 text-base font-semibold leading-6'
  if (level === 4) return 'mb-1 text-sm font-semibold leading-5'
  if (level === 5) return 'mb-1 text-sm font-medium leading-5'
  return 'mb-1 text-xs font-medium uppercase tracking-wide leading-5'
}

function serializeInline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? '').replace(/\u00a0/g, ' ').replace(/\u200b/g, '')
  }
  if (!(node instanceof HTMLElement)) return ''

  if (node.dataset.editorInlineBadge === 'true') {
    return node.dataset.editorValue ?? ''
  }

  const content = Array.from(node.childNodes).map(serializeInline).join('')
  switch (node.tagName) {
    case 'BR':
      return '\n'
    case 'STRONG':
    case 'B':
      return `**${content}**`
    case 'EM':
    case 'I':
      return `*${content}*`
    case 'DEL':
    case 'S':
    case 'STRIKE':
      return `~~${content}~~`
    case 'CODE':
      return node.parentElement?.tagName === 'PRE' ? (node.textContent ?? '') : `\`${content}\``
    case 'A': {
      const linkLabel = node.dataset.editorLinkLabel
      if (linkLabel) {
        const raw = node.dataset.editorLinkRaw
        const originalText = node.dataset.editorLinkText
        // Preserve the author's exact `[text][label]` / `[text][]` / `[text]`
        // spelling while the link text is untouched; otherwise re-emit with the
        // edited text against the resolved label.
        if (raw && originalText !== undefined && content === originalText) return raw
        return `[${content}][${linkLabel}]`
      }
      const title = node.dataset.editorLinkTitle
      const href = node.getAttribute('href') ?? ''
      return title ? `[${content}](${href} "${title}")` : `[${content}](${href})`
    }
    case 'SUP': {
      const footnote = node.dataset.editorFootnoteRef
      return footnote !== undefined ? `[^${footnote}]` : content
    }
    default:
      return content
  }
}

function serializeList(list: HTMLElement, depth = 0): string {
  const ordered = list.tagName === 'OL'
  const items = Array.from(list.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.tagName === 'LI'
  )

  return items
    .map((item, index) => {
      const nested = Array.from(item.children).filter(
        (child): child is HTMLElement =>
          child instanceof HTMLElement && (child.tagName === 'UL' || child.tagName === 'OL')
      )
      const content = Array.from(item.childNodes)
        .filter((child) => !(child instanceof HTMLElement && nested.includes(child)))
        .map(serializeInline)
        .join('')
        .trim()
      const prefix = ordered ? `${index + 1}. ` : '- '
      const line = content ? `${'  '.repeat(depth)}${prefix}${content}` : ''
      const children = nested.map((child) => serializeList(child, depth + 1)).join('\n')
      return children ? `${line}\n${children}` : line
    })
    .filter(Boolean)
    .join('\n')
}

function serializeBlock(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (!(node instanceof HTMLElement)) return ''

  if (node.dataset.editorCodeblock === 'true') {
    const code = node.querySelector('code')
    const language = code?.dataset.language ?? ''
    const content = code ? Array.from(code.childNodes).map(serializeInline).join('') : ''
    return `\`\`\`${language}\n${content}\n\`\`\``
  }
  if (/^H[1-6]$/.test(node.tagName)) {
    const content = Array.from(node.childNodes).map(serializeInline).join('').trim()
    return content ? `${'#'.repeat(Number(node.tagName.slice(1)))} ${content}` : ''
  }
  if (node.tagName === 'UL' || node.tagName === 'OL') return serializeList(node)
  if (node.tagName === 'PRE') {
    const code = node.querySelector('code')
    const language = code?.dataset.language ?? ''
    const content = code
      ? Array.from(code.childNodes).map(serializeInline).join('')
      : (node.textContent ?? '')
    return `\`\`\`${language}\n${content}\n\`\`\``
  }
  return Array.from(node.childNodes).map(serializeInline).join('').trimEnd()
}

/**
 * Count blank lines the user typed at the very end of a block, i.e. trailing
 * `<br>` separators. Serialization trims each block so joining multiple blocks
 * with `\n\n` doesn't double-count a shared blank line; this re-adds only the
 * trailing blank lines of the final content block, which nothing else represents.
 */
function trailingBlankLineCount(node: Node): number {
  if (!(node instanceof HTMLElement)) return 0
  let count = 0
  for (let i = node.childNodes.length - 1; i >= 0; i -= 1) {
    const child = node.childNodes[i]
    if (child instanceof HTMLBRElement) {
      count += 1
    } else if (
      child.nodeType === Node.TEXT_NODE &&
      (child.textContent ?? '').replace(/\u200b/g, '').trim() === ''
    ) {
      continue
    } else {
      break
    }
  }
  return count
}

export function serializeRichMarkdown(root: HTMLElement): string {
  const nodes = Array.from(root.childNodes)
  const blocks = nodes.map(serializeBlock).filter((block) => block.length > 0)
  const value = blocks.join('\n\n')
  // Re-add the trailing blank lines of the last content block so a message that
  // ends with blank lines round-trips exactly.
  let lastContentNode: Node | null = null
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i]
    if (node instanceof HTMLElement && (node.textContent ?? '').trim().length > 0) {
      lastContentNode = node
      break
    }
  }
  const trailing = lastContentNode ? trailingBlankLineCount(lastContentNode) : 0
  return trailing > 0 ? `${value}${'\n'.repeat(trailing)}` : value
}

function selectionInside(root: HTMLElement): Selection | null {
  const selection = window.getSelection()
  if (!selection?.anchorNode || !root.contains(selection.anchorNode)) return null
  return selection
}

export function placeCaretAtEnd(root: HTMLElement): void {
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.selectNodeContents(root)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}

export function placeCaretInside(element: HTMLElement): void {
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.selectNodeContents(element)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}

function placeCaretAtStart(element: HTMLElement): void {
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.selectNodeContents(element)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

/** Lifts nested lists out of a list item so the item can be re-shaped as a block
 *  (paragraph or a sibling item) without dragging its sub-lists along. */
function liftNestedLists(item: HTMLElement): HTMLElement[] {
  const lists = Array.from(item.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && (child.tagName === 'UL' || child.tagName === 'OL')
  )
  for (const list of lists) {
    list.remove()
  }
  return lists
}

/** Reverts a list item that the caret sits at the very start of: an item nested
 *  inside another item is lifted up a level, and the first item of a top-level
 *  list becomes a plain paragraph in front of the list. Mid-list items fall back
 *  to the browser's native merge and return false. */
export function unlistListItem(root: HTMLElement, listItem: HTMLElement): boolean {
  const list = listItem.parentElement
  if (!list || (list.tagName !== 'UL' && list.tagName !== 'OL')) return false
  if (!root.contains(listItem) || listItem.previousElementSibling !== null) return false

  const parentListItem = list.parentElement?.closest('li')
  if (parentListItem) {
    const parentList = parentListItem.parentElement
    if (!parentList) return false
    listItem.remove()
    parentList.insertBefore(listItem, parentListItem.nextSibling)
    if (!list.firstElementChild) list.remove()
    placeCaretAtStart(listItem)
    return true
  }

  const nestedLists = liftNestedLists(listItem)
  const paragraph = document.createElement('p')
  paragraph.append(...Array.from(listItem.childNodes))
  if (paragraph.childNodes.length === 0) paragraph.append(document.createElement('br'))
  listItem.remove()
  list.before(paragraph)
  let cursor: ChildNode = paragraph
  for (const nested of nestedLists) {
    cursor.after(nested)
    cursor = nested
  }
  if (!list.firstElementChild) {
    list.remove()
    if (!root.firstElementChild) {
      root.innerHTML = renderRichMarkdown('')
    }
  }
  placeCaretAtStart(paragraph)
  return true
}

function currentBlock(root: HTMLElement, node: Node): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node.parentElement
  const block = element?.closest('p, div, h1, h2, h3, h4, h5, h6, li, pre')
  return block instanceof HTMLElement && root.contains(block) ? block : null
}

export function selectedBlockTag(root: HTMLElement): string | null {
  const selection = selectionInside(root)
  if (!selection?.anchorNode) return null
  let node = selection.anchorNode
  if (node === root) {
    node = root.childNodes[Math.max(0, selection.anchorOffset - 1)] ?? root.lastChild ?? root
  }
  const block = currentBlock(root, node)
  return block === root ? null : (block?.tagName ?? null)
}

function isFirstContentInBlock(block: HTMLElement, element: Node): boolean {
  for (const child of Array.from(block.childNodes)) {
    if (child === element) return true
    if (child instanceof HTMLBRElement) continue
    if (
      child.nodeType === Node.TEXT_NODE &&
      (child.textContent ?? '').replace(/\u200b/g, '').trim() === ''
    ) {
      continue
    }
    return false
  }
  return false
}

function replaceInlineMatch(
  root: HTMLElement,
  textNode: Text,
  endOffset: number,
  match: RegExpMatchArray,
  tagName: 'strong' | 'em' | 'del' | 'code'
): void {
  const startOffset = endOffset - match[0].length
  const range = document.createRange()
  range.setStart(textNode, startOffset)
  range.setEnd(textNode, endOffset)
  range.deleteContents()

  const element = document.createElement(tagName)
  element.textContent = match[1] ?? ''
  if (tagName === 'strong') element.className = 'font-semibold'
  if (tagName === 'em') element.className = 'italic'
  if (tagName === 'del') element.className = 'text-muted line-through'
  if (tagName === 'code') element.className = INLINE_CODE_CLASS
  range.insertNode(element)

  // A zero-width anchor before the element keeps the caret from getting trapped
  // when it becomes the first content of its block — without one, browsers refuse
  // to move the caret left out of the element.
  const block = currentBlock(root, element)
  if (block && isFirstContentInBlock(block, element)) {
    element.before(document.createTextNode('\u200b'))
  }

  const caretAnchor = document.createTextNode('\u200b')
  element.after(caretAnchor)

  const selection = window.getSelection()
  if (!selection) return
  range.setStart(caretAnchor, 1)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

/** Create an inline code element (optionally empty) and place the caret where
 *  `caretInsideCode` says: inside the element for a fresh empty span the user is
 *  about to type into, otherwise after it (with a zero-width anchor). */
function insertInlineCode(root: HTMLElement, content: string, caretInsideCode: boolean): void {
  const code = document.createElement('code')
  code.className = INLINE_CODE_CLASS
  if (content) code.textContent = content
  else code.append(document.createTextNode('\u200b'))

  const selection = window.getSelection()
  if (!selection || !selection.rangeCount) return
  const range = selection.getRangeAt(0)
  range.deleteContents()
  range.insertNode(code)

  // A zero-width anchor before the element keeps the caret from getting trapped
  // when it becomes the first content of its block — without one, browsers refuse
  // to move the caret left out of the element.
  const block = currentBlock(root, code)
  if (block && isFirstContentInBlock(block, code)) {
    code.before(document.createTextNode('\u200b'))
  }

  const caretAnchor = document.createTextNode('\u200b')
  code.after(caretAnchor)

  if (caretInsideCode) {
    range.setStart(code, code.firstChild ? 1 : 0)
  } else {
    range.setStart(caretAnchor, 1)
  }
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

/**
 * A non-backtick character landing right after a fresh double backtick (``x)
 * turns ``x into an inline code span with the caret inside — so typing or
 * pasting content between the backticks "opens" the span, while the bare pair
 * `` and the triple ``` (a fence) stay literal.
 */
export function applyEmptyPairCodeRule(root: HTMLElement): boolean {
  const selection = selectionInside(root)
  if (!selection?.isCollapsed || !(selection.anchorNode instanceof Text)) return false
  if (selection.anchorNode.parentElement?.closest?.('[data-editor-codeblock]')) return false

  const textNode = selection.anchorNode
  const endOffset = selection.anchorOffset
  const prefixText = textNode.data.slice(0, endOffset)
  const pairContent = prefixText.match(/``([^`\n]+)$/)
  if (!pairContent) return false
  // A pair that is itself preceded by a backtick is the tail of ``` (or more)
  // — that is a code fence being typed, never an inline span.
  const pairStart = endOffset - pairContent[0].length
  if (pairStart > 0 && prefixText[pairStart - 1] === '`') return false

  const range = document.createRange()
  range.setStart(textNode, endOffset - pairContent[0].length)
  range.setEnd(textNode, endOffset)
  if (window.getSelection()) {
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
  }
  insertInlineCode(root, pairContent[1] ?? '', true)
  return true
}

function applyInlineRule(root: HTMLElement): boolean {
  const selection = selectionInside(root)
  if (!selection?.isCollapsed || !(selection.anchorNode instanceof Text)) return false
  // Markdown inline formatting must never fire inside a code block — code like
  // `const x = `foo`` or `**not bold**` has to stay literal.
  if (selection.anchorNode.parentElement?.closest?.('[data-editor-codeblock]')) return false

  const textNode = selection.anchorNode
  const endOffset = selection.anchorOffset
  const prefix = textNode.data.slice(0, endOffset)
  const suffix = textNode.data.slice(endOffset)

  // A block whose view is a ``` fence candidate (```lang, or ```…``` across
  // its own text and following sibling blocks for the tag-end-then-open flow)
  // belongs to the Enter-triggered fence rule — inline rules must never eat
  // its backticks while it is typed.
  const fenceBlock = currentBlock(root, selection.anchorNode)
  if (fenceBlock) {
    const candidate = collectFenceCandidate(root, fenceBlock)
    if (candidate && parseFenceCandidateText(candidate.text)) return false
  }

  // A non-backtick character typed (or pasted) right after a fresh double
  // backtick starts an inline code span with the caret inside. The bare pair
  // `` stays literal, and a third backtick never triggers — that is a code
  // fence. Skipped while a fence is being built: a trailing triple after the
  // caret means the closing ``` of the tag-end-then-open flow, not content.
  if (!suffix.includes('```') && applyEmptyPairCodeRule(root)) return true

  // Opening-backtick-last flow: the user tagged the end of a run with a backtick
  // first, moved the caret before the run, and now types the opening backtick.
  // The typed backtick plus the trailing one after the caret wrap the text
  // between them into an inline code span. The run must start at a word
  // boundary so literal backticks in mid-word prose never trigger it.
  const closesAfter = suffix.match(/^([^`\n]+)`/)
  const boundaryChar = endOffset >= 2 ? prefix[endOffset - 2] : undefined
  if (
    closesAfter &&
    (boundaryChar === undefined || /[\s\u00a0\u200b]/.test(boundaryChar))
  ) {
    const range = document.createRange()
    range.setStart(textNode, endOffset - 1)
    range.setEnd(textNode, endOffset + closesAfter[0].length)
    const selection = window.getSelection()
    if (selection) {
      selection.removeAllRanges()
      selection.addRange(range)
    }
    insertInlineCode(root, closesAfter[1] ?? '', false)
    return true
  }

  const rules: Array<[RegExp, 'strong' | 'em' | 'del' | 'code']> = [
    [/\*\*([^*\n]+)\*\*$/, 'strong'],
    [/(?<![A-Za-z0-9])__([^\s_](?:[^\n]*?[^\s])?)__$/, 'strong'],
    [/~~([^~\n]+)~~$/, 'del'],
    [/(?<!\*)\*([^*\n]+)\*$/, 'em'],
    [/(?<![A-Za-z0-9_])_([^\s_](?:[^\n]*?[^\s])?)_$/, 'em'],
    [/`([^`\n]+)`$/, 'code']
  ]

  for (const [pattern, tag] of rules) {
    const match = prefix.match(pattern)
    if (!match) continue
    replaceInlineMatch(root, textNode, endOffset, match, tag)
    return true
  }
  return false
}

function replaceBlockWithHeading(block: HTMLElement, level: number, content: string): void {
  const heading = document.createElement(`h${level}`)
  heading.className = headingClass(level)
  heading.append(content ? document.createTextNode(content) : document.createElement('br'))
  block.replaceWith(heading)
  placeCaretInside(heading)
}

function replaceBlockWithList(block: HTMLElement, ordered: boolean, content: string): void {
  const list = document.createElement(ordered ? 'ol' : 'ul')
  list.className = `${LIST_CLASS} ${ordered ? 'list-decimal' : 'list-disc'}`
  const item = document.createElement('li')
  item.className = 'my-0.5'
  item.append(content ? document.createTextNode(content) : document.createElement('br'))
  list.append(item)
  block.replaceWith(list)
  placeCaretInside(item)
}

function createCodeBlockElement(language: string): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = CODE_BLOCK_CLASS
  wrapper.contentEditable = 'false'
  wrapper.dataset.editorCodeblock = 'true'

  const header = document.createElement('div')
  header.className = CODE_HEADER_CLASS

  const langSpan = document.createElement('span')
  langSpan.className = CODE_LANG_CLASS
  langSpan.contentEditable = 'true'
  langSpan.role = 'textbox'
  langSpan.ariaLabel = 'Language'
  // Chromium's macOS autocorrect mangles punctuation in editable fields
  // (".." -> ellipsis, "??" -> U+2047) — language names must stay literal.
  langSpan.setAttribute('autocorrect', 'false')
  langSpan.textContent = language || 'text'

  header.append(langSpan)
  header.insertAdjacentHTML('beforeend', CODE_DELETE_BUTTON_HTML)

  const pre = document.createElement('pre')
  pre.className = CODE_CONTENT_CLASS

  const code = document.createElement('code')
  code.contentEditable = 'true'
  code.className = 'outline-none'
  code.dataset.language = language || 'text'
  code.append(document.createElement('br'))

  pre.append(code)
  wrapper.append(header, pre)
  return wrapper
}

/** Plain text of a block with soft breaks (`<br>`) as newlines and zero-width
 *  caret anchors stripped — the text the user sees for the whole block. */
function blockTextWithBreaks(block: HTMLElement): string {
  let text = ''
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += (node.textContent ?? '').replace(/\u200b/g, '')
    } else if (node instanceof HTMLBRElement) {
      text += '\n'
    } else if (node instanceof HTMLElement) {
      for (const child of Array.from(node.childNodes)) visit(child)
    }
  }
  for (const child of Array.from(block.childNodes)) visit(child)
  return text
}

interface FenceCandidate {
  /** Text of the opening block plus any siblings up to (not including) the
   *  closing ``` block. */
  text: string
  /** Blocks consumed by the candidate: the opening block and content siblings. */
  nodes: HTMLElement[]
  /** True when a sibling block whose text is exactly ``` closed the candidate. */
  closed: boolean
}

/**
 * The fence-relevant text for a block: its own text plus following sibling
 * text blocks, stopping at a sibling that is exactly ``` (the closer) or one
 * that starts with ``` (another opening — not ours). The composer renders
 * every Enter-separated line as its own block, so the closing ``` the user
 * tagged on at the end usually lives in a sibling, not in the same block.
 */
function collectFenceCandidate(root: HTMLElement, block: HTMLElement): FenceCandidate | null {
  const parts: string[] = [blockTextWithBreaks(block).replace(/[\u200b\u00a0\s]+$/g, '')]
  const nodes: HTMLElement[] = [block]
  if (parts[0]?.split('\n').some((line) => /^\s*>/.test(line))) return null

  let sibling = block.nextElementSibling
  while (sibling instanceof HTMLElement && root.contains(sibling)) {
    const text = blockTextWithBreaks(sibling).replace(/[\u200b\u00a0\s]+$/g, '')
    if (text === '```') return { text: `${parts.join('\n')}\n\u0060\u0060\u0060`, nodes: [...nodes, sibling], closed: true }
    if (text.startsWith('```')) break
    if (sibling.tagName !== 'P' && sibling.tagName !== 'DIV') break
    if (text.split('\n').some((line) => /^\s*>/.test(line))) return null
    nodes.push(sibling)
    parts.push(text)
    sibling = sibling.nextElementSibling
  }
  return { text: parts.join('\n'), nodes, closed: false }
}

/** Parse fence-candidate text (```lang, ```lang content…```, ```content```)
 *  into its language and body, or null when it is not a fence. The language
 *  token is the word right after the fence: whitespace-bounded, or split off
 *  at an inner uppercase letter so ```txtError… reads as lang "txt". */
function parseFenceCandidateText(text: string): { language: string; content: string } | null {
  if (!text.startsWith('\u0060\u0060\u0060')) return null
  let rest = text.slice(3)
  let language = ''

  const token = rest.match(/^([A-Za-z0-9+#_.-]+)/)
  if (token) {
    const word = token[1]
    const after = rest.slice(word.length)
    const next = after[0]
    if (next === undefined || /\s/.test(next)) {
      // Whitespace-bounded word — the language, unless it hides a shorter
      // lowercase prefix before an uppercase letter ("txtError..." -> "txt").
      const splitAt = word.slice(1).search(/[A-Z]/)
      if (splitAt > -1 && splitAt + 1 <= 5) {
        language = word.slice(0, splitAt + 1)
        rest = word.slice(splitAt + 1) + after
      } else {
        language = word
        rest = after
      }
    } else {
      // Attached to more text ("```txtError..."): try the uppercase split,
      // otherwise the whole word is content and there is no language.
      const splitAt = word.slice(1).search(/[A-Z]/)
      if (splitAt > -1 && splitAt + 1 <= 5) {
        language = word.slice(0, splitAt + 1)
        rest = word.slice(splitAt + 1) + after
      } else {
        rest = word + after
      }
    }
  }

  if (!rest.endsWith('\u0060\u0060\u0060')) {
    // Opening fence only: ``` or ```lang with nothing between the fences yet.
    if (rest === '') return { language, content: '' }
    if (/^[A-Za-z0-9+#_.-]+$/.test(rest)) return { language: rest, content: '' }
    return null
  }
  let body = rest.slice(0, -3)
  if (body.includes('\u0060\u0060\u0060')) return null
  if (language) body = body.replace(/^[ \u00a0\n]/, '')
  while (body.endsWith('\n')) body = body.slice(0, -1)
  return { language, content: body }
}

/**
 * Enter-triggered code fence. Instead of converting as soon as ```lang is
 * typed, the fence only materializes when Enter is pressed in a block whose
 * text is ```lang, or whose view (own text plus following sibling blocks up
 * to a closing ```) parses as ```lang content ``` / ```content``` — the
 * composer puts every Enter-separated line in its own block, so the closing
 * ``` the user tagged on usually lives in a sibling. Never fires inside a
 * blockquote line or an existing code block.
 */
export function applyCodeFenceOnEnter(root: HTMLElement): boolean {
  const selection = selectionInside(root)
  if (!selection?.isCollapsed || !(selection.anchorNode instanceof Text)) return false
  if (selection.anchorNode.parentElement?.closest?.('[data-editor-codeblock]')) return false

  const block = currentBlock(root, selection.anchorNode)
  if (!block || block === root || (block.tagName !== 'P' && block.tagName !== 'DIV')) {
    return false
  }

  const candidate = collectFenceCandidate(root, block)
  if (!candidate) return false
  const parsed = parseFenceCandidateText(candidate.text)
  if (!parsed) return false

  const wrapper = createCodeBlockElement(parsed.language)
  const code = wrapper.querySelector('code')
  if (code) {
    if (parsed.content) {
      const lines = parsed.content.split('\n')
      if (lines.at(-1) === '') lines.pop()
      code.replaceChildren(
        ...lines.flatMap((line, index) => {
          const parts: Node[] = []
          if (index > 0) parts.push(document.createElement('br'))
          if (line) parts.push(document.createTextNode(line))
          return parts
        })
      )
    }
    if (code.childNodes.length === 0) code.append(document.createElement('br'))
    block.parentNode?.insertBefore(wrapper, block)
    for (const node of candidate.nodes) node.remove()
    placeCaretAtEnd(code)
  }
  return true
}

function applyBlockRule(root: HTMLElement): boolean {
  const selection = selectionInside(root)
  if (!selection?.anchorNode) return false
  const block = currentBlock(root, selection.anchorNode)
  if (!block || block === root || (block.tagName !== 'P' && block.tagName !== 'DIV')) return false
  const text = block.textContent ?? ''

  const heading = text.match(/^(#{1,6})\s+(.*)$/)
  if (heading) {
    replaceBlockWithHeading(block, heading[1]?.length ?? 1, heading[2] ?? '')
    return true
  }
  const unordered = text.match(/^[-+*]\s+(.*)$/)
  if (unordered) {
    replaceBlockWithList(block, false, unordered[1] ?? '')
    return true
  }
  const ordered = text.match(/^1[.)]\s+(.*)$/)
  if (ordered) {
    replaceBlockWithList(block, true, ordered[1] ?? '')
    return true
  }

  return false
}

export function applyMarkdownInputRule(root: HTMLElement): void {
  // The code fence is deliberately NOT an input rule: it only materializes on
  // Enter (see `applyCodeFenceOnEnter`), so typing ```lang never yanks the
  // paragraph away mid-sentence.
  if (applyBlockRule(root)) return
  applyInlineRule(root)
}

export function formatRichSelection(root: HTMLElement, tagName: 'strong' | 'em' | 'code'): boolean {
  const selection = selectionInside(root)
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  const element = document.createElement(tagName)
  if (tagName === 'strong') element.className = 'font-semibold'
  if (tagName === 'em') element.className = 'italic'
  if (tagName === 'code') element.className = INLINE_CODE_CLASS
  element.append(range.extractContents())
  range.insertNode(element)
  range.selectNodeContents(element)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

export function insertMarkdownLineBreak(root: HTMLElement): boolean {
  const selection = selectionInside(root)
  if (!selection?.anchorNode || selection.rangeCount === 0) return false
  let node = selection.anchorNode
  if (node === root) {
    node = root.childNodes[Math.max(0, selection.anchorOffset - 1)] ?? root.lastChild ?? root
  }
  const block = currentBlock(root, node)
  if (!block || block.tagName === 'PRE') return false

  const range = selection.getRangeAt(0)
  range.deleteContents()
  const lineBreak = document.createElement('br')
  range.insertNode(lineBreak)

  const remaining = document.createRange()
  remaining.setStartAfter(lineBreak)
  remaining.setEnd(block, block.childNodes.length)
  if (remaining.toString().length === 0) {
    const caretAnchor = document.createTextNode('\u200b')
    lineBreak.after(caretAnchor)
    range.setStart(caretAnchor, 1)
  } else {
    range.setStartAfter(lineBreak)
  }

  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

export function insertPlainText(root: HTMLElement, text: string): void {
  const selection = selectionInside(root)
  if (!selection || selection.rangeCount === 0) return
  const range = selection.getRangeAt(0)
  range.deleteContents()
  const fragment = document.createDocumentFragment()
  let lastNode: Node | null = null

  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((line, index) => {
      if (index > 0) {
        lastNode = document.createElement('br')
        fragment.append(lastNode)
      }
      if (line) {
        lastNode = document.createTextNode(line)
        fragment.append(lastNode)
      }
    })

  range.insertNode(fragment)
  if (!lastNode) return
  range.setStartAfter(lastNode)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

export function syncCodeBlockLanguages(root: HTMLElement): void {
  const wrappers = root.querySelectorAll<HTMLElement>('[data-editor-codeblock]')
  for (const wrapper of wrappers) {
    const langSpan = wrapper.querySelector<HTMLSpanElement>('.code-lang-indicator')
    const code = wrapper.querySelector('code')
    if (langSpan && code) {
      const lang = langSpan.textContent?.trim() || 'text'
      code.dataset.language = lang
    }
  }
}
