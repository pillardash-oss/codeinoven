/** Read-only editor intelligence. Positions use LSP UTF-16 offsets. */
export type IdeAction =
  | 'install'
  | 'inventory'
  | 'check'
  | 'sync'
  | 'close'
  | 'cancel'
  | 'definition'
  | 'references'
  | 'hover'
  | 'capabilities'
  | 'format'
  | 'grep'
  | 'completion'
  | 'resolveCompletion'
  | 'codeActions'
  | 'applyCodeAction'
export interface IdeRequest {
  owner: string
  action: IdeAction
  path: string
  text?: string
  line?: number
  character?: number
  serverId?: string
  query?: string
  /** 1 = invoked, 2 = automatic typing, 3 = a trigger character was typed. */
  triggerKind?: number
  triggerCharacter?: string
  /** Opaque language-server data echoed back for a resolve or apply request. */
  payload?: unknown
  /** Project text search only: match uppercase and lowercase exactly. Absent
   *  or false is the case-insensitive default. */
  caseSensitive?: boolean
}
export interface IdeLocation {
  path: string
  line: number
  character: number
  preview?: string
}
export interface IdeResponse {
  installations?: IdeInstallation[]
  servers?: {
    id: string
    name: string
    executable: string
    root: string
    language: string
    languages: string[]
  }[]
  locations?: IdeLocation[]
  documentation?: string
  /** The document re-laid-out by its language server, returned by `format`,
   *  or after applying a completion's or code action's edits. */
  text?: string
  capabilities?: {
    definition: boolean
    references: boolean
    hover: boolean
    completion: boolean
    codeActions: boolean
  }
  completions?: IdeCompletionItem[]
  isIncomplete?: boolean
  codeActions?: IdeCodeAction[]
  /** Other project files a code action wanted to change. Only the edited
   *  document is written by the app, so these are reported, not applied. */
  skippedFiles?: string[]
  truncated?: boolean
}
export interface IdePosition {
  line: number
  character: number
}
export interface IdeRange {
  start: IdePosition
  end: IdePosition
}
export interface IdeTextEdit {
  range: IdeRange
  newText: string
}
/**
 * One completion a language server offered.
 *
 * `data` is opaque: tsserver only answers a completion's auto-import edits when
 * the item is resolved, so the item travels back with the same data it arrived
 * with. Ranges are UTF-16 positions, exactly as the server reported them.
 */
export interface IdeCompletionItem {
  label: string
  labelDetail?: string
  detail?: string
  documentation?: string
  /** LSP CompletionItemKind. */
  kind?: number
  /** LSP CompletionItemTag values (1 = deprecated). */
  tags?: number[]
  sortText?: string
  filterText?: string
  insertText?: string
  textEdit?: IdeTextEdit
  additionalTextEdits?: IdeTextEdit[]
  commitCharacters?: string[]
  data?: unknown
  /** The language server that offered this item. */
  serverId: string
}
/**
 * One action a language server offers for the code under the cursor.
 *
 * Import and quick-fix actions are shown straight in the editor's context menu,
 * beside Go to Definition and the other IDE items. `action` is the server's own
 * object, returned unchanged when the reader picks it so the server can resolve
 * and apply it.
 */
export interface IdeCodeAction {
  title: string
  kind?: string
  isPreferred?: boolean
  disabled?: boolean
  action: unknown
  serverId: string
}
export interface IdeInstallation {
  serverId: string
  source: 'managed' | 'external' | 'missing'
  executable?: string
  packageName?: string
  version?: string
  latestVersion?: string
  updateError?: string
}
/**
 * A language server's own report about work it is doing.
 *
 * Servers announce project loading through the protocol's work-done progress
 * (`window/workDoneProgress/create` followed by `$/progress`), which is the only
 * truthful answer to "how far along is indexing". Many servers report a
 * percentage; the ones that do not report a message instead, so `percentage` is
 * optional and the panel shows the message when it is absent.
 */
export interface IdeProgress {
  /** The IDE Mode server definition that reported it. */
  serverId: string
  /** The server's configured name, so a panel can label progress without the settings list. */
  name: string
  /** Workspace the reporting server was started in. */
  root: string
  /** The server's own token, scoped to this server and workspace. */
  token: string
  kind: 'begin' | 'report' | 'end'
  title?: string
  message?: string
  /** 0-100, present only when the server reports a percentage. */
  percentage?: number
}
