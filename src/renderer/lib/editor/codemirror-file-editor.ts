import { registerIdeContext, type IdeToken, type IdeMenuAction } from './ide-context'
import { isMacPlatform } from '../keymap/keymap'
import { keymapState } from '../keymap/keymap-state.svelte'
import type { EditorState, Extension, Range } from '@codemirror/state'
import type { Decoration as ViewDecoration, EditorView } from '@codemirror/view'

export interface FileEditorConflictRange {
  id: string
  from: number
  to: number
  resolved: boolean
  active: boolean
  acceptedIncoming: boolean
  acceptedCurrent: boolean
  edited: boolean
}

export interface FileEditorDocumentChange {
  from: number
  to: number
  insertedLength: number
}

/** Whether the editor's own history can still step back or forward, so toolbar
 *  buttons can read as unavailable instead of looking live on a fresh buffer. */
export interface FileEditorHistoryState {
  canUndo: boolean
  canRedo: boolean
}

export interface FileEditorRangeViewportRect {
  top: number
  bottom: number
}

/**
 * The file editor is backed by CodeMirror 6 so selection, scrolling (including
 * native drag-autoscroll) and editing behave exactly like a plain text editor.
 * The previous approach   a transparent `<textarea>` over a scroll-synced
 * highlighted `<pre>`   could not keep the two layers aligned while the user
 * dragged a selection past the visible page, which made selection appear to
 * break. CodeMirror renders the highlighted tokens, caret and selection in one
 * content layer, so there is nothing to desync.
 *
 * All CodeMirror modules are loaded through dynamic `import()`, so they land in
 * a lazy chunk fetched only when a file editor opens, so the eager renderer
 * bundle stays untouched.
 */

export interface FileEditorController {
  /** Retain the editor state when its live DOM moves into a native child. */
  setRoot(root: Document | ShadowRoot): void
  setValue(text: string): void
  setPath(path: string): void
  setWrap(wrap: boolean): void
  setReadonly(readonly: boolean): void
  setShowLineNumbers(show: boolean): void
  setSpellcheck(enabled: boolean): void
  setFind(query: string, activeIndex: number): void
  replaceOne(query: string, replacement: string, activeIndex: number): boolean
  replaceAll(query: string, replacement: string): number
  getValue(): string
  replaceRange(from: number, to: number, text: string, userEvent?: string): void
  resolveConflictRange(
    id: string,
    text: string,
    resolution: Pick<FileEditorConflictRange, 'acceptedIncoming' | 'acceptedCurrent' | 'edited'>,
    userEvent?: string
  ): boolean
  setConflictRanges(ranges: FileEditorConflictRange[]): void
  getConflictRanges(): FileEditorConflictRange[]
  getRangeViewportRect(id: string): FileEditorRangeViewportRect | null
  scrollToOffset(offset: number): void
  scrollToConflictRange(id: string): void
  undo(): boolean
  redo(): boolean
  scrollToLine(line: number): void
  /** Centre the view on a line and outline it for a moment, so a jump from a
   *  citation link or Go to line is easy to spot once the scroll settles. */
  revealLine(line: number, character?: number): void
  focus(): void
  destroy(): void
}

/**
 * How long a revealed line stays outlined. It matches three 0.7s runs of the
 * shared `reveal-flash` animation the jump targets elsewhere use.
 */
const LINE_FLASH_DURATION = 2_100

export interface CreateFileEditorOptions {
  host: HTMLElement
  value: string
  path: string
  readonly?: boolean
  wrap?: boolean
  showLineNumbers?: boolean
  spellcheck?: boolean
  ariaLabel?: string
  conflictRanges?: FileEditorConflictRange[]
  onIdeHoverEnd?: () => void
  isIdeEnabled?: () => boolean
  onIdeAction?: (
    action: 'definition' | 'references' | 'hover' | 'documentation' | 'grep' | 'files',
    token: IdeToken
  ) => boolean
  getIdeActions?: (token: IdeToken) => IdeMenuAction[]
  onDocChange: (text: string, changes: FileEditorDocumentChange[], userEvent: string | null) => void
  onConflictRangesChange?: (ranges: FileEditorConflictRange[]) => void
  onFindMatches?: (count: number) => void
  onScroll?: () => void
  /** Fires on creation and whenever the undo/redo depth changes, never for an
   *  unchanged depth, so a toolbar can mirror the editor without polling. */
  onHistoryChange?: (state: FileEditorHistoryState) => void
}

export const TAB_INSERT = '  '

interface CodeMirrorApi {
  EditorState: (typeof import('@codemirror/state'))['EditorState']
  EditorSelection: (typeof import('@codemirror/state'))['EditorSelection']
  Compartment: (typeof import('@codemirror/state'))['Compartment']
  StateEffect: (typeof import('@codemirror/state'))['StateEffect']
  StateField: (typeof import('@codemirror/state'))['StateField']
  Transaction: (typeof import('@codemirror/state'))['Transaction']
  EditorView: (typeof import('@codemirror/view'))['EditorView']
  lineNumbers: (typeof import('@codemirror/view'))['lineNumbers']
  highlightActiveLineGutter: (typeof import('@codemirror/view'))['highlightActiveLineGutter']
  keymap: (typeof import('@codemirror/view'))['keymap']
  Decoration: (typeof import('@codemirror/view'))['Decoration']
  defaultKeymap: (typeof import('@codemirror/commands'))['defaultKeymap']
  history: (typeof import('@codemirror/commands'))['history']
  historyKeymap: (typeof import('@codemirror/commands'))['historyKeymap']
  indentMore: (typeof import('@codemirror/commands'))['indentMore']
  indentLess: (typeof import('@codemirror/commands'))['indentLess']
  undo: (typeof import('@codemirror/commands'))['undo']
  redo: (typeof import('@codemirror/commands'))['redo']
  undoDepth: (typeof import('@codemirror/commands'))['undoDepth']
  redoDepth: (typeof import('@codemirror/commands'))['redoDepth']
  invertedEffects: (typeof import('@codemirror/commands'))['invertedEffects']
  isolateHistory: (typeof import('@codemirror/commands'))['isolateHistory']
  indentUnit: (typeof import('@codemirror/language'))['indentUnit']
  syntaxHighlighting: (typeof import('@codemirror/language'))['syntaxHighlighting']
  HighlightStyle: (typeof import('@codemirror/language'))['HighlightStyle']
  tags: (typeof import('@lezer/highlight'))['tags']
}

export async function createFileEditor(
  options: CreateFileEditorOptions
): Promise<FileEditorController> {
  const api = await loadCodeMirrorApi()
  const {
    host,
    value,
    path,
    readonly = false,
    wrap = false,
    showLineNumbers = true,
    spellcheck = false,
    ariaLabel = 'File editor',
    conflictRanges = [],
    onDocChange,
    onConflictRangesChange,
    onFindMatches,
    onScroll,
    onHistoryChange
  } = options

  const wrapCompartment = new api.Compartment()
  const editableCompartment = new api.Compartment()
  const gutterCompartment = new api.Compartment()
  const spellcheckCompartment = new api.Compartment()
  const languageCompartment = new api.Compartment()

  const tabBinding = {
    key: 'Tab',
    run: (view: EditorView): boolean => {
      if (view.state.readOnly) return false
      // Single cursor with no selection: insert the indent unit so Tab still
      // inserts spaces. Any selection (or multi-cursor): indent the whole
      // block like every other editor.
      if (view.state.selection.ranges.every((range) => range.empty)) {
        const selection = view.state.selection.main
        view.dispatch({
          changes: { from: selection.from, to: selection.to, insert: TAB_INSERT },
          selection: api.EditorSelection.cursor(selection.from + TAB_INSERT.length),
          scrollIntoView: true,
          userEvent: 'input'
        })
        return true
      }
      return api.indentMore(view)
    },
    shift: (view: EditorView): boolean => {
      if (view.state.readOnly) return false
      return api.indentLess(view)
    }
  }

  let flashTimer: ReturnType<typeof setTimeout> | null = null
  let destroyed = false
  /** Last depth pair handed to `onHistoryChange`, so the toolbar is only told
   *  when something actually changed. `null` forces the creation report. */
  let reportedHistory: FileEditorHistoryState | null = null
  const reportHistory = (state: EditorState): void => {
    const next: FileEditorHistoryState = {
      canUndo: api.undoDepth(state) > 0,
      canRedo: api.redoDepth(state) > 0
    }
    if (
      reportedHistory !== null &&
      reportedHistory.canUndo === next.canUndo &&
      reportedHistory.canRedo === next.canRedo
    ) {
      return
    }
    reportedHistory = next
    onHistoryChange?.(next)
  }
  const clearFlashTimer = (): void => {
    if (flashTimer === null) return
    clearTimeout(flashTimer)
    flashTimer = null
  }

  const matchMark = api.Decoration.mark({ class: 'cm-file-find-match' })
  const ignoreSpelling = api.StateEffect.define<{ from: number; to: number; word: string }>()
  const ignoredSpellingField = api.StateField.define({
    create: () => api.Decoration.none,
    update(value, transaction) {
      let next = value.map(transaction.changes)
      if (transaction.docChanged) {
        next = next.update({
          filter: (from, to, mark) => transaction.newDoc.sliceString(from, to) === mark.spec.word
        })
      }
      for (const effect of transaction.effects) {
        if (effect.is(ignoreSpelling)) {
          const { from, to, word } = effect.value
          next = next.update({
            add: [
              api.Decoration.mark({
                attributes: { spellcheck: 'false', 'data-editor-spelling-ignored': 'true' },
                word
              }).range(from, to)
            ]
          })
        }
      }
      return next
    },
    provide: (field) => api.EditorView.decorations.from(field)
  })
  const setMatches = api.StateEffect.define<Array<[number, number]>>()
  const findField = api.StateField.define({
    create: () => api.Decoration.none,
    update(value, transaction) {
      let next = value.map(transaction.changes)
      for (const effect of transaction.effects) {
        if (effect.is(setMatches)) {
          next = api.Decoration.set(effect.value.map(([from, to]) => matchMark.range(from, to)))
        }
      }
      return next
    },
    provide: (field) => api.EditorView.decorations.from(field)
  })

  // The line a jump just landed on. It is a plain line number rather than a
  // mapped range: a document edit makes the outline stale, so it is dropped
  // instead of following the caret's edits, and the decoration is rebuilt from
  // the number so a line decoration is always anchored to a line start.
  const setFlashLine = api.StateEffect.define<number | null>()
  const flashField = api.StateField.define<number | null>({
    create: () => null,
    update(value, transaction) {
      let next = value
      for (const effect of transaction.effects) {
        if (effect.is(setFlashLine)) next = effect.value
      }
      if (next !== null && transaction.docChanged) next = null
      return next
    },
    provide: (field) =>
      api.EditorView.decorations.compute([field], (state) => {
        const line = state.field(field)
        if (line === null) return api.Decoration.none
        const clamped = Math.max(1, Math.min(line, state.doc.lines))
        return api.Decoration.set([
          api.Decoration.line({ class: 'cm-jump-line' }).range(state.doc.line(clamped).from)
        ])
      })
  })

  interface ConflictDecorationState {
    ranges: FileEditorConflictRange[]
    decorations: ReturnType<typeof api.Decoration.set>
  }
  const setConflictRanges = api.StateEffect.define<FileEditorConflictRange[]>({
    map(ranges, changes) {
      return ranges.map((range) => ({
        ...range,
        from: changes.mapPos(range.from, -1),
        to: changes.mapPos(range.to, 1)
      }))
    }
  })
  const buildConflictDecorations = (
    doc: { length: number; lineAt(position: number): { from: number; to: number } },
    ranges: FileEditorConflictRange[]
  ): ReturnType<typeof api.Decoration.set> => {
    const decorations: Range<ViewDecoration>[] = []
    for (const range of ranges) {
      if (!range.active) continue
      const from = Math.max(0, Math.min(range.from, doc.length))
      const to = Math.max(from, Math.min(range.to, doc.length))
      const firstLine = doc.lineAt(from)
      const lastLine = doc.lineAt(Math.max(from, to > from ? to - 1 : to))
      let lineFrom = firstLine.from
      while (lineFrom <= lastLine.from) {
        const line = doc.lineAt(lineFrom)
        const classes = [
          'cm-merge-conflict-line',
          range.resolved ? 'cm-merge-conflict-resolved' : 'cm-merge-conflict-unresolved',
          'cm-merge-conflict-active',
          line.from === firstLine.from ? 'cm-merge-conflict-first' : '',
          line.from === lastLine.from ? 'cm-merge-conflict-last' : ''
        ]
          .filter(Boolean)
          .join(' ')
        decorations.push(api.Decoration.line({ class: classes }).range(line.from))
        if (line.to >= doc.length) break
        lineFrom = line.to + 1
      }
    }
    return api.Decoration.set(decorations, true)
  }
  const conflictField = api.StateField.define<ConflictDecorationState>({
    create: (state) => ({
      ranges: conflictRanges.map((range) => ({ ...range })),
      decorations: buildConflictDecorations(state.doc, conflictRanges)
    }),
    update(value, transaction) {
      const changedIds = new Set<string>()
      if (transaction.docChanged) {
        transaction.changes.iterChangedRanges((from, to) => {
          for (const range of value.ranges) {
            if (from <= range.to && to >= range.from) changedIds.add(range.id)
          }
        })
      }
      let ranges = value.ranges.map((range) => ({
        ...range,
        from: transaction.changes.mapPos(range.from, -1),
        to: transaction.changes.mapPos(range.to, 1)
      }))
      let explicitRanges = false
      for (const effect of transaction.effects) {
        if (!effect.is(setConflictRanges)) continue
        ranges = effect.value.map((range) => ({ ...range }))
        explicitRanges = true
      }
      if (transaction.docChanged && !explicitRanges) {
        ranges = ranges.map((range) =>
          changedIds.has(range.id)
            ? {
                ...range,
                resolved: true,
                acceptedIncoming: false,
                acceptedCurrent: false,
                edited: true
              }
            : range
        )
      }
      return { ranges, decorations: buildConflictDecorations(transaction.newDoc, ranges) }
    },
    provide: (field) => api.EditorView.decorations.from(field, (value) => value.decorations)
  })

  const extensions: Extension[] = [
    buildEditorTheme(api.EditorView),
    api.syntaxHighlighting(buildHighlightStyle(api.HighlightStyle, api.tags), { fallback: true }),
    api.EditorState.tabSize.of(2),
    api.indentUnit.of(TAB_INSERT),
    gutterCompartment.of(
      showLineNumbers ? [api.lineNumbers(), api.highlightActiveLineGutter()] : []
    ),
    languageCompartment.of([]),
    editableCompartment.of(api.EditorView.editable.of(!readonly)),
    wrapCompartment.of(wrap ? api.EditorView.lineWrapping : []),
    spellcheckCompartment.of(
      api.EditorView.contentAttributes.of({ spellcheck: spellcheck ? 'true' : 'false' })
    ),
    api.EditorView.contentAttributes.of({ 'aria-label': ariaLabel, 'data-region': 'editor' }),
    findField,
    ignoredSpellingField,
    flashField,
    conflictField,
    api.invertedEffects.of((transaction) => {
      const changesConflictState =
        transaction.docChanged || transaction.effects.some((effect) => effect.is(setConflictRanges))
      if (!changesConflictState) return []
      const previous = transaction.startState.field(conflictField).ranges
      return [setConflictRanges.of(previous.map((range) => ({ ...range })))]
    }),
    api.history(),
    api.keymap.of([tabBinding, ...api.defaultKeymap, ...api.historyKeymap]),
    api.EditorView.updateListener.of((update) => {
      reportHistory(update.state)
      const conflictRangesChanged = update.transactions.some(
        (transaction) =>
          transaction.docChanged ||
          transaction.effects.some((effect) => effect.is(setConflictRanges))
      )
      if (conflictRangesChanged) {
        onConflictRangesChange?.(
          update.state.field(conflictField).ranges.map((range) => ({ ...range }))
        )
      }
      if (!update.docChanged) return
      const changes: FileEditorDocumentChange[] = []
      update.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
        changes.push({ from, to, insertedLength: inserted.length })
      })
      let userEvent: string | null = null
      for (const transaction of update.transactions) {
        const annotation = transaction.annotation(api.Transaction.userEvent)
        if (!annotation) continue
        userEvent = annotation
        break
      }
      onDocChange(update.state.doc.toString(), changes, userEvent)
    }),
    api.EditorView.domEventHandlers({ scroll: () => onScroll?.() })
  ]

  function tokenAt(view: EditorView, position: number, x = 0, y = 0): IdeToken | null {
    const word = view.state.wordAt(position)
    if (!word) return null
    const line = view.state.doc.lineAt(position)
    const coords = view.coordsAtPos(position)
    return {
      line: line.number - 1,
      character: position - line.from,
      word: view.state.sliceDoc(word.from, word.to),
      text: view.state.doc.toString(),
      x: x || coords?.left || 0,
      y: y || coords?.bottom || 0
    }
  }
  extensions.push(
    api.EditorView.domEventHandlers({
      click(event, view) {
        if (!options.isIdeEnabled?.()) return false
        if (!(isMacPlatform() ? event.metaKey : event.ctrlKey) || event.button !== 0) return false
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
        const token =
          position === null ? null : tokenAt(view, position, event.clientX, event.clientY)
        return token ? (options.onIdeAction?.('definition', token) ?? false) : false
      },
      keydown(event, view) {
        if (!options.isIdeEnabled?.()) return false
        const commands = ['definition', 'references', 'documentation', 'grep', 'files'] as const
        const command = commands.find((action) => keymapState.matches(`ide-${action}`, event))
        if (!command) return false
        const token = tokenAt(view, view.state.selection.main.head) ?? {
          line: 0,
          character: 0,
          word: '',
          text: view.state.doc.toString(),
          x: 0,
          y: 0
        }
        return options.onIdeAction?.(command, token) ?? false
      },
      mousemove(event, view) {
        clearTimeout(hoverTimer)
        if (!options.isIdeEnabled?.()) return false
        options.onIdeHoverEnd?.()
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (position !== null && options.onIdeAction)
          hoverTimer = setTimeout(() => {
            const token = tokenAt(view, position, event.clientX, event.clientY)
            if (token) options.onIdeAction?.('hover', token)
          }, 650)
        return false
      },
      mouseleave() {
        clearTimeout(hoverTimer)
        options.onIdeHoverEnd?.()
        return false
      }
    })
  )
  let hoverTimer: ReturnType<typeof setTimeout> | undefined
  const state = api.EditorState.create({ doc: value, extensions })
  const view = new api.EditorView({ state, parent: host })
  const unregisterIde = registerIdeContext(host, (event) => {
    if (!options.isIdeEnabled?.()) return []
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
    const token = position === null ? null : tokenAt(view, position, event.clientX, event.clientY)
    return token ? (options.getIdeActions?.(token) ?? []) : []
  })
  const handleIgnoreSpelling = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return
    const range: unknown = event.detail
    if (
      !(range instanceof window.Range) ||
      !view.contentDOM.contains(range.commonAncestorContainer)
    )
      return
    event.preventDefault()
    const from = view.posAtDOM(range.startContainer, range.startOffset)
    const to = view.posAtDOM(range.endContainer, range.endOffset)
    if (from < to)
      view.dispatch({
        effects: ignoreSpelling.of({ from, to, word: view.state.sliceDoc(from, to) })
      })
  }
  view.contentDOM.addEventListener('editor-ignore-spelling', handleIgnoreSpelling)
  // A fresh buffer has nothing to step back through. The report is forced here
  // because the listener only fires on transactions, and a remount over an
  // earlier file would otherwise leave a toolbar showing a stale history.
  reportHistory(view.state)
  void setLanguage(path, languageCompartment, view)

  function setFind(query: string, activeIndex: number): void {
    const text = view.state.doc.toString()
    const matches = findMatches(text, query)
    onFindMatches?.(matches.length)
    view.dispatch({ effects: setMatches.of(matches) })
    if (matches.length === 0) return
    const active = matches[Math.max(0, Math.min(activeIndex, matches.length - 1))]
    const from = Math.min(active[0], text.length)
    const to = Math.min(active[1], text.length)
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: api.EditorView.scrollIntoView(from, { y: 'center' })
    })
  }

  return {
    setRoot(root: Document | ShadowRoot): void {
      if (view.root !== root) view.setRoot(root)
    },
    setValue(text: string): void {
      if (view.state.doc.toString() === text) return
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        userEvent: 'file.replace'
      })
    },
    setPath(next: string): void {
      void setLanguage(next, languageCompartment, view)
    },
    setWrap(enabled: boolean): void {
      view.dispatch({
        effects: wrapCompartment.reconfigure(enabled ? api.EditorView.lineWrapping : [])
      })
    },
    setReadonly(enabled: boolean): void {
      view.dispatch({
        effects: editableCompartment.reconfigure(api.EditorView.editable.of(!enabled))
      })
    },
    setShowLineNumbers(show: boolean): void {
      view.dispatch({
        effects: gutterCompartment.reconfigure(
          show ? [api.lineNumbers(), api.highlightActiveLineGutter()] : []
        )
      })
    },
    setSpellcheck(enabled: boolean): void {
      view.dispatch({
        effects: spellcheckCompartment.reconfigure(
          api.EditorView.contentAttributes.of({ spellcheck: enabled ? 'true' : 'false' })
        )
      })
    },
    setFind,
    replaceOne(query: string, replacement: string, activeIndex: number): boolean {
      const text = view.state.doc.toString()
      const matches = findMatches(text, query)
      if (matches.length === 0) return false
      const [from, to] = matches[Math.max(0, Math.min(activeIndex, matches.length - 1))]
      view.dispatch({
        changes: { from, to, insert: replacement },
        scrollIntoView: true,
        userEvent: 'input.replace'
      })
      return true
    },
    replaceAll(query: string, replacement: string): number {
      const text = view.state.doc.toString()
      const matches = findMatches(text, query)
      if (matches.length === 0) return 0
      view.dispatch({
        changes: matches.map(([from, to]) => ({ from, to, insert: replacement })),
        userEvent: 'input.replace'
      })
      return matches.length
    },
    getValue(): string {
      return view.state.doc.toString()
    },
    replaceRange(from: number, to: number, text: string, userEvent = 'merge.accept'): void {
      view.dispatch({
        changes: {
          from: Math.max(0, Math.min(from, view.state.doc.length)),
          to: Math.max(0, Math.min(to, view.state.doc.length)),
          insert: text
        },
        userEvent
      })
    },
    resolveConflictRange(
      id: string,
      text: string,
      resolution: Pick<FileEditorConflictRange, 'acceptedIncoming' | 'acceptedCurrent' | 'edited'>,
      userEvent = 'merge.accept'
    ): boolean {
      const ranges = view.state.field(conflictField).ranges
      const target = ranges.find((range) => range.id === id)
      if (!target) return false
      const changes = view.state.changes({ from: target.from, to: target.to, insert: text })
      const nextRanges = ranges.map((range) => {
        if (range.id === id) {
          return {
            ...range,
            from: target.from,
            to: target.from + text.length,
            resolved: true,
            ...resolution
          }
        }
        return {
          ...range,
          from: changes.mapPos(range.from, -1),
          to: changes.mapPos(range.to, 1)
        }
      })
      view.dispatch({
        changes,
        effects: setConflictRanges.of(nextRanges),
        annotations: api.isolateHistory.of('full'),
        userEvent
      })
      return true
    },
    setConflictRanges(ranges: FileEditorConflictRange[]): void {
      view.dispatch({
        effects: setConflictRanges.of(ranges.map((range) => ({ ...range }))),
        annotations: api.Transaction.addToHistory.of(false)
      })
    },
    getConflictRanges(): FileEditorConflictRange[] {
      return view.state.field(conflictField).ranges.map((range) => ({ ...range }))
    },
    getRangeViewportRect(id: string): FileEditorRangeViewportRect | null {
      const range = view.state.field(conflictField).ranges.find((candidate) => candidate.id === id)
      if (!range) return null
      const start = view.coordsAtPos(range.from, 1)
      const end = view.coordsAtPos(Math.max(range.from, range.to), -1)
      if (!start || !end) return null
      const hostRect = host.getBoundingClientRect()
      return { top: start.top - hostRect.top, bottom: end.bottom - hostRect.top }
    },
    scrollToOffset(offset: number): void {
      const position = Math.max(0, Math.min(offset, view.state.doc.length))
      view.dispatch({ effects: api.EditorView.scrollIntoView(position, { y: 'center' }) })
    },
    scrollToConflictRange(id: string): void {
      const range = view.state.field(conflictField).ranges.find((candidate) => candidate.id === id)
      if (!range) return
      view.dispatch({ selection: { anchor: range.from } })
      view.requestMeasure({
        read(editor) {
          const current = editor.state
            .field(conflictField)
            .ranges.find((candidate) => candidate.id === id)
          if (!current) return null
          const block = editor.lineBlockAt(current.from)
          const viewportHeight = editor.scrollDOM.clientHeight
          const targetCenter = editor.documentPadding.top + block.top + block.height / 2
          const desired = targetCenter - viewportHeight / 2
          return Math.max(0, Math.min(desired, editor.contentHeight - viewportHeight))
        },
        write(scrollTop, editor) {
          if (scrollTop === null) return
          editor.scrollDOM.scrollTop = scrollTop
          onScroll?.()
        }
      })
    },
    undo(): boolean {
      return api.undo(view)
    },
    redo(): boolean {
      return api.redo(view)
    },
    scrollToLine(line: number): void {
      const requested = Math.max(1, Math.floor(line))
      const doc = view.state.doc
      const targetLine = Math.min(requested, doc.lines)
      view.dispatch({
        effects: api.EditorView.scrollIntoView(doc.line(targetLine).from, { y: 'center' })
      })
    },
    revealLine(line: number, character?: number): void {
      const requested = Math.max(1, Math.floor(line))
      const doc = view.state.doc
      const targetLine = Math.min(requested, doc.lines)
      // Clear first, then outline on the next frame: re-clicking the same link
      // must restart the flash animation, which only happens when the class
      // leaves the line for at least one painted frame.
      const cleared = view.state.field(flashField) !== null
      const target = doc.line(targetLine)
      view.dispatch({
        ...(character === undefined
          ? {}
          : {
              selection: { anchor: target.from + Math.min(Math.max(0, character), target.length) }
            }),
        effects: [
          ...(cleared ? [setFlashLine.of(null)] : []),
          api.EditorView.scrollIntoView(doc.line(targetLine).from, { y: 'center' })
        ]
      })
      clearFlashTimer()
      view.contentDOM.removeEventListener('editor-ignore-spelling', handleIgnoreSpelling)
      const paintOutline = (): void => {
        if (destroyed) return
        view.dispatch({ effects: setFlashLine.of(targetLine) })
        flashTimer = setTimeout(() => {
          flashTimer = null
          if (!destroyed && view.state.field(flashField) !== null) {
            view.dispatch({ effects: setFlashLine.of(null) })
          }
        }, LINE_FLASH_DURATION)
      }
      if (character !== undefined) view.focus()
      if (cleared) requestAnimationFrame(paintOutline)
      else paintOutline()
    },
    focus(): void {
      view.focus()
    },
    destroy(): void {
      clearTimeout(hoverTimer)
      unregisterIde()
      destroyed = true
      clearFlashTimer()
      view.destroy()
    }
  }
}

async function loadCodeMirrorApi(): Promise<CodeMirrorApi> {
  const [stateModule, viewModule, commandModule, languageModule, tagsModule] = await Promise.all([
    import('@codemirror/state'),
    import('@codemirror/view'),
    import('@codemirror/commands'),
    import('@codemirror/language'),
    import('@lezer/highlight')
  ])
  return {
    EditorState: stateModule.EditorState,
    EditorSelection: stateModule.EditorSelection,
    Compartment: stateModule.Compartment,
    StateEffect: stateModule.StateEffect,
    StateField: stateModule.StateField,
    Transaction: stateModule.Transaction,
    EditorView: viewModule.EditorView,
    lineNumbers: viewModule.lineNumbers,
    highlightActiveLineGutter: viewModule.highlightActiveLineGutter,
    keymap: viewModule.keymap,
    Decoration: viewModule.Decoration,
    defaultKeymap: commandModule.defaultKeymap,
    history: commandModule.history,
    historyKeymap: commandModule.historyKeymap,
    indentMore: commandModule.indentMore,
    indentLess: commandModule.indentLess,
    undo: commandModule.undo,
    redo: commandModule.redo,
    undoDepth: commandModule.undoDepth,
    redoDepth: commandModule.redoDepth,
    invertedEffects: commandModule.invertedEffects,
    isolateHistory: commandModule.isolateHistory,
    indentUnit: languageModule.indentUnit,
    syntaxHighlighting: languageModule.syntaxHighlighting,
    HighlightStyle: languageModule.HighlightStyle,
    tags: tagsModule.tags
  }
}

function buildHighlightStyle(
  HighlightStyle: CodeMirrorApi['HighlightStyle'],
  tags: CodeMirrorApi['tags']
): ReturnType<CodeMirrorApi['HighlightStyle']['define']> {
  return HighlightStyle.define([
    { tag: tags.comment, color: 'var(--syntax-comment)' },
    {
      tag: [
        tags.keyword,
        tags.controlKeyword,
        tags.definitionKeyword,
        tags.moduleKeyword,
        tags.operatorKeyword
      ],
      color: 'var(--syntax-keyword)'
    },
    { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--syntax-string)' },
    { tag: tags.number, color: 'var(--syntax-number)' },
    {
      tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
      color: 'var(--syntax-function)'
    },
    { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--syntax-type)' },
    {
      tag: [tags.attributeName, tags.propertyName, tags.operator],
      color: 'var(--syntax-attr)'
    },
    { tag: [tags.tagName, tags.labelName, tags.meta], color: 'var(--syntax-tag)' }
  ])
}

function buildEditorTheme(EditorView: CodeMirrorApi['EditorView']): Extension {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        fontSize: '0.75rem',
        backgroundColor: 'var(--color-app)',
        color: 'var(--color-foreground)'
      },
      '&.cm-focused': {
        outline: 'none'
      },
      '.cm-scroller': {
        fontFamily: 'var(--font-mono)',
        lineHeight: 1.667,
        // Top spacing lives here, NOT on .cm-content padding-top: a content
        // top padding desyncs CodeMirror's gutter spacer/height-map from the
        // rendered lines, shifting every line number off its code line.
        paddingTop: '12px',
        overscrollBehavior: 'contain'
      },
      '.cm-content': {
        padding: '0 0 12px 0',
        caretColor: 'var(--color-foreground)'
      },
      '.cm-line': {
        padding: '0 12px'
      },
      '.cm-gutters': {
        backgroundColor: 'var(--color-surface)',
        color: 'var(--color-dimmed)',
        borderRight: '1px solid var(--color-border)'
        // No vertical padding here: the scroller's padding-top supplies the
        // shared top gap, keeping gutters and content in lockstep.
      },
      '.cm-lineNumbers .cm-gutterElement': {
        // CodeMirror assigns each gutter element the measured height of its
        // code line inline. Flex-centering the number inside that row makes
        // the alignment structural   independent of line-height ratios, font
        // metrics and fractional zoom rounding   so digits track their code
        // line exactly at any user font size or zoom.
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        padding: '0 8px 0 12px',
        minWidth: '3ch'
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'var(--color-selected)',
        color: 'var(--color-muted)'
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
        backgroundColor: 'color-mix(in srgb, var(--color-primary) 30%, transparent)'
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'var(--color-foreground)'
      },
      '.cm-file-find-match': {
        backgroundColor: 'color-mix(in srgb, var(--color-accent) 30%, transparent)',
        borderRadius: '2px'
      },
      '.cm-merge-conflict-line': {
        borderLeft: '2px solid var(--color-warning)',
        borderRight: '2px solid var(--color-warning)'
      },
      '.cm-merge-conflict-first': {
        borderTop: '2px solid var(--color-warning)',
        borderTopLeftRadius: '4px',
        borderTopRightRadius: '4px'
      },
      '.cm-merge-conflict-last': {
        borderBottom: '2px solid var(--color-warning)',
        borderBottomLeftRadius: '4px',
        borderBottomRightRadius: '4px'
      },
      '.cm-merge-conflict-resolved': {
        borderColor: 'var(--color-success)',
        backgroundColor: 'color-mix(in srgb, var(--color-success) 8%, transparent)'
      },
      '.cm-merge-conflict-active': {
        backgroundColor: 'color-mix(in srgb, var(--color-warning) 13%, transparent)'
      }
    },
    { dark: false }
  )
}

function findMatches(text: string, query: string): Array<[number, number]> {
  if (!query) return []
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const positions: Array<[number, number]> = []
  let pos = 0
  while (true) {
    const index = lowerText.indexOf(lowerQuery, pos)
    if (index === -1) break
    positions.push([index, index + lowerQuery.length])
    pos = index + 1
  }
  return positions
}

async function setLanguage(
  path: string,
  compartment: InstanceType<CodeMirrorApi['Compartment']>,
  view: EditorView
): Promise<void> {
  try {
    if (path.toLowerCase().endsWith('.svelte')) {
      const { svelte } = await import('@replit/codemirror-lang-svelte')
      view.dispatch({ effects: compartment.reconfigure(svelte()) })
      return
    }
    const { languages } = await import('@codemirror/language-data')
    const description = findLanguage(
      languages as ReadonlyArray<{
        name: string
        alias: readonly string[]
        extensions: readonly string[]
        filename: RegExp | undefined
        load: () => Promise<Extension>
      }>,
      path
    )
    const loaded = description ? await description.load() : null
    view.dispatch({ effects: compartment.reconfigure(loaded ?? []) })
  } catch {
    view.dispatch({ effects: compartment.reconfigure([]) })
  }
}

function findLanguage(
  languages: ReadonlyArray<{
    name: string
    alias: readonly string[]
    extensions: readonly string[]
    filename: RegExp | undefined
    load: () => Promise<Extension>
  }>,
  path: string
): { load: () => Promise<Extension> } | null {
  const filename = path.split('/').at(-1) ?? path
  const extension = filename.includes('.')
    ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() || null
    : null
  return (
    languages.find((candidate) => {
      if (candidate.filename && candidate.filename.test(filename)) return true
      return Boolean(
        extension &&
        candidate.extensions.some((candidateExtension) => candidateExtension === extension)
      )
    }) ?? null
  )
}
