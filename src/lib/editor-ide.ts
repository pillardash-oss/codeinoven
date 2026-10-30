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
  | 'grep'
export interface IdeRequest {
  owner: string
  action: IdeAction
  path: string
  text?: string
  line?: number
  character?: number
  serverId?: string
  query?: string
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
  capabilities?: { definition: boolean; references: boolean; hover: boolean }
  truncated?: boolean
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
