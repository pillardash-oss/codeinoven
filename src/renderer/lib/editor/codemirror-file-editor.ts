import type { Extension, Range } from '@codemirror/state'
import type { Decoration as ViewDecoration, EditorView } from '@codemirror/view'

export interface FileEditorConflictRange {
  id: string
  from: number
  to: number
  resolved: boolean
  active: boolean
}

export interface FileEditorDocumentChange {
  from: number
  to: number
  insertedLength: number
}

export interface FileEditorRangeViewportRect {
  top: number
  bottom: number
}

/**
 * The file editor is backed by CodeMirror 6 so selection, scrolling (including
 * native drag-autoscroll) and editing behave exactly like a plain text editor.
 * The previous approach — a transparent `<textarea>` over a scroll-synced
 * highlighted `<pre>` — could not keep the two layers aligned while the user
 * dragged a selection past the visible page, which made selection appear to
 * break. CodeMirror renders the highlighted tokens, caret and selection in one
 * content layer, so there is nothing to desync.
 *
 * All CodeMirror modules are loaded through dynamic `import()`, so they land in
 * a lazy chunk fetched only when a file editor opens; the eager renderer bundle
 * and the PWA initial closure are untouched.
 */

export interface FileEditorController {
  setValue(text: string): void
  setPath(path: string): void
  setWrap(wrap: boolean): void
  setReadonly(readonly: boolean): void
  setShowLineNumbers(show: boolean): void
  setSpellcheck(enabled: boolean): void
  setFind(query: string, activeIndex: number): void
  getValue(): string
  replaceRange(from: number, to: number, text: string, userEvent?: string): void
  setConflictRanges(ranges: FileEditorConflictRange[]): void
  getConflictRanges(): FileEditorConflictRange[]
  getRangeViewportRect(id: string): FileEditorRangeViewportRect | null
  scrollToOffset(offset: number): void
  scrollToConflictRange(id: string): void
  undo(): boolean
  redo(): boolean
  scrollToLine(line: number): void
  focus(): void
  destroy(): void
}

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
  onDocChange: (text: string, changes: FileEditorDocumentChange[], userEvent: string | null) => void
  onFindMatches?: (count: number) => void
  onScroll?: () => void
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
  undo: (typeof import('@codemirror/commands'))['undo']
  redo: (typeof import('@codemirror/commands'))['redo']
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
    onFindMatches,
    onScroll
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
      const selection = view.state.selection.main
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: TAB_INSERT },
        selection: api.EditorSelection.cursor(selection.from + TAB_INSERT.length),
        scrollIntoView: true,
        userEvent: 'input'
      })
      return true
    }
  }

  const matchMark = api.Decoration.mark({ class: 'cm-file-find-match' })
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

  interface ConflictDecorationState {
    ranges: FileEditorConflictRange[]
    decorations: ReturnType<typeof api.Decoration.set>
  }
  const setConflictRanges = api.StateEffect.define<FileEditorConflictRange[]>()
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
      let ranges = value.ranges.map((range) => ({
        ...range,
        from: transaction.changes.mapPos(range.from, -1),
        to: transaction.changes.mapPos(range.to, 1)
      }))
      for (const effect of transaction.effects) {
        if (effect.is(setConflictRanges)) ranges = effect.value.map((range) => ({ ...range }))
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
    conflictField,
    api.history(),
    api.keymap.of([tabBinding, ...api.defaultKeymap, ...api.historyKeymap]),
    api.EditorView.updateListener.of((update) => {
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

  const state = api.EditorState.create({ doc: value, extensions })
  const view = new api.EditorView({ state, parent: host })
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
    setConflictRanges(ranges: FileEditorConflictRange[]): void {
      view.dispatch({ effects: setConflictRanges.of(ranges.map((range) => ({ ...range }))) })
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
      view.dispatch({
        selection: { anchor: range.from },
        effects: api.EditorView.scrollIntoView(range.from, { y: 'center' })
      })
      view.requestMeasure({
        read(editor) {
          const current = editor.state
            .field(conflictField)
            .ranges.find((candidate) => candidate.id === id)
          if (!current) return null
          const target = editor.coordsAtPos(current.from, 1)
          if (!target) return null
          const viewport = editor.scrollDOM.getBoundingClientRect()
          const targetCenter = (target.top + target.bottom) / 2
          const viewportCenter = (viewport.top + viewport.bottom) / 2
          const desired = editor.scrollDOM.scrollTop + targetCenter - viewportCenter
          return Math.max(0, Math.min(desired, editor.scrollDOM.scrollHeight - viewport.height))
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
    focus(): void {
      view.focus()
    },
    destroy(): void {
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
    undo: commandModule.undo,
    redo: commandModule.redo,
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
        fontSize: '12px',
        backgroundColor: 'var(--color-app)',
        color: 'var(--color-foreground)'
      },
      '&.cm-focused': {
        outline: 'none'
      },
      '.cm-scroller': {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        lineHeight: '20px',
        overscrollBehavior: 'contain'
      },
      '.cm-content': {
        padding: '12px 0',
        caretColor: 'var(--color-foreground)'
      },
      '.cm-line': {
        padding: '0 12px'
      },
      '.cm-gutters': {
        backgroundColor: 'var(--color-surface)',
        color: 'var(--color-dimmed)',
        borderRight: '1px solid var(--color-border)',
        padding: '12px 0'
      },
      '.cm-lineNumbers .cm-gutterElement': {
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
