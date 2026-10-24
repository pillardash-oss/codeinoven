/** Read-only editor intelligence. Positions use LSP UTF-16 offsets. */
export type IdeAction =
  | 'install'
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
  locations?: IdeLocation[]
  documentation?: string
  capabilities?: { definition: boolean; references: boolean; hover: boolean }
  truncated?: boolean
}
