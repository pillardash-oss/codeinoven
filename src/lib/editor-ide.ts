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
