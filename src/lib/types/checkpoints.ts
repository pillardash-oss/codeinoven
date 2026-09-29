export type FileChangeType = 'created' | 'modified' | 'deleted' | 'renamed'

export interface FileChange {
  path: string
  type: FileChangeType
  beforeHash: string | null
  afterHash: string | null
  beforeBlob: string | null
  afterBlob: string | null
  oldPath?: string
}

export interface ChangeSnapshot {
  id: string
  projectId: string
  threadId: string
  timestamp: number
  label: string
  files: FileChange[]
  parentId: string | null
}

export type TurnCheckpointStatus = 'active' | 'completed' | 'failed' | 'interrupted' | 'rolled_back'

/**
 * Why an interrupted turn stopped short of a terminal answer.
 *
 * - `app-closed`: the process exited on purpose (tray Quit, a confirmed force
 *   close, a deliberate park-then-quit) and killed the harness mid-turn.
 * - `crash`: the process died without a chance to clean up (crash, power loss,
 *   an OS kill), so the harness never reported completion.
 *
 * Absent on turns interrupted before this was recorded.
 */
export type TurnCheckpointStopReason = 'app-closed' | 'crash'

export interface TurnCheckpointChangeSummary {
  path: string
  kind: 'created' | 'modified' | 'deleted'
  binary: boolean
  beforeSize?: number
  afterSize?: number
  additions?: number
  deletions?: number
  lineCountsTruncated?: boolean
}

export interface TurnCheckpointSummary {
  id: string
  projectId: string
  threadId: string
  sourceMessageId?: string
  label: string
  status: TurnCheckpointStatus
  changes: TurnCheckpointChangeSummary[]
  /** Paths too large to be captured by the checkpoint (no rollback coverage). */
  skippedFiles?: string[]
  createdAt: number
  completedAt?: number
  rolledBackAt?: number
  rolledBackPaths?: string[]
  failure?: string
  stopReason?: TurnCheckpointStopReason
  gitHead?: string | null
}

export interface TurnCheckpointFileDiff {
  path: string
  kind: TurnCheckpointChangeSummary['kind']
  binary: boolean
  before?: string
  after?: string
  truncated: boolean
}
