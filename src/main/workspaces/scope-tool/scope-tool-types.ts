import type {
  GitPullStrategy,
  ScopeEnvironmentMode,
  ScopeMergeMode,
  ScopeSetupCommandSpec,
  ScopeToolAction,
  ScopeWorktreeHealth
} from '../../../lib/types'

export type ThreadDisposition = 'move-to-default' | 'delete'

/** One scope as the tool reports it: enough to choose a target for the next call. */
export interface ScopeSummary {
  id: string
  name: string
  kind: 'project' | 'worktree'
  /** Working root of the scope (project directory or managed worktree checkout). */
  path: string
  branch?: string
  baseBranch?: string
  directoryName?: string
  setupState?: string
  health?: ScopeWorktreeHealth
  threadCount: number
  archived: boolean
  pinned: boolean
  /** True for the scope the calling thread is in. */
  active: boolean
}

/** Parsed scope capability input. Every field is validated before it is used. */
export interface ScopeToolCall {
  action: ScopeToolAction
  scope?: string
  title?: string
  name?: string
  baseBranch?: string
  runSetup?: boolean
  environmentMode?: ScopeEnvironmentMode
  setupCommands?: ScopeSetupCommandSpec[]
  attachThread?: boolean
  sourcePath?: string
  strategy?: GitPullStrategy
  mode?: ScopeMergeMode
  target?: string
  deleteBranch?: boolean
  threads?: ThreadDisposition
  confirm?: boolean
}
