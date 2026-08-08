<script lang="ts">
  import { onMount } from 'svelte'
  import {
    applyMarkdownInputRule,
    formatRichSelection,
    insertMarkdownLineBreak,
    insertPlainText,
    placeCaretAtEnd,
    placeCaretInside,
    renderRichMarkdown,
    selectedBlockTag,
    serializeRichMarkdown,
    syncCodeBlockLanguages,
    unlistListItem
  } from './rich-markdown'
  import type { RichInlineBadge } from './rich-markdown'

  interface Props {
    id?: string
    value?: string
    placeholder?: string
    ariaLabel?: string
    class?: string
    containerClass?: string
    autofocus?: boolean
    disabled?: boolean
    submitOnEnter?: boolean
    onValueChange?: (value: string) => void
    onSubmit?: (direct?: boolean) => void
    onPaste?: (event: ClipboardEvent) => void
    inlineBadges?: readonly RichInlineBadge[]
    onCaretTextChange?: (textBeforeCaret: string, supportsCommands: boolean) => void
  }

  let {
    id,
    value = $bindable(''),
    placeholder = 'Write feedback…',
    ariaLabel = 'Markdown editor',
    class:
      className = 'max-h-40 min-h-10 w-full overflow-y-auto px-3.5 pt-3 pb-1 text-sm leading-5 text-foreground outline-none',
    containerClass = '',
    autofocus = false,
    disabled = false,
    submitOnEnter = false,
    onValueChange,
    onSubmit,
    onPaste,
    inlineBadges = [],
    onCaretTextChange
  }: Props = $props()

  let editor: HTMLDivElement | undefined
  let empty = $state(!value.trim())
  let editorValue = value
  let editorBadgeSignature = ''
  const HISTORY_LIMIT = 100
  const HISTORY_MERGE_MS = 300

  interface SelectionBookmark {
    anchor: number
    focus: number
  }

  interface HistoryEntry {
    markdown: string
    html: string
    selection: SelectionBookmark | null
  }

  let undoHistory: HistoryEntry[] = []
  let redoHistory: HistoryEntry[] = []
  let pendingHistory: HistoryEntry | null = null
  let lastHistoryInputType: string | null = null
  let lastHistoryAt = 0

  function nodeLength(node: Node): number {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0
    if (node instanceof HTMLBRElement) return 1
    if (node instanceof HTMLElement && node.dataset.editorInlineBadge === 'true') {
      return node.dataset.editorValue?.length ?? 0
    }
    return Array.from(node.childNodes).reduce((total, child) => total + nodeLength(child), 0)
  }

  function pointOffset(root: Node, target: Node, targetOffset: number): number | null {
    let offset = 0

    function visit(node: Node): boolean {
      if (node === target) {
        if (node.nodeType === Node.TEXT_NODE) {
          offset += Math.min(targetOffset, node.textContent?.length ?? 0)
        } else {
          const children = Array.from(node.childNodes).slice(0, targetOffset)
          offset += children.reduce((total, child) => total + nodeLength(child), 0)
        }
        return true
      }
      if (node.nodeType === Node.TEXT_NODE) {
        offset += node.textContent?.length ?? 0
        return false
      }
      if (node instanceof HTMLBRElement) {
        offset += 1
        return false
      }
      for (const child of Array.from(node.childNodes)) {
        if (visit(child)) return true
      }
      return false
    }

    return visit(root) ? offset : null
  }

  function pointAtOffset(root: Node, requestedOffset: number): { node: Node; offset: number } {
    let remaining = Math.max(0, requestedOffset)

    function visit(node: Node): { node: Node; offset: number } | null {
      if (node.nodeType === Node.TEXT_NODE) {
        const length = node.textContent?.length ?? 0
        if (remaining <= length) return { node, offset: remaining }
        remaining -= length
        return null
      }
      if (node instanceof HTMLBRElement) {
        if (remaining === 0 && node.parentNode) {
          return {
            node: node.parentNode,
            offset: Array.from(node.parentNode.childNodes).indexOf(node)
          }
        }
        remaining = Math.max(0, remaining - 1)
        return null
      }
      if (node instanceof HTMLElement && node.dataset.editorInlineBadge === 'true') {
        const parent = node.parentNode
        const index = parent ? Array.from(parent.childNodes).indexOf(node) : -1
        const length = node.dataset.editorValue?.length ?? 0
        if (parent && index >= 0 && remaining <= length) {
          return { node: parent, offset: index + (remaining === 0 ? 0 : 1) }
        }
        remaining = Math.max(0, remaining - length)
        return null
      }
      for (const child of Array.from(node.childNodes)) {
        const point = visit(child)
        if (point) return point
      }
      return null
    }

    return visit(root) ?? { node: root, offset: root.childNodes.length }
  }

  function captureSelection(): SelectionBookmark | null {
    if (!editor) return null
    const selection = window.getSelection()
    if (
      !selection?.anchorNode ||
      !selection.focusNode ||
      !editor.contains(selection.anchorNode) ||
      !editor.contains(selection.focusNode)
    ) {
      return null
    }
    const anchor = pointOffset(editor, selection.anchorNode, selection.anchorOffset)
    const focus = pointOffset(editor, selection.focusNode, selection.focusOffset)
    return anchor === null || focus === null ? null : { anchor, focus }
  }

  function restoreSelection(bookmark: SelectionBookmark | null): void {
    if (!editor || !bookmark) return
    const selection = window.getSelection()
    if (!selection) return
    const anchor = pointAtOffset(editor, bookmark.anchor)
    const focus = pointAtOffset(editor, bookmark.focus)
    selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
  }

  /** Visible characters in a text node — zero-width caret anchors are stripped by
   *  serialization, so they must never shift a bookmark across a serialize → re-render
   *  round trip (which always drops them from the DOM). */
  function visibleTextLength(text: string | null | undefined): number {
    return (text ?? '').replace(/\u200b/g, '').length
  }

  /** Characters of a node up to an offset, ignoring zero-width anchors. */
  function visibleCharsBefore(text: string, offset: number): number {
    let count = 0
    const length = Math.min(offset, text.length)
    for (let index = 0; index < length; index += 1) {
      if (text.charCodeAt(index) !== 0x200b) count += 1
    }
    return count
  }

  function nodeVisibleLength(node: Node): number {
    if (node.nodeType === Node.TEXT_NODE) return visibleTextLength(node.textContent)
    if (node instanceof HTMLBRElement) return 1
    if (node instanceof HTMLElement && node.dataset.editorInlineBadge === 'true') {
      return node.dataset.editorValue?.length ?? 0
    }
    return Array.from(node.childNodes).reduce((total, child) => total + nodeVisibleLength(child), 0)
  }

  /** Caret position measured in the same coordinates a freshly re-rendered editor
   *  will use (zero-width anchors are absent there), so a bookmark taken on the old
   *  DOM lands exactly where the caret belongs after `replaceEditorContent`. */
  function pointVisibleOffset(root: Node, target: Node, targetOffset: number): number | null {
    let offset = 0

    function visit(node: Node): boolean {
      if (node === target) {
        if (node.nodeType === Node.TEXT_NODE) {
          offset += visibleCharsBefore(node.textContent ?? '', targetOffset)
        } else {
          const children = Array.from(node.childNodes).slice(0, targetOffset)
          offset += children.reduce((total, child) => total + nodeVisibleLength(child), 0)
        }
        return true
      }
      if (node.nodeType === Node.TEXT_NODE) {
        offset += visibleTextLength(node.textContent)
        return false
      }
      if (node instanceof HTMLBRElement) {
        offset += 1
        return false
      }
      for (const child of Array.from(node.childNodes)) {
        if (visit(child)) return true
      }
      return false
    }

    return visit(root) ? offset : null
  }

  /** Bookmarks the current caret in visible coordinates so it survives a full
   *  re-render of the editor content. */
  function captureVisibleSelection(): SelectionBookmark | null {
    if (!editor) return null
    const selection = window.getSelection()
    if (
      !selection?.anchorNode ||
      !selection.focusNode ||
      !editor.contains(selection.anchorNode) ||
      !editor.contains(selection.focusNode)
    ) {
      return null
    }
    const anchor = pointVisibleOffset(editor, selection.anchorNode, selection.anchorOffset)
    const focus = pointVisibleOffset(editor, selection.focusNode, selection.focusOffset)
    return anchor === null || focus === null ? null : { anchor, focus }
  }

  function captureHistoryEntry(): HistoryEntry | null {
    if (!editor) return null
    return {
      markdown: serializeRichMarkdown(editor),
      html: editor.innerHTML,
      selection: captureSelection()
    }
  }

  function resetHistoryGroup(): void {
    lastHistoryInputType = null
    lastHistoryAt = 0
  }

  function commitHistory(entry: HistoryEntry | null, inputType?: string): void {
    if (!editor || !entry) return
    const markdown = serializeRichMarkdown(editor)
    if (markdown === entry.markdown && editor.innerHTML === entry.html) return

    const now = Date.now()
    const mergeable =
      inputType === 'insertText' ||
      inputType === 'deleteContentBackward' ||
      inputType === 'deleteContentForward'
    const merge =
      mergeable &&
      inputType === lastHistoryInputType &&
      now - lastHistoryAt <= HISTORY_MERGE_MS &&
      undoHistory.length > 0

    if (!merge) {
      undoHistory.push(entry)
      if (undoHistory.length > HISTORY_LIMIT) undoHistory.shift()
    }
    redoHistory = []
    lastHistoryInputType = mergeable ? inputType : null
    lastHistoryAt = mergeable ? now : 0
  }

  function publishHistoryEntry(entry: HistoryEntry): void {
    replaceEditorContent(entry.markdown, entry.html)
    restoreSelection(entry.selection)
    publishCaretText()
    if (entry.markdown === value) return
    value = entry.markdown
    onValueChange?.(entry.markdown)
  }

  function undo(): void {
    const entry = undoHistory.pop()
    const current = captureHistoryEntry()
    if (!entry || !current) return
    redoHistory.push(current)
    resetHistoryGroup()
    publishHistoryEntry(entry)
  }

  function redo(): void {
    const entry = redoHistory.pop()
    const current = captureHistoryEntry()
    if (!entry || !current) return
    undoHistory.push(current)
    if (undoHistory.length > HISTORY_LIMIT) undoHistory.shift()
    resetHistoryGroup()
    publishHistoryEntry(entry)
  }

  function badgeSignature(): string {
    return inlineBadges
      .map(
        (badge) =>
          `${badge.value}\u0000${badge.label}\u0000${badge.title}\u0000${badge.iconSrc ?? ''}`
      )
      .join('\u0001')
  }

  function replaceEditorContent(
    markdown: string,
    html = renderRichMarkdown(markdown, inlineBadges)
  ): void {
    if (!editor) return
    // The browser owns this contenteditable subtree; Svelte renders no children inside it.
    // eslint-disable-next-line svelte/no-dom-manipulating
    editor.innerHTML = html
    editorValue = markdown
    editorBadgeSignature = badgeSignature()
    empty = !markdown.trim()
  }

  function emitEditorValue(normalizeEmpty = false): void {
    if (!editor) return
    const markdown = serializeRichMarkdown(editor)
    editorValue = markdown
    empty = !markdown.trim()
    if (normalizeEmpty && empty && editor.firstElementChild?.tagName !== 'P') {
      // Normalize a fully deleted rich block back to one editable paragraph.
      // eslint-disable-next-line svelte/no-dom-manipulating
      editor.innerHTML = renderRichMarkdown('')
      placeCaretAtEnd(editor)
    }
    if (markdown === value) return
    value = markdown
    onValueChange?.(markdown)
  }

  function publishCaretText(): void {
    if (!editor || !onCaretTextChange) return
    const selection = window.getSelection()
    if (
      !selection?.isCollapsed ||
      !selection.anchorNode ||
      !editor.contains(selection.anchorNode)
    ) {
      onCaretTextChange('', false)
      return
    }
    const anchorElement =
      selection.anchorNode instanceof Element
        ? selection.anchorNode
        : selection.anchorNode.parentElement
    const supportsCommands = !anchorElement?.closest(
      '[data-editor-codeblock], [data-editor-inline-badge], [data-editor-special], table, pre, code'
    )
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.setEnd(selection.anchorNode, selection.anchorOffset)
    onCaretTextChange(range.toString(), supportsCommands)
  }

  export function replaceTextBeforeCaret(
    pattern: RegExp,
    replacement: (...match: string[]) => string
  ): boolean {
    if (!editor) return false
    const selection = window.getSelection()
    if (!selection?.isCollapsed || !(selection.anchorNode instanceof Text)) return false
    const textNode = selection.anchorNode
    if (!editor.contains(textNode)) return false
    const prefix = textNode.data.slice(0, selection.anchorOffset)
    const match = prefix.match(pattern)
    if (!match || match.index === undefined || match.index + match[0].length !== prefix.length) {
      return false
    }

    const historyEntry = captureHistoryEntry()
    const insertedText = replacement(...match)
    textNode.replaceData(match.index, match[0].length, insertedText)
    const nextOffset = match.index + insertedText.length
    selection.setBaseAndExtent(textNode, nextOffset, textNode, nextOffset)
    emitEditorValue()
    commitHistory(historyEntry)
    publishCaretText()
    return true
  }

  function handleInput(event: Event): void {
    if (!editor) return
    const inputEvent = event as InputEvent
    applyMarkdownInputRule(editor)
    syncCodeBlockLanguages(editor)
    emitEditorValue(inputEvent.inputType.startsWith('delete'))
    commitHistory(pendingHistory, inputEvent.inputType)
    pendingHistory = null
    publishCaretText()
  }

  function handleBeforeInput(event: Event): void {
    const inputEvent = event as InputEvent
    if (inputEvent.inputType === 'historyUndo' || inputEvent.inputType === 'historyRedo') {
      inputEvent.preventDefault()
      if (inputEvent.inputType === 'historyUndo') undo()
      else redo()
      return
    }
    pendingHistory = captureHistoryEntry()
  }

  const INLINE_BOUNDARY_TAGS = new Set(['CODE', 'STRONG', 'B', 'EM', 'I', 'DEL', 'S', 'STRIKE'])

  function nodeHasVisibleContent(node: Node): boolean {
    if (node.nodeType === Node.TEXT_NODE) {
      return (node.textContent ?? '').replace(/[\u200b\u00a0]/g, '').trim().length > 0
    }
    if (node instanceof HTMLBRElement) return false
    return true
  }

  /** The inline element whose very start (left) or very end (right) the collapsed
   *  caret is sitting at, or null when the caret is not on such a boundary. */
  function inlineElementAtBoundary(left: boolean): HTMLElement | null {
    if (!editor) return null
    const selection = window.getSelection()
    if (!selection?.isCollapsed || !selection.anchorNode) return null
    const anchor = selection.anchorNode
    let element: HTMLElement | null
    if (anchor instanceof Text) {
      element = anchor.parentElement
    } else if (anchor instanceof HTMLElement) {
      // Caret collapsed directly inside an inline element that has no text child at the
      // caret, e.g. an empty <code></code>. The element itself is the anchor node.
      element = anchor
    } else {
      return null
    }
    if (!(element instanceof HTMLElement) || !editor.contains(element)) return null
    if (!INLINE_BOUNDARY_TAGS.has(element.tagName)) return null
    // Ignore <code> inside <pre> — code-block content has its own boundary rules.
    if (element.parentElement?.tagName === 'PRE') return null
    const offset = selection.anchorOffset
    // A boundary is the position where no text remains before (left) or after (right)
    // the caret inside the element — even if the element ends in a <br> or is empty.
    const boundary = left
      ? !hasTextBefore(element, anchor, offset)
      : !hasTextAfter(element, anchor, offset)
    if (!boundary) return null
    return element
  }

  function hasRealAdjacentContent(element: HTMLElement, left: boolean): boolean {
    let sibling = left ? element.previousSibling : element.nextSibling
    while (sibling) {
      if (nodeHasVisibleContent(sibling)) return true
      sibling = left ? sibling.previousSibling : sibling.nextSibling
    }
    return false
  }

  function moveCaretOutOfInlineElement(left: boolean, element: HTMLElement): void {
    if (!editor) return
    let anchor: Text | null
    if (left) {
      const prev = element.previousSibling
      if (prev instanceof Text && /^[\u200b]+$/u.test(prev.data)) {
        anchor = prev
      } else {
        element.before(document.createTextNode('\u200b'))
        anchor = element.previousSibling instanceof Text ? element.previousSibling : null
      }
    } else {
      const next = element.nextSibling
      if (next instanceof Text && /^[\u200b]+$/u.test(next.data)) {
        anchor = next
      } else {
        element.after(document.createTextNode('\u200b'))
        anchor = element.nextSibling instanceof Text ? element.nextSibling : null
      }
    }
    if (!anchor) return
    const selection = window.getSelection()
    if (!selection) return
    const range = document.createRange()
    range.setStart(anchor, left ? 0 : 1)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (!editor) return
    const modifier = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()

    if (modifier && key === 'z') {
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
      return
    }
    if (event.ctrlKey && !event.metaKey && key === 'y') {
      event.preventDefault()
      redo()
      return
    }

    if (modifier && (key === 'b' || key === 'i' || key === 'e')) {
      const tag = key === 'b' ? 'strong' : key === 'i' ? 'em' : 'code'
      const historyEntry = captureHistoryEntry()
      if (formatRichSelection(editor, tag)) {
        event.preventDefault()
        emitEditorValue()
        commitHistory(historyEntry)
      }
      return
    }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const left = event.key === 'ArrowLeft'
      const inlineElement = inlineElementAtBoundary(left)
      if (inlineElement && !hasRealAdjacentContent(inlineElement, left)) {
        event.preventDefault()
        moveCaretOutOfInlineElement(left, inlineElement)
        return
      }
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const selection = window.getSelection()
      const codeBlock = selection?.anchorNode?.parentElement?.closest?.(
        '[data-editor-codeblock]'
      ) as HTMLElement | null
      if (codeBlock) {
        const codeEl = codeBlock.querySelector('code')
        if (!codeEl) return
        const atEnd = event.key === 'ArrowDown' && isCursorAtBoundary(codeEl, false)
        const atStart = event.key === 'ArrowUp' && isCursorAtBoundary(codeEl, true)
        if (atEnd || atStart) {
          event.preventDefault()
          const p = document.createElement('p')
          p.innerHTML = '<br>'
          if (atEnd) {
            codeBlock.parentNode?.insertBefore(p, codeBlock.nextSibling)
          } else {
            codeBlock.parentNode?.insertBefore(p, codeBlock)
          }
          emitEditorValue()
          placeCaretAtEnd(p)
          return
        }
      }
    }

    if (event.key === 'Backspace') {
      const selection = window.getSelection()
      if (!selection?.isCollapsed || !selection.anchorNode) return
      const node = selection.anchorNode
      const block = node instanceof HTMLElement ? node : node.parentElement
      const paragraph = block?.closest?.('p, h1, h2, h3, h4, h5, h6, li') as HTMLElement | null
      if (!paragraph || !editor?.contains(paragraph) || paragraph === editor) return
      const prevSibling = paragraph.previousElementSibling as HTMLElement | null
      if (prevSibling?.dataset?.editorCodeblock === 'true' && isCursorAtBoundary(paragraph, true)) {
        event.preventDefault()
        deleteCodeBlock(prevSibling)
        return
      }
      if (paragraph.tagName === 'LI' && isCursorAtBoundary(paragraph, true)) {
        const historyEntry = captureHistoryEntry()
        if (unlistListItem(editor, paragraph)) {
          event.preventDefault()
          emitEditorValue()
          commitHistory(historyEntry)
          publishCaretText()
        }
      }
    }

    if (event.key === 'Enter') {
      const selection = window.getSelection()
      const codeBlock = selection?.anchorNode?.parentElement?.closest?.(
        '[data-editor-codeblock]'
      ) as HTMLElement | null

      if (codeBlock) {
        event.preventDefault()

        const langSpan = selection?.anchorNode?.parentElement?.closest?.('.code-lang-indicator')
        if (langSpan) {
          const code = codeBlock.querySelector('code')
          if (code) {
            code.focus()
            placeCaretAtEnd(code)
          }
          return
        }

        const historyEntry = captureHistoryEntry()
        if (selection?.rangeCount) {
          const range = selection.getRangeAt(0)
          range.deleteContents()
          const br = document.createElement('br')
          range.insertNode(br)
          range.setStartAfter(br)
          range.collapse(true)
          selection.removeAllRanges()
          selection.addRange(range)
        }
        emitEditorValue()
        commitHistory(historyEntry)
        return
      }

      const blockTag = selectedBlockTag(editor)

      if (event.shiftKey && submitOnEnter) {
        const historyEntry = captureHistoryEntry()
        if (insertMarkdownLineBreak(editor)) {
          event.preventDefault()
          emitEditorValue()
          commitHistory(historyEntry)
        }
        return
      }

      if (blockTag === 'PRE') {
        event.preventDefault()
        return
      }
    }
    if (event.key !== 'Enter' || !onSubmit) return
    if (modifier) {
      event.preventDefault()
      onSubmit(true)
      return
    }
    const blockTag = selectedBlockTag(editor)
    if (!submitOnEnter || (blockTag !== 'P' && blockTag !== 'DIV')) return
    event.preventDefault()
    onSubmit()
  }

  function nodeHasText(node: Node): boolean {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').length > 0
    if (node instanceof HTMLElement) return Array.from(node.childNodes).some(nodeHasText)
    return false
  }

  function childIndexOf(parent: Node, child: Node): number {
    return Array.from(parent.childNodes).findIndex((node) => node === child)
  }

  function hasTextBefore(root: HTMLElement, container: Node, offset: number): boolean {
    if (container.nodeType === Node.TEXT_NODE) {
      if (offset > 0) return true
      const parent = container.parentNode
      return parent ? hasTextBefore(root, parent, childIndexOf(parent, container)) : false
    }
    const children = Array.from(container.childNodes)
    for (let index = offset - 1; index >= 0; index -= 1) {
      if (nodeHasText(children[index])) return true
    }
    if (container === root) return false
    const parent = container.parentNode
    return parent ? hasTextBefore(root, parent, childIndexOf(parent, container)) : false
  }

  function hasTextAfter(root: HTMLElement, container: Node, offset: number): boolean {
    if (container.nodeType === Node.TEXT_NODE) {
      if (offset < (container.textContent?.length ?? 0)) return true
      const parent = container.parentNode
      return parent ? hasTextAfter(root, parent, childIndexOf(parent, container) + 1) : false
    }
    const children = Array.from(container.childNodes)
    for (let index = offset; index < children.length; index += 1) {
      if (nodeHasText(children[index])) return true
    }
    if (container === root) return false
    const parent = container.parentNode
    return parent ? hasTextAfter(root, parent, childIndexOf(parent, container) + 1) : false
  }

  function isCursorAtBoundary(element: HTMLElement, start: boolean): boolean {
    const selection = window.getSelection()
    if (!selection?.rangeCount || !element.contains(selection.anchorNode)) return false
    const range = selection.getRangeAt(0)
    return start
      ? !hasTextBefore(element, range.startContainer, range.startOffset)
      : !hasTextAfter(element, range.endContainer, range.endOffset)
  }

  function deleteCodeBlock(codeBlock: HTMLElement): void {
    if (!editor) return
    const previous = codeBlock.previousElementSibling as HTMLElement | null
    const next = codeBlock.nextElementSibling as HTMLElement | null
    const historyEntry = captureHistoryEntry()
    codeBlock.remove()
    if (!editor.firstElementChild) {
      // eslint-disable-next-line svelte/no-dom-manipulating
      editor.innerHTML = renderRichMarkdown('')
    }
    emitEditorValue(true)
    commitHistory(historyEntry)
    editor.focus()
    const target = previous ?? next
    if (target) placeCaretInside(target)
    else placeCaretAtEnd(editor)
  }

  function handleEditorClick(event: MouseEvent): void {
    if (!editor) return
    const target = event.target as HTMLElement | null
    const deleteButton = target?.closest<HTMLElement>('[data-editor-codeblock-delete]')
    if (!deleteButton) {
      publishCaretText()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const codeBlock = deleteButton.closest<HTMLElement>('[data-editor-codeblock]')
    if (!codeBlock || !editor.contains(codeBlock)) return
    deleteCodeBlock(codeBlock)
    publishCaretText()
  }

  function handlePaste(event: ClipboardEvent): void {
    onPaste?.(event)
    if (event.defaultPrevented || !editor) return
    const text = event.clipboardData?.getData('text/plain')
    if (text === undefined) return
    const historyEntry = captureHistoryEntry()
    event.preventDefault()
    insertPlainText(editor, text)
    const insideCodeBlock = Boolean(
      window.getSelection()?.anchorNode?.parentElement?.closest?.('[data-editor-codeblock]')
    )
    if (insideCodeBlock) {
      // Pasting while the caret is inside a code block: insertPlainText already
      // placed the text inside the <code> element and left the caret there, so a
      // full serialize → re-render → caret-at-end round trip would eject the caret
      // out of the block. Keep the caret put and just publish the new value.
      emitEditorValue()
      commitHistory(historyEntry)
      publishCaretText()
      return
    }
    const markdown = serializeRichMarkdown(editor)
    // `insertPlainText` leaves the caret right after the pasted text. Re-rendering
    // the whole editor would otherwise drop that caret to the end of the document,
    // so bookmark it first and restore it onto the freshly rendered content.
    const bookmark = captureVisibleSelection()
    replaceEditorContent(markdown)
    if (bookmark) restoreSelection(bookmark)
    else placeCaretAtEnd(editor)
    if (markdown !== value) {
      value = markdown
      onValueChange?.(markdown)
    }
    commitHistory(historyEntry)
    publishCaretText()
  }

  onMount(() => {
    replaceEditorContent(value)
    if (autofocus && editor) {
      editor.focus()
      placeCaretAtEnd(editor)
      publishCaretText()
    }
  })

  $effect(() => {
    const externalValue = value
    const externalBadgeSignature = badgeSignature()
    if (
      !editor ||
      (externalValue === editorValue && externalBadgeSignature === editorBadgeSignature)
    ) {
      return
    }
    const valueChanged = externalValue !== editorValue
    const selection = captureSelection()
    replaceEditorContent(externalValue)
    restoreSelection(selection)
    publishCaretText()
    if (!valueChanged) return
    undoHistory = []
    redoHistory = []
    pendingHistory = null
    resetHistoryGroup()
  })
</script>

<div class="relative {containerClass}">
  {#if empty}
    <span
      aria-hidden="true"
      class="pointer-events-none absolute top-3 left-3.5 text-sm leading-5 text-dimmed"
    >
      {placeholder}
    </span>
  {/if}
  <div
    {id}
    bind:this={editor}
    class="rich-markdown-editor {className} {disabled ? 'cursor-not-allowed opacity-60' : ''}"
    contenteditable={!disabled}
    role="textbox"
    aria-label={ariaLabel}
    aria-multiline="true"
    aria-disabled={disabled}
    tabindex={disabled ? -1 : 0}
    spellcheck="true"
    onbeforeinput={handleBeforeInput}
    oninput={handleInput}
    onkeydown={handleKeydown}
    onkeyup={publishCaretText}
    onpaste={handlePaste}
    onclick={handleEditorClick}
  ></div>
</div>
