import type { SelectionBookmark } from './rich-markdown-editor-dom'
import type { MarkdownRuleKind } from './rich-markdown'

export interface RichHistoryEntry {
  markdown: string
  html: string
  selection: SelectionBookmark | null
  /** Set when this snapshot is the literal text the user typed just before an
   *  input rule rewrote it: undoing the entry reverts only the conversion and
   *  leaves those characters in place, and the editor holds that rule off in
   *  the restored block (see `RichMarkdownEditor`). */
  revertedRule?: MarkdownRuleKind
}

export interface RichHistoryCallbacks {
  getEditor: () => HTMLElement | undefined
  serialize: (editor: HTMLElement) => string
  captureSelection: () => SelectionBookmark | null
  /** Restores a history entry into the editor (content plus caret). */
  applyEntry: (entry: RichHistoryEntry) => void
  getValue: () => string
  setValue: (value: string) => void
  onValueChange: ((value: string) => void) | undefined
  publishState: (canUndo: boolean, canRedo: boolean) => void
}

const HISTORY_LIMIT = 100
const HISTORY_MERGE_MS = 300

/**
 * Undo/redo stack for the rich markdown editor.
 *
 * Entries capture serialized markdown plus the rendered HTML so an undo can
 * restore the editor without a re-render round trip. Consecutive typing and
 * deleting input is merged into one entry within a short window so a single
 * keystroke is not its own undo step. A `discrete` commit   an auto-conversion,
 * whose entry holds the literal text the user typed before the rule fired  
 * never merges, so undoing it lands exactly on that literal text.
 */
export class RichMarkdownEditorHistory {
  private undoHistory: RichHistoryEntry[] = []
  private redoHistory: RichHistoryEntry[] = []
  private pendingHistory: RichHistoryEntry | null = null
  private lastHistoryInputType: string | null = null
  private lastHistoryAt = 0

  constructor(private readonly callbacks: RichHistoryCallbacks) {}

  captureEntry(): RichHistoryEntry | null {
    const editor = this.callbacks.getEditor()
    if (!editor) return null
    return {
      markdown: this.callbacks.serialize(editor),
      html: editor.innerHTML,
      selection: this.callbacks.captureSelection()
    }
  }

  setPending(entry: RichHistoryEntry | null): void {
    this.pendingHistory = entry
  }

  consumePending(): RichHistoryEntry | null {
    const entry = this.pendingHistory
    this.pendingHistory = null
    return entry
  }

  resetGroup(): void {
    this.lastHistoryInputType = null
    this.lastHistoryAt = 0
  }

  publishState(): void {
    this.callbacks.publishState(this.undoHistory.length > 0, this.redoHistory.length > 0)
  }

  commit(entry: RichHistoryEntry | null, inputType?: string, discrete = false): void {
    const editor = this.callbacks.getEditor()
    if (!editor || !entry) return
    const markdown = this.callbacks.serialize(editor)
    if (markdown === entry.markdown && editor.innerHTML === entry.html) return

    const now = Date.now()
    const mergeable =
      !discrete &&
      (inputType === 'insertText' ||
        inputType === 'deleteContentBackward' ||
        inputType === 'deleteContentForward')
    const merge =
      mergeable &&
      inputType === this.lastHistoryInputType &&
      now - this.lastHistoryAt <= HISTORY_MERGE_MS &&
      this.undoHistory.length > 0

    if (!merge) {
      this.undoHistory.push(entry)
      if (this.undoHistory.length > HISTORY_LIMIT) this.undoHistory.shift()
    }
    this.redoHistory = []
    this.lastHistoryInputType = mergeable ? (inputType ?? null) : null
    this.lastHistoryAt = mergeable ? now : 0
    this.publishState()
  }

  undo(): void {
    const entry = this.undoHistory.pop()
    const current = this.captureEntry()
    if (!entry || !current) return
    this.redoHistory.push(current)
    this.resetGroup()
    this.publishEntry(entry)
    this.publishState()
  }

  redo(): void {
    const entry = this.redoHistory.pop()
    const current = this.captureEntry()
    if (!entry || !current) return
    this.undoHistory.push(current)
    if (this.undoHistory.length > HISTORY_LIMIT) this.undoHistory.shift()
    this.resetGroup()
    this.publishEntry(entry)
    this.publishState()
  }

  /** Drops all history because the editor content was replaced externally. */
  clear(): void {
    this.undoHistory = []
    this.redoHistory = []
    this.pendingHistory = null
    this.resetGroup()
    this.publishState()
  }

  private publishEntry(entry: RichHistoryEntry): void {
    this.callbacks.applyEntry(entry)
    if (entry.markdown === this.callbacks.getValue()) return
    this.callbacks.setValue(entry.markdown)
    this.callbacks.onValueChange?.(entry.markdown)
  }
}
