import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

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
  onDocChange: (text: string) => void
  onFindMatches?: (count: number) => void
}

export const TAB_INSERT = '  '

interface CodeMirrorApi {
  EditorState: (typeof import('@codemirror/state'))['EditorState']
  EditorSelection: (typeof import('@codemirror/state'))['EditorSelection']
  Compartment: (typeof import('@codemirror/state'))['Compartment']
  StateEffect: (typeof import('@codemirror/state'))['StateEffect']
  StateField: (typeof import('@codemirror/state'))['StateField']
  EditorView: (typeof import('@codemirror/view'))['EditorView']
  lineNumbers: (typeof import('@codemirror/view'))['lineNumbers']
  highlightActiveLineGutter: (typeof import('@codemirror/view'))['highlightActiveLineGutter']
  keymap: (typeof import('@codemirror/view'))['keymap']
  Decoration: (typeof import('@codemirror/view'))['Decoration']
  defaultKeymap: (typeof import('@codemirror/commands'))['defaultKeymap']
  history: (typeof import('@codemirror/commands'))['history']
  historyKeymap: (typeof import('@codemirror/commands'))['historyKeymap']
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
    onDocChange,
    onFindMatches
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
    api.history(),
    api.keymap.of([tabBinding, ...api.defaultKeymap, ...api.historyKeymap]),
    api.EditorView.updateListener.of((update) => {
      if (update.docChanged) onDocChange(update.state.doc.toString())
    })
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
    EditorView: viewModule.EditorView,
    lineNumbers: viewModule.lineNumbers,
    highlightActiveLineGutter: viewModule.highlightActiveLineGutter,
    keymap: viewModule.keymap,
    Decoration: viewModule.Decoration,
    defaultKeymap: commandModule.defaultKeymap,
    history: commandModule.history,
    historyKeymap: commandModule.historyKeymap,
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
