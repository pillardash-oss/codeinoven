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

function renderInline(source: string, inlineBadges: readonly RichInlineBadge[]): string {
  const code: string[] = []
  const badges: string[] = []
  const stashCode = (_match: string, content: string): string => {
    const index = code.push(`<code class="${INLINE_CODE_CLASS}">${escapeHtml(content)}</code>`)
    return `\uE000${index - 1}\uE001`
  }

  let prepared = source.replace(/`([^`\n]+)`/g, stashCode)
  for (const badge of [...inlineBadges].sort(
    (left, right) => right.value.length - left.value.length
  )) {
    if (!badge.value) continue
    prepared = prepared.replaceAll(badge.value, () => {
      const icon = badge.iconSrc
        ? `<img src="${escapeHtml(badge.iconSrc)}" alt="" class="${INLINE_BADGE_ICON_CLASS}">`
        : ''
      const html = `<span contenteditable="false" data-editor-inline-badge="true" data-editor-value="${escapeHtml(badge.value)}" title="${escapeHtml(badge.title)}" class="${INLINE_BADGE_CLASS}">${icon}<span class="${INLINE_BADGE_LABEL_CLASS}">${escapeHtml(badge.label)}</span></span>`
      const index = badges.push(html)
      return `\uE002${index - 1}\uE003`
    })
  }

  let html = escapeHtml(prepared)
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong class="font-semibold">$1</strong>')
  html = html.replace(/__([^_\n]+)__/g, '<strong class="font-semibold">$1</strong>')
  html = html.replace(/~~([^~\n]+)~~/g, '<del class="text-muted line-through">$1</del>')
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em class="italic">$1</em>')
  html = html.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '<em class="italic">$1</em>')
  return html
    .replace(/\uE000(\d+)\uE001/g, (_match, index: string) => code[Number(index)] ?? '')
    .replace(/\uE002(\d+)\uE003/g, (_match, index: string) => badges[Number(index)] ?? '')
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
        `<h${level} class="${headingClass(level)}">${renderInline(heading[2] ?? '', inlineBadges)}</h${level}>`
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
        items.push(`<li class="my-0.5">${renderInline(match[1] ?? '', inlineBadges)}</li>`)
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
        items.push(`<li class="my-0.5">${renderInline(match[1] ?? '', inlineBadges)}</li>`)
        index += 1
      }
      blocks.push(`<ol class="${LIST_CLASS} list-decimal">${items.join('')}</ol>`)
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length) {
      const candidate = lines[index] ?? ''
      if (
        /^```(\S*)/.test(candidate) ||
        /^(#{1,6})\s+/.test(candidate) ||
        /^\s*[-+*]\s+/.test(candidate) ||
        /^\s*\d+[.)]\s+/.test(candidate)
      ) {
        break
      }
      paragraph.push(candidate)
      index += 1
    }
    blocks.push(
      `<p class="mb-1 last:mb-0">${paragraph.map((line) => renderInline(line, inlineBadges)).join('<br>')}</p>`
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

function applyInlineRule(root: HTMLElement): boolean {
  const selection = selectionInside(root)
  if (!selection?.isCollapsed || !(selection.anchorNode instanceof Text)) return false

  const textNode = selection.anchorNode
  const endOffset = selection.anchorOffset
  const prefix = textNode.data.slice(0, endOffset)
  const rules: Array<[RegExp, 'strong' | 'em' | 'del' | 'code']> = [
    [/\*\*([^*\n]+)\*\*$/, 'strong'],
    [/__([^_\n]+)__$/, 'strong'],
    [/~~([^~\n]+)~~$/, 'del'],
    [/(?<!\*)\*([^*\n]+)\*$/, 'em'],
    [/(?<!_)_([^_\n]+)_$/, 'em'],
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

function childIndexOf(parent: Node, child: Node): number {
  const children = parent.childNodes
  for (let index = 0; index < children.length; index += 1) {
    if (children[index] === child) return index
  }
  return -1
}

/** True when a node contributes real content to its block. Soft breaks (`<br>`)
 *  are treated as whitespace so a caret sitting before a trailing break or after
 *  a leading one still resolves to a block boundary. */
function hasVisibleContent(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? '').replace(/[\u200b\u00a0]/g, '').length > 0
  }
  if (node instanceof HTMLBRElement) return false
  if (node instanceof HTMLElement) {
    return Array.from(node.childNodes).some(hasVisibleContent)
  }
  return false
}

/** Whether there is visible content before (`before`) or after (`after`) a
 *  position inside `block`. The scan is scoped to the block so a caret at a
 *  block boundary never counts siblings in neighbouring blocks. */
function hasContentAt(
  block: HTMLElement,
  container: Node,
  offset: number,
  before: boolean
): boolean {
  if (container.nodeType === Node.TEXT_NODE) {
    const text = container.textContent ?? ''
    const slice = before ? text.slice(0, offset) : text.slice(offset)
    if (slice.replace(/[\u200b\u00a0]/g, '').length > 0) return true
    const parent = container.parentNode
    if (!parent) return false
    return hasContentAt(block, parent, childIndexOf(parent, container) + (before ? 0 : 1), before)
  }
  const children = Array.from(container.childNodes)
  if (before) {
    for (let index = offset - 1; index >= 0; index -= 1) {
      if (hasVisibleContent(children[index] ?? block)) return true
    }
  } else {
    for (let index = offset; index < children.length; index += 1) {
      if (hasVisibleContent(children[index] ?? block)) return true
    }
  }
  if (container === block) return false
  const parent = container.parentNode
  if (!parent) return false
  return hasContentAt(block, parent, childIndexOf(parent, container) + (before ? 0 : 1), before)
}

function applyCodeFenceRule(root: HTMLElement): boolean {
  const selection = selectionInside(root)
  if (!selection?.isCollapsed || !(selection.anchorNode instanceof Text)) return false

  const textNode = selection.anchorNode
  const caretOffset = selection.anchorOffset
  const rawBefore = textNode.data.slice(0, caretOffset)
  // Soft breaks leave a zero-width caret anchor after the line content; ignore it.
  const cleanBefore = rawBefore.replace(/[\u200b\u00a0]+$/g, '')
  const fence = cleanBefore.match(/```(\S*)$/)
  if (!fence) return false

  const block = currentBlock(root, textNode)
  if (!block || block === root || (block.tagName !== 'P' && block.tagName !== 'DIV')) {
    return false
  }

  const fenceStart = cleanBefore.length - fence[0].length
  textNode.deleteData(fenceStart, caretOffset - fenceStart)
  // Deleting the fence shifts any text after it left; the caret boundary now sits
  // at `fenceStart` inside the node.
  const boundaryOffset = fenceStart

  const wrapper = createCodeBlockElement(fence[1] ?? '')
  const code = wrapper.querySelector('code')
  const hasBefore = hasContentAt(block, textNode, boundaryOffset, true)
  const hasAfter = hasContentAt(block, textNode, boundaryOffset, false)

  if (hasBefore && hasAfter && textNode.parentElement === block) {
    // The caret is mid-paragraph (e.g. across a soft break). Split the block:
    // keep the text before the caret, insert the code block exactly there, and
    // move the text after the caret into its own paragraph.
    const range = document.createRange()
    range.setStart(textNode, boundaryOffset)
    range.setEnd(block, block.childNodes.length)
    const fragment = range.extractContents()
    if (fragment.firstChild instanceof HTMLBRElement) fragment.firstChild.remove()
    if (block.lastChild instanceof HTMLBRElement) block.lastChild.remove()
    block.after(wrapper)
    const paragraph = document.createElement('p')
    paragraph.append(fragment)
    wrapper.after(paragraph)
  } else if (hasBefore) {
    block.after(wrapper)
  } else if (hasAfter) {
    block.before(wrapper)
  } else {
    block.replaceWith(wrapper)
  }

  if (code) placeCaretInside(code)
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
  if (applyCodeFenceRule(root)) return
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
  if (!block || block.tagName === 'LI' || block.tagName === 'PRE') return false

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
