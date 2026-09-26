<script lang="ts">
  import { onMount } from 'svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import {
    applyCodeFenceOnEnter,
    applyEmptyPairCodeRule,
    applyMarkdownInputRule,
    caretBlock,
    exitEmptyListItemOnEnter,
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
  import type { MarkdownRuleKind, RichInlineBadge } from './rich-markdown'
  import {
    demoteSmartPunctuation,
    flattenWithNewlines,
    hasRealAdjacentContent,
    inlineElementAtBoundary,
    isCursorAtBoundary,
    moveCaretOutOfInlineElement,
    nodeLength,
    pointAtOffset,
    pointOffset,
    type SelectionBookmark
  } from './rich-markdown-editor-dom'
  import { RichMarkdownEditorHistory } from './rich-markdown-editor-history.svelte'
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
     *  `direct` is true for the steer combo, false/undefined for plain send  
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
  const history = new RichMarkdownEditorHistory({
    getEditor: () => editor,
    serialize: (node) => serializeRichMarkdown(node),
    captureSelection,
    applyEntry: (entry) => {
      replaceEditorContent(entry.markdown, entry.html)
      restoreSelection(entry.selection)
      publishCaretText()
      holdRevertedRule(entry.revertedRule)
    },
    getValue: () => value,
    setValue: (next) => {
      value = next
    },
    onValueChange: (next) => onValueChange?.(next),
    publishState: (canUndo, canRedo) => onHistoryStateChange?.({ canUndo, canRedo })
  })

  /** Most recent caret position seen inside this editor. Tracked on every
   *  selection change (including while focus sits elsewhere, e.g. a menu or a
   *  modal) so focus-return flows can restore the caret exactly where the user
   *  left it instead of jumping to the end. */
  let lastSelectionBookmark: SelectionBookmark | null = null

  /** The block whose last undo reverted an auto-conversion, plus the rule the
   *  user already turned down there. Word-processor behaviour: after undoing
   *  the conversion, typing on in that same paragraph must not convert again.
   *  Dropped as soon as the caret works in another block. */
  let revertedRuleHold: { block: HTMLElement; kind: MarkdownRuleKind } | null = null

  function isRuleSuppressed(block: HTMLElement | null, kind: MarkdownRuleKind): boolean {
    const hold = revertedRuleHold
    if (!block || !hold) return false
    if (hold.block !== block || !hold.block.isConnected) {
      revertedRuleHold = null
      return false
    }
    return hold.kind === kind
  }

  function holdRevertedRule(kind: MarkdownRuleKind | undefined): void {
    if (!kind || !editor) {
      revertedRuleHold = null
      return
    }
    const block = caretBlock(editor)
    revertedRuleHold = block ? { block, kind } : null
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
    if (anchor === null || focus === null) return null
    const bookmark = { anchor, focus }
    lastSelectionBookmark = bookmark
    return bookmark
  }

  /** Bookmark of the caret's latest position inside this editor   the live
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
    const historyEntry = history.captureEntry()
    restoreSelection(snapshot.selection)
    insertPlainText(editor, transcript)
    emitEditorValue(true)
    history.commit(historyEntry)
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

  function handleSelectionChange(): void {
    captureSelection()
  }

  function badgeSignature(): string {
    return inlineBadges
      .map(
        (badge) =>
          `${badge.value}\u0000${badge.label}\u0000${badge.title}\u0000${badge.iconSvg ?? ''}`
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

    const historyEntry = history.captureEntry()
    const insertedText = replacement(...match)
    textNode.replaceData(match.index, match[0].length, insertedText)
    const nextOffset = match.index + insertedText.length
    selection.setBaseAndExtent(textNode, nextOffset, textNode, nextOffset)
    emitEditorValue()
    history.commit(historyEntry)
    publishCaretText()
    return true
  }

  function handleInput(event: Event): void {
    if (!editor) return
    const inputEvent = event as InputEvent
    // Two snapshots: `pending` is the state before the browser inserted this
    // input (the plain undo target), `typed` is the state right after it, before
    // any input rule rewrote the DOM   the literal text the user typed, which
    // undo restores when a rule fired.
    const pending = history.consumePending()
    const typed = history.captureEntry()
    const revertedRule = applyMarkdownInputRule(editor, { isRuleSuppressed })
    syncCodeBlockLanguages(editor)
    emitEditorValue(inputEvent.inputType.startsWith('delete'))
    if (revertedRule) {
      if (typed) typed.revertedRule = revertedRule
      history.commit(typed, inputEvent.inputType, true)
    } else {
      history.commit(pending, inputEvent.inputType)
    }
    publishCaretText()
  }

  function handleBeforeInput(event: Event): void {
    const inputEvent = event as InputEvent
    if (inputEvent.inputType === 'historyUndo' || inputEvent.inputType === 'historyRedo') {
      inputEvent.preventDefault()
      if (inputEvent.inputType === 'historyUndo') history.undo()
      else history.redo()
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
        inputEvent.preventDefault()
        insertRawAtSelection(text)
        return
      }
    }
    history.setPending(history.captureEntry())
  }

  /** Inserts `text` verbatim at the caret (replacing any selection), recording
   *  it in undo history. Used to override smart substitution. */
  function insertRawAtSelection(text: string): void {
    const historyEntry = history.captureEntry()
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
    history.commit(historyEntry, 'insertText')
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (!editor) return

    if (keymapState.matches('editor-redo', event)) {
      event.preventDefault()
      history.redo()
      return
    }
    if (keymapState.matches('editor-undo', event)) {
      event.preventDefault()
      history.undo()
      return
    }

    // A backtick typed at the end of an inline code span closes it: the caret
    // moves after the span instead of the backtick nesting inside the code.
    // Only for a collapsed caret sitting at the span's very end   mid-span and
    // multi-selection typing stays literal.
    if (keymapState.matches('editor-inline-code-close', event)) {
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

    const formatTag = keymapState.matches('editor-bold', event)
      ? 'strong'
      : keymapState.matches('editor-italic', event)
        ? 'em'
        : keymapState.matches('editor-code', event)
          ? 'code'
          : null
    if (formatTag) {
      const historyEntry = history.captureEntry()
      if (formatRichSelection(editor, formatTag)) {
        event.preventDefault()
        emitEditorValue()
        history.commit(historyEntry)
      }
      return
    }

    // Shift+Arrow never moves the caret by hand: the browser's own extended
    // selection must run untouched. Intercepting here (e.g. exiting an inline
    // token or a leading/trailing code block) would collapse the selection the
    // user is trying to build   exactly the breakage seen after pasting content
    // that renders as one of those structures.
    if (!event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      const left = event.key === 'ArrowLeft'
      const inlineElement = inlineElementAtBoundary(editor, left)
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
      // trailing code block (or before a leading one)   e.g. after pasting text
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

    if (keymapState.matches('editor-unlist', event)) {
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
        const historyEntry = history.captureEntry()
        if (unlistListItem(editor, paragraph)) {
          event.preventDefault()
          emitEditorValue()
          history.commit(historyEntry)
          publishCaretText()
        }
      }
    }

    if (event.key === 'Enter') {
      const selection = window.getSelection()
      const codeBlock = selection?.anchorNode?.parentElement?.closest?.(
        '[data-editor-codeblock]'
      ) as HTMLElement | null

      if (codeBlock && keymapState.matches('editor-codeblock-newline', event)) {
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

        const historyEntry = history.captureEntry()
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
        history.commit(historyEntry)
        return
      }

      // Cmd/Ctrl+Enter sends; Cmd/Ctrl+Shift+Enter force-sends (steers) the
      // message into the live turn mid-turn. Checked before the Shift+Enter
      // soft-break branch so the modifier combos always submit instead of
      // inserting a newline. A bare Enter never submits.
      if (
        onSubmit &&
        (keymapState.matches('chat-send', event) || keymapState.matches('chat-steer', event))
      ) {
        event.preventDefault()
        onSubmit(keymapState.matches('chat-steer', event))
        return
      }

      // Two Enter-time block rewrites that must not fight the browser's default
      // insert: ``` fences materialize here rather than while typing (a block
      // whose text is ```lang, ```content``` or ```lang\ncontent``` becomes a
      // code block), and Enter on an empty list item leaves the list instead of
      // appending another empty item.
      const historyEntry = history.captureEntry()
      if (keymapState.matches('editor-code-fence', event) && applyCodeFenceOnEnter(editor)) {
        event.preventDefault()
        emitEditorValue(true)
        history.commit(historyEntry)
        publishCaretText()
        return
      }
      if (
        keymapState.matches('editor-exit-empty-list', event) &&
        exitEmptyListItemOnEnter(editor)
      ) {
        event.preventDefault()
        emitEditorValue()
        history.commit(historyEntry)
        publishCaretText()
        return
      }

      const blockTag = selectedBlockTag(editor)

      // Shift+Enter always inserts a soft line break (never a new list item,
      // never a submit)   regardless of whether this editor can submit.
      if (keymapState.matches('chat-soft-break', event)) {
        const historyEntry = history.captureEntry()
        if (insertMarkdownLineBreak(editor)) {
          event.preventDefault()
          emitEditorValue()
          history.commit(historyEntry)
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

  function deleteCodeBlock(codeBlock: HTMLElement): void {
    if (!editor) return
    const previous = codeBlock.previousElementSibling as HTMLElement | null
    const next = codeBlock.nextElementSibling as HTMLElement | null
    const historyEntry = history.captureEntry()
    codeBlock.remove()
    if (!editor.firstElementChild) {
      // eslint-disable-next-line svelte/no-dom-manipulating
      editor.innerHTML = renderRichMarkdown('')
    }
    emitEditorValue(true)
    history.commit(historyEntry)
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

  function handlePaste(event: ClipboardEvent): void {
    onPaste?.(event)
    if (event.defaultPrevented || !editor) return
    const text = event.clipboardData?.getData('text/plain')
    if (text === undefined) return
    const historyEntry = history.captureEntry()
    event.preventDefault()
    insertPlainText(editor, text)
    // Pasting content right after a fresh `` pair opens an inline code span,
    // exactly like typing the first character there would.
    applyEmptyPairCodeRule(editor)
    // Insert the clipboard text verbatim and leave every other block in the
    // document exactly as the user wrote it. Serializing the whole editor and
    // re-rendering it here would re-parse every untouched block as markdown and
    // silently reformat text the user already typed   a literal `2. item` line
    // becomes an ordered list, `x * y * z` becomes emphasis, a mid-paragraph `#`
    // becomes a heading. Nothing outside the pasted text may change on paste.
    // `insertPlainText` already parks the caret right after the inserted text,
    // so no re-render (and no caret bookmark dance) is needed.
    emitEditorValue()
    history.commit(historyEntry)
    publishCaretText()
  }

  onMount(() => {
    replaceEditorContent(value)
    onHistoryControllerChange?.({ undo: () => history.undo(), redo: () => history.redo() })
    history.publishState()
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
    history.clear()
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
    {...{ autocorrect: 'off' }}
    onbeforeinput={handleBeforeInput}
    oninput={handleInput}
    onkeydown={handleKeydown}
    onkeyup={publishCaretText}
    onpaste={handlePaste}
    onclick={handleEditorClick}
  ></div>
</div>
