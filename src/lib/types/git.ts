/** Explicit reconciliation strategies supported by `git pull`. */
export type GitPullStrategy = 'merge' | 'rebase' | 'ff-only'

/** Persisted Pull-button behavior. */
export type GitPullPreference = 'ask' | GitPullStrategy

/** Status of one file in the working tree. */
export type GitFileStatus =
  'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'conflicted'

/** A single working-tree entry surfaced by porcelain status. */
export interface GitFileChange {
  path: string
  /** Original path for renames/copies. */
  oldPath?: string
  status: GitFileStatus
  /** True when the change is staged for commit. */
  staged: boolean
}

/** A unified diff for a single file, bounded to protect the IPC contract. */
export interface GitDiff {
  path: string
  /** True when the diff is computed against the index (staged). */
  staged: boolean
  /** Unified diff text; empty for binary files. */
  content: string
  binary: boolean
  additions: number
  deletions: number
  /** True when the diff was cut at the payload bound. */
  truncated: boolean
  /** Full before (left) side content, for reuse of the unified diff viewer. */
  before?: string
  /** Full after (right) side content, for reuse of the unified diff viewer. */
  after?: string
}

/** Snapshot of the repository working tree and branch state. */
export interface GitStatus {
  repositoryRoot: string
  branch: string | null
  /** True when HEAD is detached (no branch checked out). */
  detached: boolean
  /** Upstream tracking ref (e.g. `origin/main`), when set. */
  upstream: string | null
  /** Active merge/rebase state, used to offer the correct abort action. */
  conflictState: 'merge' | 'rebase' | 'none'
  clean: boolean
  changes: GitFileChange[]
  /** Count of staged changes (including staged deletions). */
  stagedChanges: number
  /** Count of unstaged modifications. */
  unstagedChanges: number
  /** Count of untracked files. */
  untrackedChanges: number
  /** Paths currently in a merge/rebase conflict. */
  conflicted: string[]
  /** Commits the local branch is ahead of its upstream by. */
  ahead: number
  /** Commits the local branch is behind its upstream by. */
  behind: number
}

/** One local or remote-tracking branch ref. */
export interface GitBranchInfo {
  /** Distinguishes writable local branches from read-only remote-tracking refs. */
  kind: 'local' | 'remote'
  /** Branch name without a remote prefix (e.g. `feature/auth`). */
  name: string
  /** Unambiguous short ref used for display keys and git operations. */
  ref: string
  current: boolean
  /** Associated remote name (e.g. `origin`), when one exists. */
  remote: string | null
  /** Full upstream ref for a tracked local branch (e.g. `origin/main`). */
  upstream: string | null
  ahead: number
  behind: number
  /** Absolute path of a linked worktree where this branch is checked out, when one exists.
   *  Null for regular branches and for the checkout the git panel is operating in. Such
   *  branches cannot be checked out elsewhere: git refuses the same branch in two worktrees. */
  worktreePath: string | null
}

/** A configured remote. */
export interface GitRemoteInfo {
  name: string
  url: string
}

/** Git identity read from `user.name` / `user.email` config. */
export interface GitIdentity {
  name: string | null
  email: string | null
  configured: boolean
}

/** Renderer-safe git identity write request. */
export interface GitIdentityInput {
  name: string
  email: string
}

/**
 * A ref decoration attached to a commit, normalized from `git log`'s `%D` so the
 * renderer never has to parse git's decoration syntax itself.
 */
export interface GitCommitRef {
  /** Short display name, e.g. `main`, `origin/main`, `v1.0`. */
  name: string
  /** `tag` for a tag decoration, otherwise a branch (local or remote-tracking). */
  kind: 'branch' | 'tag'
  /** True for the ref the checked-out HEAD points at. */
  head: boolean
}

/** One commit from `git log`, surfaced in a compact form. */
export interface GitCommitInfo {
  hash: string
  shortHash: string
  author: string
  date: number
  message: string
  /** Everything after the subject line, as git recorded it. */
  body: string
  /** Parent hashes, first parent first. Empty for a root commit. */
  parents: string[]
  /** Decorations on this commit (branch tips, HEAD, tags). */
  refs: GitCommitRef[]
}

/** Reset severity: soft keeps index+worktree, mixed resets index, hard discards all local changes. */
export type GitResetMode = 'soft' | 'mixed' | 'hard'

/** Where a restored file lands: the index only, or the index and working tree. */
export type GitRestoreTarget = 'staged' | 'worktree'

/** Renderer-safe git reset request. */
export interface GitResetInput {
  mode: GitResetMode
  /** Commit hash to reset the current branch to. Defaults to HEAD. */
  target?: string
}

/** Result of a push/pull that reports upstream drift. */
export interface GitSyncSummary {
  ahead: number
  behind: number
}

/** Which way a worktree/main sync moves committed work. */
export type GitMainSyncDirection = 'from-main' | 'to-main'

/**
 * Result of syncing a worktree checkout with the project's main worktree, in
 * either direction. The integrated ref is reported so the panel can state
 * exactly what moved instead of guessing at "main".
 */
export interface GitMainSyncResult {
  /** Status of the checkout the panel is attached to (the worktree side). */
  status: GitStatus
  direction: GitMainSyncDirection
  /** Branch checked out in the worktree this sync ran in. */
  branch: string
  /** Branch checked out in the project's main worktree. */
  mainBranch: string
  /** Ref whose commits were integrated (`origin/main`, `main`, or the worktree branch). */
  ref: string
  /** True when the main branch's remote-tracking ref was refreshed first (`from-main`). */
  fetched: boolean
  /** Remote used for that refresh, when the repository has one (`from-main`). */
  remote: string | null
  /** Commits the integrated ref had that the other end did not, before integrating. */
  incoming: number
  /** Commits the main worktree's branch is ahead of its upstream by after the sync. */
  mainAhead: number
}

/** Conflict information reported by a merge/rebase failure. */
export interface GitConflictFile {
  path: string
  reason?: string
}

/** Normalized merge/rebase outcome, including conflict state. */
export interface MergeSummary {
  conflicted: GitConflictFile[]
  merged: string[]
  result: string
  /** True when the operation was aborted (merge --abort / rebase --abort). */
  aborted: boolean
}

/**
 * One conflict block parsed from a conflicted working file: the full span from
 * the `<<<<<<<` marker through the `>>>>>>>` marker (inclusive), plus the two
 * sides. `ours` is the top side (the current branch/HEAD), `theirs` is the
 * bottom side (the incoming branch). `base` is only present with
 * `merge.conflictStyle=diff3`.
 */
export interface GitConflictHunk {
  /** 1-based inclusive line range covering the whole block including markers. */
  startLine: number
  endLine: number
  /** Label from the `<<<<<<<` marker (e.g. `HEAD` or a branch name). */
  oursLabel: string
  /** Label from the `>>>>>>>` marker (e.g. the incoming branch name). */
  theirsLabel: string
  /** Our/current side (lines joined), whatever was already there. */
  ours: string
  /** Their/incoming side (lines joined). */
  theirs: string
  /** Common ancestor content for diff3 conflicts, when git provides it. */
  base: string | null
}

/** Parsed conflict file for the resolution UI, bounded to protect the IPC. */
export interface GitConflictAnalysis {
  path: string
  /** True when the file has binary content and cannot be resolved in the panel. */
  binary: boolean
  /** True when the file is too large to safely reassemble   resolve in the editor. */
  truncated: boolean
  /** The raw working-tree content (may still contain conflict markers). */
  content: string
  hunks: GitConflictHunk[]
}

/**
 * Which side of an unresolved conflict to take wholesale. `incoming` is the
 * theirs side (the branch being integrated in), `current` is the ours side
 * (what HEAD already had). The same words the per-hunk merge editor uses.
 */
export type GitConflictSide = 'incoming' | 'current'

/**
 * How to move a stopped rebase along: `continue` applies the commit git
 * stopped on and replays the rest, `skip` drops that commit and replays the
 * rest. Aborting is its own operation (`git:abortRebase`).
 */
export type GitRebaseAction = 'continue' | 'skip'

/** Persisted state for one conflict range inside the scratch merge document. */
export interface GitConflictWorkHunkState {
  /** Stable index matching the corresponding entry in `analysis.hunks`. */
  index: number
  /** UTF-16 offsets in the scratch document, compatible with CodeMirror. */
  from: number
  to: number
  acceptedIncoming: boolean
  acceptedCurrent: boolean
  /** True when the user edited the range directly instead of accepting a side. */
  edited: boolean
}

/** Scratch document prepared for conflict resolution without touching the original file. */
export interface GitConflictWorkFile {
  analysis: GitConflictAnalysis
  /** Relative path under the repository, retaining the original extension. */
  scratchPath: string
  /** Marker-free content from the current blocks or the last explicitly saved draft. */
  content: string
  hunks: GitConflictWorkHunkState[]
}

/** Request to prepare a local merge to resolve a PR's online conflicts. */
export interface PrResolveOptions {
  /** Remote to fetch the PR head and base from (e.g. `origin`). */
  remote: string
  pullNumber: number
  /** Base branch to merge into the checked-out PR head (e.g. `main`). */
  baseBranch: string
  /** The PR's head branch name (e.g. `feature-x`) the resolution is pushed back to. */
  headBranch: string
  /** The branch the user was on before the temporary `pr-<n>` branch was checked out. */
  returnBranch: string
}

/** Merge method accepted by provider merge endpoints. */
export type PrMergeMethod = 'merge' | 'squash' | 'rebase'
