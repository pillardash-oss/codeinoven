<script lang="ts">
  import { onMount } from 'svelte'
  import {
    applyCodeFenceOnEnter,
    applyEmptyPairCodeRule,
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
  import type {
    SpeechEditorApplyResult,
    SpeechEditorSnapshot,
    SpeechEditorTarget
  } from '../../speech/editor-target'

  interface HistoryController {
    undo: () => void
    redo: () => void
  }

  interface HistoryState {
    canUndo: boolean
    canRedo: boolean
  }

  interface Props {
    id?: string
    value?: string
    placeholder?: string
    ariaLabel?: string
    class?: string
    containerClass?: string
    autofocus?: boolean
    disabled?: boolean
    onValueChange?: (value: string) => void
    /** Fired only by Cmd/Ctrl+Enter (send) or Cmd/Ctrl+Shift+Enter (steer).
     *  `direct` is true for the steer combo, false/undefined for plain send —
     *  busy callers queue on send and force-deliver on steer. */
    onSubmit?: (direct?: boolean) => void
    onPaste?: (event: ClipboardEvent) => void
    inlineBadges?: readonly RichInlineBadge[]
    onCaretTextChange?: (textBeforeCaret: string, supportsCommands: boolean) => void
    onHistoryControllerChange?: (controller: HistoryController | null) => void
    onHistoryStateChange?: (state: HistoryState) => void
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
    onValueChange,
    onSubmit,
    onPaste,
    inlineBadges = [],
    onCaretTextChange,
    onHistoryControllerChange,
    onHistoryStateChange
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

  /** Length a non-editable inline token occupies in serialized markdown — inline
   *  badges keep their stored value, footnote superscripts their `[^label]`. */
  function inlineTokenLength(node: HTMLElement): number | null {
    if (node.dataset.editorInlineBadge === 'true') return node.dataset.editorValue?.length ?? 0
    const footnote = node.dataset.editorFootnoteRef
    if (footnote !== undefined) return footnote.length + 3
    return null
  }

  function nodeLength(node: Node): number {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0
    if (node instanceof HTMLBRElement) return 1
    if (node instanceof HTMLElement) {
      const tokenLength = inlineTokenLength(node)
      if (tokenLength !== null) return tokenLength
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
      if (node instanceof HTMLElement && inlineTokenLength(node) !== null) {
        const parent = node.parentNode
        const index = parent ? Array.from(parent.childNodes).indexOf(node) : -1
        const length = inlineTokenLength(node) ?? 0
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

  /** Most recent caret position seen inside this editor. Tracked on every
   *  selection change (including while focus sits elsewhere, e.g. a menu or a
   *  modal) so focus-return flows can restore the caret exactly where the user
   *  left it instead of jumping to the end. */
  let lastSelectionBookmark: SelectionBookmark | null = null

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
    if (anchor === null || focus === null) return null
    const bookmark = { anchor, focus }
    lastSelectionBookmark = bookmark
    return bookmark
  }

  /** Bookmark of the caret's latest position inside this editor — the live
   *  selection when it still points here, otherwise the last tracked position. */
  export function caretBookmark(): SelectionBookmark | null {
    return captureSelection() ?? lastSelectionBookmark
  }

  /** Focus the editor and restore the caret to `bookmark` (clamped to the
   *  current text length), falling back to the end when no bookmark exists.
   *  Used by focus-return flows after overlays (menus, previews, pickers)
   *  close, so typing resumes exactly where it left off. */
  export function focusAtBookmark(bookmark: SelectionBookmark | null): void {
    if (!editor) return
    editor.focus()
    if (!bookmark) {
      placeCaretAtEnd(editor)
      publishCaretText()
      return
    }
    const length = nodeLength(editor)
    const clamped: SelectionBookmark = {
      anchor: Math.min(bookmark.anchor, length),
      focus: Math.min(bookmark.focus, length)
    }
    restoreSelection(clamped)
    lastSelectionBookmark = clamped
    publishCaretText()
  }

  function restoreSelection(bookmark: SelectionBookmark | null): void {
    if (!editor || !bookmark) return
    const selection = window.getSelection()
    if (!selection) return
    const anchor = pointAtOffset(editor, bookmark.anchor)
    const focus = pointAtOffset(editor, bookmark.focus)
    selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
  }

  function dictationSnapshot(targetId: string): SpeechEditorSnapshot | null {
    if (!editor) return null
    const selection = captureSelection() ?? {
      anchor: nodeLength(editor),
      focus: nodeLength(editor)
    }
    return {
      targetId,
      value: serializeRichMarkdown(editor),
      selection,
      capturedAt: Date.now()
    }
  }

  function applyDictation(
    targetId: string,
    snapshot: SpeechEditorSnapshot,
    transcript: string
  ): SpeechEditorApplyResult {
    if (!editor) return { ok: false, reason: 'destroyed' }
    const before = serializeRichMarkdown(editor)
    if (snapshot.targetId !== targetId || before !== snapshot.value) {
      return { ok: false, reason: 'changed' }
    }
    const start = Math.min(snapshot.selection.anchor, snapshot.selection.focus)
    const end = Math.max(snapshot.selection.anchor, snapshot.selection.focus)
    if (start < 0 || end > nodeLength(editor)) return { ok: false, reason: 'invalid-selection' }
    const historyEntry = captureHistoryEntry()
    restoreSelection(snapshot.selection)
    insertPlainText(editor, transcript)
    emitEditorValue(true)
    commitHistory(historyEntry)
    publishCaretText()
    editor.focus()
    const after = serializeRichMarkdown(editor)
    let prefix = 0
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
      prefix += 1
    return {
      ok: true,
      value: after,
      startOffset: prefix,
      endOffset: prefix + transcript.length
    }
  }

  export function speechEditorTarget(targetId: string): SpeechEditorTarget {
    return {
      id: targetId,
      capture: () => dictationSnapshot(targetId),
      apply: (snapshot, transcript) => applyDictation(targetId, snapshot, transcript)
    }
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
    if (node instanceof HTMLElement) {
      const tokenLength = inlineTokenLength(node)
      if (tokenLength !== null) return tokenLength
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

  function publishHistoryState(): void {
    onHistoryStateChange?.({
      canUndo: undoHistory.length > 0,
      canRedo: redoHistory.length > 0
    })
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
    publishHistoryState()
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
    publishHistoryState()
  }

  function redo(): void {
    const entry = redoHistory.pop()
    const current = captureHistoryEntry()
    if (!entry || !current) return
    undoHistory.push(current)
    if (undoHistory.length > HISTORY_LIMIT) undoHistory.shift()
    resetHistoryGroup()
    publishHistoryEntry(entry)
    publishHistoryState()
  }

  function handleSelectionChange(): void {
    captureSelection()
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

  const BLOCK_BOUNDARY_SELECTOR =
    'p, div, li, ul, ol, blockquote, h1, h2, h3, h4, h5, h6, pre, table, tr'

  /**
   * Flattens editor content up to the caret, inserting '\n' at block
   * boundaries and `<br>`s. `Range.toString()` only concatenates text nodes,
   * so without this the first line gets glued to the second and the
   * `(^|\s)`-anchored slash/mention patterns stop matching off the first line.
   */
  function flattenWithNewlines(node: Node): string {
    if (node instanceof Text) return node.data
    if (node instanceof Element && node.tagName === 'BR') return '\n'
    let text = ''
    for (const child of node.childNodes) {
      const childText = flattenWithNewlines(child)
      if (
        childText !== '' &&
        text !== '' &&
        !text.endsWith('\n') &&
        child instanceof Element &&
        child.matches(BLOCK_BOUNDARY_SELECTOR)
      ) {
        text += '\n'
      }
      text += childText
    }
    return text
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
      '[data-editor-codeblock], [data-editor-inline-badge], [data-editor-footnote-ref], [data-editor-special], table, pre, code'
    )
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.setEnd(selection.anchorNode, selection.anchorOffset)
    onCaretTextChange(flattenWithNewlines(range.cloneContents()), supportsCommands)
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

  /** Rewrites macOS smart-punctuation substitutions back to the literal
   *  ASCII characters the user typed. A dev workspace needs real characters,
   *  not typographic ones. */
  function demoteSmartPunctuation(text: string): string {
    return text
      .replaceAll('…', '...')
      .replaceAll(/[\u2018\u2019\u201b]/gu, "'")
      .replaceAll(/[\u201c\u201d\u201f]/gu, '"')
      .replaceAll('\u2013', '-')
      .replaceAll('\u2014', '--')
  }

  function handleBeforeInput(event: Event): void {
    const inputEvent = event as InputEvent
    if (inputEvent.inputType === 'historyUndo' || inputEvent.inputType === 'historyRedo') {
      inputEvent.preventDefault()
      if (inputEvent.inputType === 'historyUndo') undo()
      else redo()
      return
    }
    // macOS smart substitution rewrites what the user typed before it reaches
    // the editable surface. Plain typing arrives as `insertText` with `data`,
    // but OS-level text replacements arrive as `insertReplacementText` where
    // `data` is null and the substituted text rides in `dataTransfer`. Catch
    // both and insert the raw literal sequence instead.
    const incomingText =
      inputEvent.inputType === 'insertText'
        ? inputEvent.data
        : inputEvent.inputType === 'insertReplacementText'
          ? (inputEvent.dataTransfer?.getData('text/plain') ?? null)
          : null
    if (incomingText !== null) {
      const text = demoteSmartPunctuation(incomingText)
      if (text !== incomingText) {
        insertRawAtSelection(text)
        return
      }
    }
    pendingHistory = captureHistoryEntry()
  }

  /** Inserts `text` verbatim at the caret (replacing any selection), recording
   *  it in undo history. Used to override smart substitution. */
  function insertRawAtSelection(text: string): void {
    const historyEntry = captureHistoryEntry()
    const selection = window.getSelection()
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0)
      range.deleteContents()
      const node = document.createTextNode(text)
      range.insertNode(node)
      range.setStartAfter(node)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    emitEditorValue()
    commitHistory(historyEntry, 'insertText')
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

    // A backtick typed at the end of an inline code span closes it: the caret
    // moves after the span instead of the backtick nesting inside the code.
    // Only for a collapsed caret sitting at the span's very end — mid-span and
    // multi-selection typing stays literal.
    if (event.key === '`') {
      const selection = window.getSelection()
      const codeEl = selection?.anchorNode?.parentElement?.closest?.('code')
      if (
        selection?.isCollapsed &&
        codeEl &&
        codeEl.parentElement?.tagName !== 'PRE' &&
        editor.contains(codeEl) &&
        isCursorAtBoundary(codeEl, false)
      ) {
        event.preventDefault()
        moveCaretOutOfInlineElement(false, codeEl)
        publishCaretText()
        return
      }
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

    // Shift+Arrow never moves the caret by hand: the browser's own extended
    // selection must run untouched. Intercepting here (e.g. exiting an inline
    // token or a leading/trailing code block) would collapse the selection the
    // user is trying to build — exactly the breakage seen after pasting content
    // that renders as one of those structures.
    if (!event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const left = event.key === 'ArrowLeft'
      const inlineElement = inlineElementAtBoundary(left)
      if (inlineElement && !hasRealAdjacentContent(inlineElement, left)) {
        event.preventDefault()
        moveCaretOutOfInlineElement(left, inlineElement)
        return
      }
    }

    if (!event.shiftKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const selection = window.getSelection()
      let codeBlock = selection?.anchorNode?.parentElement?.closest?.(
        '[data-editor-codeblock]'
      ) as HTMLElement | null
      // A collapsed caret can also sit at the editor level, stranded right after a
      // trailing code block (or before a leading one) — e.g. after pasting text
      // that ends in a code block, or when autofocus lands on a draft that ends in
      // one. ArrowDown/ArrowUp must still be able to exit the block then.
      const stranded =
        selection?.isCollapsed &&
        selection.anchorNode === editor &&
        ((event.key === 'ArrowDown' &&
          selection.anchorOffset === editor.childNodes.length &&
          editor.lastElementChild?.matches('[data-editor-codeblock]')) ||
          (event.key === 'ArrowUp' &&
            selection.anchorOffset === 0 &&
            editor.firstElementChild?.matches('[data-editor-codeblock]')))
      if (!codeBlock && stranded) {
        codeBlock = (
          event.key === 'ArrowDown' ? editor.lastElementChild : editor.firstElementChild
        ) as HTMLElement | null
      }
      if (codeBlock) {
        const codeEl = codeBlock.querySelector('code')
        if (!codeEl) return
        const atEnd = event.key === 'ArrowDown' && (stranded || isCursorAtBoundary(codeEl, false))
        const atStart = event.key === 'ArrowUp' && (stranded || isCursorAtBoundary(codeEl, true))
        if (atEnd || atStart) {
          event.preventDefault()
          const p = document.createElement('p')
          p.innerHTML = '<br>'
          if (atStart) {
            codeBlock.parentNode?.insertBefore(p, codeBlock)
          } else {
            codeBlock.parentNode?.insertBefore(p, codeBlock.nextSibling)
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

      // Cmd/Ctrl+Enter sends; Cmd/Ctrl+Shift+Enter force-sends (steers) the
      // message into the live turn mid-turn. Checked before the Shift+Enter
      // soft-break branch so the modifier combos always submit instead of
      // inserting a newline. A bare Enter never submits.
      if (modifier && onSubmit) {
        event.preventDefault()
        onSubmit(event.shiftKey)
        return
      }

      // ``` fences materialize on Enter, not while typing: a block whose text is
      // ```lang, ```content``` or ```lang\ncontent``` becomes a code block here.
      if (!event.shiftKey) {
        const historyEntry = captureHistoryEntry()
        if (applyCodeFenceOnEnter(editor)) {
          event.preventDefault()
          emitEditorValue(true)
          commitHistory(historyEntry)
          publishCaretText()
          return
        }
      }

      const blockTag = selectedBlockTag(editor)

      // Shift+Enter always inserts a soft line break (never a new list item,
      // never a submit) — regardless of whether this editor can submit.
      if (event.shiftKey) {
        const historyEntry = captureHistoryEntry()
        if (insertMarkdownLineBreak(editor)) {
          event.preventDefault()
          emitEditorValue()
          commitHistory(historyEntry)
          publishCaretText()
        }
        return
      }

      if (blockTag === 'PRE') {
        event.preventDefault()
        return
      }
    }
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
    if (deleteButton) {
      event.preventDefault()
      event.stopPropagation()
      const codeBlock = deleteButton.closest<HTMLElement>('[data-editor-codeblock]')
      if (!codeBlock || !editor.contains(codeBlock)) return
      deleteCodeBlock(codeBlock)
      publishCaretText()
      return
    }
    // Links render for recognition but must never navigate while editing.
    if (target?.closest('a[data-editor-link]')) {
      event.preventDefault()
      publishCaretText()
      return
    }
    publishCaretText()
  }

  /** Put the caret inside the final editable block. Collapsing a range at the
   *  editor root can strand it outside a trailing non-editable code wrapper. */
  function placeCaretAtEditorEnd(): void {
    if (!editor) return
    const lastBlock = editor.lastElementChild as HTMLElement | null
    if (!lastBlock) {
      placeCaretAtEnd(editor)
      return
    }
    if (lastBlock.matches('[data-editor-codeblock]')) {
      placeCaretAtEnd(lastBlock.querySelector('code') ?? lastBlock)
      return
    }
    placeCaretAtEnd(lastBlock)
  }

  function handlePaste(event: ClipboardEvent): void {
    onPaste?.(event)
    if (event.defaultPrevented || !editor) return
    const text = event.clipboardData?.getData('text/plain')
    if (text === undefined) return
    const historyEntry = captureHistoryEntry()
    const pasteEndsAtEditorEnd = isCursorAtBoundary(editor, false)
    event.preventDefault()
    insertPlainText(editor, text)
    // Pasting content right after a fresh `` pair opens an inline code span,
    // exactly like typing the first character there would.
    applyEmptyPairCodeRule(editor)
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
    // A paste whose tail renders as a fenced code block must never park the caret
    // inside or against the non-editable wrapper — typing, the slash menu and the
    // input rules all go dead there. Guarantee a trailing editable paragraph.
    if (editor.lastElementChild?.matches('[data-editor-codeblock]')) {
      const p = document.createElement('p')
      p.innerHTML = '<br>'
      // eslint-disable-next-line svelte/no-dom-manipulating
      editor.appendChild(p)
    }
    if (pasteEndsAtEditorEnd) placeCaretAtEditorEnd()
    else if (bookmark) restoreSelection(bookmark)
    else placeCaretAtEditorEnd()
    // The bookmark is measured on the pre-render DOM, which can be much longer than
    // the re-rendered markdown (fence markers, soft breaks and code headers collapse
    // away), so it overshoots and strands the caret at the editor level — typically
    // right after a trailing code block, where typing is impossible and ArrowDown
    // cannot leave the block. Snap a stranded caret to the end of the last block
    // (inside a trailing code block's <code> element), which is where the caret
    // belongs after a paste that ends in a code block.
    const selection = window.getSelection()
    if (selection?.anchorNode === editor && editor.lastElementChild) {
      placeCaretAtEditorEnd()
    }
    if (markdown !== value) {
      value = markdown
      onValueChange?.(markdown)
    }
    commitHistory(historyEntry)
    publishCaretText()
  }

  onMount(() => {
    replaceEditorContent(value)
    onHistoryControllerChange?.({ undo, redo })
    publishHistoryState()
    if (autofocus && editor) {
      editor.focus()
      placeCaretAtEnd(editor)
      publishCaretText()
    }
    // Track the caret even while focus sits elsewhere (menus, modals, pickers)
    // so focus-return flows can restore the exact last position.
    document.addEventListener('selectionchange', handleSelectionChange)
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange)
      onHistoryControllerChange?.(null)
      onHistoryStateChange?.({ canUndo: false, canRedo: false })
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
    publishHistoryState()
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
    {...{ autocorrect: 'false' }}
    onbeforeinput={handleBeforeInput}
    oninput={handleInput}
    onkeydown={handleKeydown}
    onkeyup={publishCaretText}
    onpaste={handlePaste}
    onclick={handleEditorClick}
  ></div>
</div>
