export const DEFAULT_SCOPE_BUCKET_ID = 'default'

export type ScopeSlice = 'todo' | 'working' | 'spec' | 'issue' | 'unread' | 'done' | 'pinned'

/**
 * How a scope is chosen for a unit of work that may run outside the caller's own
 * scope. Used by the composer's scope picker and by an Assignment worker, which
 * is why it names no assignment concept.
 *
 * - `inherit`   run in whatever scope the caller already works in.
 * - `dedicated` a managed worktree scope is created for this unit of work, so it
 *               gets a checkout and branch of its own.
 * - `scope`     run in a scope that already exists on the project board.
 *
 * Only `scope` resolves without touching Git, so the app provisions the other
 * two rather than the renderer.
 */
export type ScopeChoice =
  | { mode: 'inherit' }
  | { mode: 'dedicated' }
  | { mode: 'scope'; bucketId: string }

export interface ScopeBucket {
  id: string
  name: string
  /** Optional accent colour from the shared appearance palette. */
  color?: string
  /** Optional key from the shared SVG icon registry. */
  iconType?: string
  sortOrder: number
  collapsed: boolean
  collapsedSlices: ScopeSlice[]
  /** Authoritative working-root descriptor owned by main; never renderer-edited. */
  root: ScopeRootDescriptor
  /** Present when the scope is archived; archival never mutates Git state. */
  archivedAt?: number
  /**
   * Pinned scopes sit outside the regular thread bucket: their threads are
   * never evicted by automatic cleanup and never count toward the project's
   * thread limit. Display-only flag; the Default scope can never be pinned.
   */
  pinned?: boolean
}

/** Identifies the project + scope pair every scope-aware operation targets. */
export interface ScopeTarget {
  projectId: string
  scopeBucketId: string
}

/** Environment-file propagation mode for a managed worktree. */
export type ScopeEnvironmentMode = 'copy' | 'symlink'

/** One structured setup command: an executable plus argument array (no shell). */
export interface ScopeSetupCommandSpec {
  executable: string
  args: string[]
}

export type ScopeSetupCommandState =
  'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'interrupted'

/** Persisted per-command outcome. Output text is intentionally never persisted. */
export interface ScopeSetupCommandRecord {
  index: number
  executable: string
  args: string[]
  state: ScopeSetupCommandState
  exitCode?: number
  startedAt?: number
  finishedAt?: number
}

/**
 * Persisted setup state of one managed worktree. `stale` means the checkout
 * itself was re-created after its recorded setup had already run (a repair
 * restored it from the managed branch), so the recorded results no longer
 * describe the working tree and setup has to run again before the scope is
 * usable.
 */
export type ScopeSetupStatusState =
  'not_run' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'stale'

export interface ScopeSetupStatus {
  state: ScopeSetupStatusState
  commands: ScopeSetupCommandRecord[]
  startedAt?: number
  finishedAt?: number
}

/** Root descriptor for scopes that resolve to the registered project directory. */
export interface ProjectRootDescriptor {
  kind: 'project'
}

/**
 * Root descriptor for scopes backed by an app-managed Git worktree beneath the
 * config root. `branch` and `directoryName` are stable for the lifetime of the
 * scope even when its display name changes.
 */
export interface ManagedWorktreeDescriptor {
  kind: 'worktree'
  directoryName: string
  branch: string
  baseBranch: string
  baseCommit: string
  createdAt: number
  environmentMode: ScopeEnvironmentMode
  setup: ScopeSetupStatus
}

export type ScopeRootDescriptor = ProjectRootDescriptor | ManagedWorktreeDescriptor

/** Project-level defaults applied to newly created managed worktrees. */
export interface ScopeWorktreeDefaults {
  setupCommands: ScopeSetupCommandSpec[]
  runSetupByDefault: boolean
  environmentMode: ScopeEnvironmentMode
}

/**
 * Immutable creation request for one managed worktree. The selected
 * environment mode and setup commands are executed for exactly this worktree,
 * independent of later edits to the project-level defaults.
 */
export interface ScopeWorktreeCreateInput {
  title: string
  runSetup: boolean
  environmentMode: ScopeEnvironmentMode
  /** Source branch the worktree forks from; defaults to the current branch. */
  baseBranch?: string
  /** Setup commands to execute for this worktree; falls back to project defaults. */
  setupCommands?: ScopeSetupCommandSpec[]
}

/** Facts about a project's source checkout, surfaced before worktree creation. */
export interface ScopeWorktreeSourceInfo {
  /** Currently checked-out branch of the main project checkout. */
  currentBranch: string
  /** Commit a worktree would fork from when created right now. */
  headCommit: string
  /** Bounded list of uncommitted changes that a new worktree will not include. */
  dirtyFiles: string[]
}

export const DEFAULT_SCOPE_WORKTREE_DEFAULTS: ScopeWorktreeDefaults = {
  setupCommands: [],
  runSetupByDefault: true,
  environmentMode: 'copy'
}

export function isManagedScopeRoot(
  root: ScopeRootDescriptor | undefined
): root is ManagedWorktreeDescriptor {
  return root?.kind === 'worktree'
}

export interface ScopeBoard {
  version: 2
  buckets: ScopeBucket[]
  worktreeDefaults: ScopeWorktreeDefaults
}

/** Renderer-supplied display-metadata patch; never touches lifecycle state. */
export interface ScopeAppearancePatch {
  name?: string
  color?: string | null
  iconType?: string | null
}

/** Renderer-supplied collapse-state patch for one bucket. */
export interface ScopeCollapsePatch {
  collapsed?: boolean
  collapsedSlices?: ScopeSlice[]
}

/** Renderer input for creating a new project-rooted custom scope. */
export interface ScopeCreateInput {
  name: string
  color?: string
  iconType?: string
}
