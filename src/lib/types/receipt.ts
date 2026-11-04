/**
 * The run receipt: what a run actually did, read from Git and from the
 * commands the run itself executed.
 *
 * One shape for main and renderer, because a receipt that main summarises one
 * way and the renderer re-summarises another is a number nobody can check. The
 * service produces it, the block renders it, and neither invents a fact the
 * other did not record.
 *
 * The receipt never carries a zero where a fact is unknown. Every state that
 * cannot produce commits or files says so through {@link RunReceiptState} or an
 * explicit truncation flag, so a reader can always tell "nothing changed" from
 * "nobody looked".
 */

/** Where a receipt stands, which is the first thing the block states. */
export type RunReceiptState =
  /** Facts were read and describe the run's range. */
  | 'ready'
  /** The run has not settled yet, so its range is still moving. */
  | 'running'
  /** The run was parked before it did any work (an unhealthy scope, typically). */
  | 'parked'
  /** The run recorded no starting commit, so its range cannot be known. */
  | 'no-base'
  /** Git could not be read; the reason says why, in the app's own words. */
  | 'error'

/** The commit a run started from, recorded once when the run begins. */
export interface RunBaseRecord {
  sha: string
  /** The scope the base was taken in, so a rebind cannot silently re-base it. */
  projectId: string
  scopeBucketId: string
  recordedAt: number
}

/** Where the receipt's facts came from: the checkout the run worked in. */
export interface RunReceiptScope {
  projectId: string
  scopeBucketId: string
  /** Display name of the scope, resolved in main so the renderer never invents one. */
  scopeName: string
  /** The branch checked out when the receipt was read, when there is one. */
  branch: string | null
}

/** One commit the run made. */
export interface RunReceiptCommit {
  hash: string
  shortHash: string
  subject: string
  author: string
  at: number
}

/** How a file moved, in the letters Git itself uses (M/A/D/R). */
export type RunReceiptFileStatus = 'modified' | 'added' | 'deleted' | 'renamed'

/** One changed file, with the line counts the range diff reported. */
export interface RunReceiptFile {
  path: string
  /** Source path for a rename, so the row can say `old → new`. */
  oldPath?: string
  status: RunReceiptFileStatus
  additions: number
  deletions: number
  binary: boolean
}

/** One command the run executed, with the status it really ended on. */
export interface RunReceiptCheck {
  /** The command exactly as the run issued it, bounded for display. */
  command: string
  /** Derived from the tool's terminal state, never from prose. */
  outcome: 'passed' | 'failed' | 'aborted'
  /** The harness-reported exit code, when the harness reported one. */
  exitCode?: number
  /** Bounded tail of the command's own output. */
  tail?: string
}

/** Counts a folded receipt can state in one line. */
export interface RunReceiptTotals {
  count: number
  additions: number
  deletions: number
}

/** A receipt, ready to render or explicitly unable to be. */
export interface RunReceipt {
  state: RunReceiptState
  projectId: string
  threadId: string
  scope: RunReceiptScope
  baseSha: string | null
  headSha: string | null
  commits: RunReceiptCommit[]
  files: RunReceiptFile[]
  /** What the run left in the working tree: the same shape, unstaged reality. */
  uncommitted: RunReceiptFile[]
  checks: RunReceiptCheck[]
  totals: RunReceiptTotals
  uncommittedTotals: RunReceiptTotals
  /** Checks that ran, counted separately because they are not line counts. */
  checkCounts: { passed: number; failed: number; aborted: number }
  /** Each list states its own cut, so a bounded read can never look complete. */
  truncated: { commits: boolean; files: boolean; uncommitted: boolean }
  /** Present for `parked` and `error`, in the app's own words. */
  reason?: string
  /** When main read the facts. A cached receipt keeps the time it was read. */
  readAt: number
}

/** Bounds one receipt read applies, so a huge changeset cannot flood the IPC. */
export interface RunReceiptBounds {
  commits: number
  files: number
  checks: number
  /** Characters of a command's own output kept as its tail. */
  checkTail: number
}

export const DEFAULT_RUN_RECEIPT_BOUNDS: RunReceiptBounds = {
  commits: 20,
  files: 100,
  checks: 20,
  checkTail: 400
}
