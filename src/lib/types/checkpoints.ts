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
