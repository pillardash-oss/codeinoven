/** Read-only editor intelligence. Positions use LSP UTF-16 offsets. */
export type IdeAction =
  'sync' | 'close' | 'cancel' | 'definition' | 'references' | 'hover' | 'capabilities' | 'grep'
export interface IdeRequest {
  owner: string
  action: IdeAction
  path: string
  text?: string
  line?: number
  character?: number
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
