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

/** Which way a sync moves committed work: into this checkout, or out of it. */
export type GitSyncDirection = 'from' | 'to'

/**
 * The other end of a sync, exactly as the renderer asks for it.
 *
 * `root` is the project's own directory, which is what "sync with main" is - the
 * project root is the single source of truth for the main branch. `worktree` is
 * a scope whose checkout is the other end. `branch` is a local branch no
 * checkout holds, so it can contribute commits but has nowhere to receive them.
 */
export type GitSyncPeer =
  | { kind: 'root' }
  | { kind: 'worktree'; scopeBucketId: string }
  | { kind: 'branch'; branch: string }

/**
 * The other end of a sync after main resolved it into something Git can act on:
 * a checkout path, a named branch, or both (a checkout and the branch it shows).
 */
export interface GitSyncPeerTarget {
  /** Absolute checkout path when the other end is a working tree. */
  path?: string
  /** Local branch named by the peer when it is not a checkout. */
  branch?: string
  /** Noun phrase every panel message and error names this end with. */
  label: string
}

/**
 * One end the picker can offer, as main resolved the project's checkouts and
 * branches. Options never lie about availability: an unhealthy worktree still
 * appears, marked with the reason it cannot be used, and the checkout the
 * operation runs in appears marked as itself rather than being hidden.
 */
export interface GitSyncPeerOption {
  /** Exactly what the renderer hands back to `git:syncWith`. */
  peer: GitSyncPeer
  /** Name the picker shows for this end. */
  label: string
  /** Branch this end contributes or receives; null when it has none to name. */
  branch: string | null
  /** True when this end is a working tree that can also receive commits. */
  checkout: boolean
  /** True when this end is the checkout the operation would run in. */
  self: boolean
  /** Checkout directory, when this end is one. */
  path: string | null
  /** Why this end cannot be used right now, when it cannot. */
  unavailable?: string
}

/**
 * Result of syncing this checkout with another checkout or branch, in either
 * direction. The integrated ref and the resolved peer are reported so the panel
 * can state exactly what moved instead of guessing at "main".
 */
export interface GitSyncResult {
  /** Status of the checkout the sync ran in. */
  status: GitStatus
  direction: GitSyncDirection
  /** Branch checked out in the checkout the sync ran in. */
  branch: string
  /** Branch the peer contributed (`from`) or received (`to`). */
  peerBranch: string
  /** How the peer end was named, for panel copy. */
  peerLabel: string
  /** Ref whose commits were integrated (`origin/main`, `main`, the peer branch). */
  ref: string
  /** True when the peer branch's remote-tracking ref was refreshed first. */
  fetched: boolean
  /** Remote used for that refresh, when the repository has one. */
  remote: string | null
  /** Commits the integrated ref had that the other end did not, before integrating. */
  incoming: number
  /** Commits the peer checkout's branch is ahead of its upstream by after the sync. */
  peerAhead: number
}

/**
 * Outcome of `git:syncWith`.
 *
 * A refusal is a state the user can resolve (an uncommitted working tree, a
 * detached HEAD, an integration still open, a peer that cannot receive
 * commits), so it travels as data instead of a rejected IPC invoke. Electron
 * logs every rejected `ipcMain.handle` call as a console error, and the panel
 * already renders the refusal in its own dialog, so rejecting here would only
 * duplicate a message the user is already reading.
 */
export type GitSyncOutcome = { ok: true; result: GitSyncResult } | { ok: false; refusal: string }

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
