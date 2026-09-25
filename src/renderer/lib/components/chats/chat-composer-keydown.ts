import { isEscapeClaimed } from '$lib/stores/page-surface.svelte'
import { keymapState } from '$lib/keymap/keymap-state.svelte'
import type { ActionDefinition, ActionSelection } from '$lib/actions'
import type { ComposerMentionEntry } from './composer-mentions'

export interface ComposerKeydownContext {
  isMentionOpen(): boolean
  getMentionEntries(): ComposerMentionEntry[]
  getMentionIndex(): number
  setMentionIndex(index: number): void
  closeMentions(): void
  selectMention(mention: ComposerMentionEntry): void
  isSlashOpen(): boolean
  closeSlash(): void
  getSlashActions(): ActionDefinition[]
  getSlashIndex(): number
  setSlashIndex(index: number): void
  selectSlashAction(action: ActionDefinition, method: ActionSelection['method']): void
  isSelectionPopoverOpen(): boolean
  closeSelectionPopover(): void
  isStartAfterPopoverOpen(): boolean
  closeStartAfterPopover(): void
  getComposerElement(): HTMLElement | null
  getHistoryIndex(): number
  setHistoryIndex(index: number): void
  getSavedValue(): string
  setSavedValue(value: string): void
  getValue(): string
  setValue(value: string): void
  getHistoryMessages(): string[]
  onHistoryNavigateStart(): void
  onValueChange(value: string): void
  getShowEngineeringMode(): boolean
  openEngineeringToolbox(): void
  getWorking(): boolean
  hasStop(): boolean
  confirmStop(): void
  isPendingStop(): boolean
  cancelStop(): void
}

/** Window-level key handling for the composer: mention/slash menu navigation,
 *  popover dismissal, arrow-up history recall, the Engineering shortcut, and
 *  the arm-then-confirm Escape stop flow. */
export function handleComposerKeydown(e: KeyboardEvent, ctx: ComposerKeydownContext): void {
  // While a surface above this composer owns Escape   a Settings/Scope page
  // covering the shell, an open modal or palette (spotlight)   or the event
  // was already consumed by such an overlay, stay inert. Reacting here would
  // arm the "Stop?" confirmation invisibly, making the user's next Escape on
  // the thread abort the run without them ever seeing the armed state.
  if (isEscapeClaimed(e)) return
  if (ctx.isMentionOpen()) {
    const entries = ctx.getMentionEntries()
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const direction = e.key === 'ArrowDown' ? 1 : -1
      ctx.setMentionIndex(
        (ctx.getMentionIndex() + direction + Math.max(entries.length, 1)) %
          Math.max(entries.length, 1)
      )
      return
    }
    if (keymapState.matches('chat-mention-accept', e) && entries[ctx.getMentionIndex()]) {
      e.preventDefault()
      ctx.selectMention(entries[ctx.getMentionIndex()])
      return
    }
    if (keymapState.matches('chat-mention-close', e)) {
      e.preventDefault()
      ctx.closeMentions()
      return
    }
  }
  if (ctx.isSlashOpen()) {
    const actions = ctx.getSlashActions()
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const direction = e.key === 'ArrowDown' ? 1 : -1
      const count = Math.max(actions.length, 1)
      ctx.setSlashIndex((ctx.getSlashIndex() + direction + count) % count)
      return
    }
    if (keymapState.matches('chat-slash-accept', e) && actions[ctx.getSlashIndex()]) {
      // The rich editor only submits when the caret sits in a plain paragraph
      // (P/DIV). When the slash is typed after text that renders as a heading,
      // list, code block, etc. the editor's own Enter handler would let the
      // browser insert a newline instead of running the command   so the slash
      // menu claims Enter here, in the bubbling phase, before the default
      // action fires. For plain paragraphs the editor already submitted and
      // closed the menu, making this branch a no-op.
      e.preventDefault()
      ctx.selectSlashAction(actions[ctx.getSlashIndex()], 'keyboard')
      return
    }
    if (keymapState.matches('chat-slash-close', e)) {
      e.preventDefault()
      ctx.closeSlash()
      return
    }
  }
  if (ctx.isSelectionPopoverOpen() && keymapState.matches('chat-selection-popover-close', e)) {
    e.preventDefault()
    ctx.closeSelectionPopover()
    return
  }
  if (ctx.isStartAfterPopoverOpen() && keymapState.matches('chat-start-after-popover-close', e)) {
    e.preventDefault()
    ctx.closeStartAfterPopover()
    return
  }
  const editorEl = ctx.getComposerElement()
  const isComposerFocused = editorEl?.contains(document.activeElement)
  if (isComposerFocused && !ctx.isMentionOpen() && !ctx.isSlashOpen()) {
    if (ctx.getHistoryIndex() >= 0 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      ctx.setHistoryIndex(-1)
      ctx.setSavedValue('')
    }
    if (
      keymapState.matches('chat-history-previous', e) &&
      (ctx.getValue() === '' || ctx.getHistoryIndex() >= 0)
    ) {
      const history = ctx.getHistoryMessages()
      if (history.length > 0) {
        e.preventDefault()
        if (ctx.getHistoryIndex() === -1) {
          ctx.setSavedValue(ctx.getValue())
          ctx.onHistoryNavigateStart()
          // Start from the newest entry. When the current draft already
          // matches a recall entry, resume above it instead of re-showing it.
          const exact = ctx.getValue() === '' ? -1 : history.lastIndexOf(ctx.getValue())
          ctx.setHistoryIndex(exact > 0 ? exact - 1 : history.length - 1)
        } else {
          // Resolve the position by value, not by the stored index: the list
          // can grow while navigating (lazy full-history load), which would
          // otherwise make a positional step land on an unrelated old entry.
          const current = history.lastIndexOf(ctx.getValue())
          const position = current === -1 ? ctx.getHistoryIndex() : current
          ctx.setHistoryIndex(Math.max(0, position - 1))
        }
        ctx.setValue(history[ctx.getHistoryIndex()])
        ctx.onValueChange(ctx.getValue())
        return
      }
    }
    if (keymapState.matches('chat-history-next', e) && ctx.getHistoryIndex() >= 0) {
      e.preventDefault()
      const history = ctx.getHistoryMessages()
      // Value-based position, matching the ArrowUp branch, so a list that
      // grew mid-navigation keeps the walk coherent.
      const current = history.lastIndexOf(ctx.getValue())
      const position = current === -1 ? ctx.getHistoryIndex() : current
      if (position >= history.length - 1) {
        ctx.setValue(ctx.getSavedValue())
        ctx.onValueChange(ctx.getValue())
        ctx.setHistoryIndex(-1)
      } else {
        ctx.setHistoryIndex(position + 1)
        ctx.setValue(history[ctx.getHistoryIndex()])
        ctx.onValueChange(ctx.getValue())
      }
      return
    }
  }
  // Global-on-thread toggle: works regardless of what has focus (composer,
  // toolbox panel, or elsewhere on the thread)   like the voice shortcut.
  // The toolbox panel handles Cmd/Ctrl+E itself while open and prevents
  // default, so this won't immediately re-open it.
  if (
    keymapState.matches('chat-engineering-mode', e) &&
    !e.defaultPrevented &&
    ctx.getShowEngineeringMode()
  ) {
    e.preventDefault()
    ctx.openEngineeringToolbox()
    return
  }
  // While the agent runs, the first Escape arms the stop button with a
  // visible "Stop?" state and the second confirms the abort. A running agent
  // is a global session concern, so this remains active even when the
  // composer editor itself does not have focus.
  if (!keymapState.matches('chat-stop', e)) return
  if (ctx.getWorking() && ctx.hasStop()) {
    ctx.confirmStop()
    return
  }
  // Idle   Escape only dismisses a stale armed confirmation.
  if (ctx.isPendingStop()) ctx.cancelStop()
}
