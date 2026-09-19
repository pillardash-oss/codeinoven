export type ScopeWorktreeHealthCategory =
  | 'healthy'
  | 'missing'
  | 'unregistered'
  | 'locked'
  | 'prunable'
  | 'branch-mismatch'
  | 'path-mismatch'
  | 'repository-unavailable'

export interface ScopeWorktreeHealth {
  category: ScopeWorktreeHealthCategory
  detail?: string
  /** Expected absolute path of the managed worktree when derivable. */
  expectedPath?: string
  /** Actual registration path reported by Git when it differs. */
  actualPath?: string
  prunable?: boolean
}

/** Preview of whether an existing Git worktree checkout can be adopted as a managed scope root. */
export interface AdoptableWorktreeInfo {
  /** Whether the path is a registered worktree of the project repository. */
  registered: boolean
  detached: boolean
  /** Absolute registration path reported by Git when registered. */
  path?: string
  /** Checked-out branch (without `refs/heads/`) when not detached. */
  branch?: string
  adoptable: boolean
  /** Human-readable explanation when not adoptable. */
  reason?: string
}

/**
 * What one destructive lifecycle action would discard, read without minting a
 * confirmation token. Agent-facing flows show this before the user (or the
 * model) decides; the single-use token is only minted when they do.
 */
export interface ScopeLifecycleSnapshot {
  /** Tracked files with uncommitted modifications (bounded list). */
  dirtyFiles: string[]
  /** Commits not reachable from any known remote-tracking ref. */
  unpushedCommits: number
  hasActiveProcesses: boolean
  /** Whether the scope's branch is checked out by this worktree. */
  branchOwnedByWorktree: boolean
}

/** Actions that require a state-bound, single-use confirmation ID. */
export type ScopeLifecycleAction =
  'detach' | 'remove-worktree' | 'delete-scope' | 'delete-branch' | 'delete-project-worktrees'

export interface ScopeLifecyclePreflight {
  action: ScopeLifecycleAction
  projectId: string
  scopeBucketId: string
  /** Tracked files with uncommitted modifications (bounded list). */
  dirtyFiles: string[]
  /** Commits not reachable from any known remote-tracking ref. */
  unpushedCommits: number
  hasActiveProcesses: boolean
  /** Whether the scope's branch is checked out by this worktree. */
  branchOwnedByWorktree: boolean
  /** Single-use token bound to this exact snapshot. */
  confirmationId: string
  createdAt: number
}

/** How a scope worktree is merged back into the main project. */
export type ScopeMergeMode = 'merge-delete' | 'merge-keep' | 'merge-move-to-default'

/**
 * State-bound preflight for merging a managed worktree scope into another
 * scope. Mints a single-use confirmation token describing exactly what the
 * merge (and any cleanup) will do before it happens.
 */
export interface ScopeMergePreflight {
  /** The managed-worktree scope being merged (the source). */
  sourceProjectId: string
  sourceScopeBucketId: string
  /** The scope the source branch is merged into (Default by default). */
  mergeTargetScopeBucketId: string
  /** Branch being merged from the source worktree (e.g. `cio/<slug>`). */
  sourceBranch: string
  /** Branch currently checked out at the merge target root. */
  targetBranch: string
  /** Non-archived threads owned by the source scope. */
  threadCount: number
  /** Dirty files in the source worktree (lost when it is removed). */
  dirtyFiles: string[]
  /** Commits on the source branch not reachable from any remote via the source scope. */
  unpushedCommits: number
  hasActiveProcesses: boolean
  mode: ScopeMergeMode
  /** Single-use token bound to this exact snapshot. */
  confirmationId: string
  createdAt: number
}

/** Result of a confirmed scope merge. */
export interface ScopeMergeOutcome {
  /** False when the merge landed in conflict; nothing was deleted. */
  merged: boolean
  /** Conflicted file paths when the merge hit conflicts. */
  conflicted: string[]
}

/** Bounded progress events for managed-worktree creation and setup. */
export interface ScopeWorktreeProgress {
  stage:
    | 'none'
    | 'naming'
    | 'discovering-repository'
    | 'creating-worktree'
    | 'persisting-association'
    | 'environment'
    | 'setup'
    | 'done'
    | 'failed'
  detail?: string
}

export interface ScopeWorktreeProgressEvent extends ScopeWorktreeProgress {
  projectId: string
  scopeBucketId: string
  /**
   * Who started the run. An `agent` run has no renderer-owned job record, so
   * the docked job panel creates one from the first progress event instead of
   * silently dropping stages the user never asked for in this window.
   */
  origin: ScopeWorktreeRunOrigin
  /** Scope display name of an agent run, so its docked panel can be labelled. */
  title?: string
}

/** Who initiated a managed-worktree run. */
export type ScopeWorktreeRunOrigin = 'user' | 'agent'

/**
 * Every operation the agent-facing `cio:scope` utility can perform. Read actions
 * report state, write actions mutate app-owned scope state, and the destructive
 * actions are confirmation-gated (see `ScopeAgentConfirmationRequest`).
 */
export const SCOPE_TOOL_ACTIONS = [
  'list',
  'status',
  'conflicts',
  'source_info',
  'detect_adoptable',
  'create',
  'rename',
  'pin',
  'unpin',
  'archive',
  'restore',
  'adopt',
  'repair',
  'retry_setup',
  'sync_from_main',
  'sync_to_main',
  'detach_worktree',
  'delete_scope',
  'merge_into_project'
] as const

export type ScopeToolAction = (typeof SCOPE_TOOL_ACTIONS)[number]

/** The destructive actions: they always require an explicit confirmation. */
export const SCOPE_TOOL_DESTRUCTIVE_ACTIONS = [
  'detach_worktree',
  'delete_scope',
  'merge_into_project'
] as const satisfies readonly ScopeToolAction[]

/**
 * One confirmation an agent-initiated destructive scope action is waiting for.
 * `auto_review` turns surface this as an app dialog and the tool call blocks
 * until the user decides; `full_access` turns only get the in-tool challenge.
 */
export interface ScopeAgentConfirmationRequest {
  requestId: string
  action: ScopeToolAction
  /** Verb phrase for the challenge copy, e.g. `delete the scope git-panel-redesign`. */
  summary: string
  /** What the confirmed action will destroy, as discrete consequence lines. */
  consequences: string[]
  projectId: string
  projectName: string
  scopeBucketId: string
  scopeName: string
  /** Thread whose agent asked for the action. */
  threadId: string
  threadTitle: string
  /** Dirty files in the affected checkout (bounded list). */
  dirtyFiles: string[]
  /** Commits not reachable from any remote-tracking ref. */
  unpushedCommits: number
  hasActiveProcesses: boolean
  /** Epoch ms after which the request denies itself. */
  expiresAt: number
}

/** Live board invalidation pushed whenever an agent changes scope state. */
export interface ScopeBoardChangedEvent {
  projectId: string
  /** Bucket the agent acted on, when the action named one. */
  scopeBucketId?: string
  /** Short verb phrase of what happened, shown as a toast/inline note. */
  summary: string
}

export interface ProjectFileEntry {
  name: string
  path: string
  kind: 'directory' | 'file'
  size?: number
  modifiedAt?: number
  /** Whether the entry is git-ignored. Set by the search index only; a
   *  directory is ignored when every file below it is ignored. */
  ignored?: boolean
}

export interface ProjectFileInfo extends ProjectFileEntry {
  absolutePath: string
  createdAt: number
  mode: number
}

/**
 * A loopback static server serving one project directory, opened in the in-app
 * browser so a page's own scripts, stylesheets, and relative *and* absolute
 * asset URLs all resolve. Returned by `directoryPreview:open`.
 */
export interface DirectoryPreviewSession {
  /** Loopback origin URL to open (`http://127.0.0.1:<port>/...`). */
  url: string
  /** Project-relative directory being served; `''` is the project root. */
  directory: string
  /** Whether the URL points at one file inside the directory. */
  entryFile: string | null
}

export type ProjectFileTransferMode = 'copy' | 'move'

export interface ProjectFileDropResult {
  entry: ProjectFileEntry
  /** Previous project-relative path when the drop moved an existing project entry. */
  movedFrom?: string
}

export interface ProjectTextFile {
  path: string
  content: string
  size: number
  modifiedAt: number
  revision: string
}
