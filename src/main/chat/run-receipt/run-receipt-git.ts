import type {
  GitFileStatus,
  GitStatus,
  RunReceiptBounds,
  RunReceiptCommit,
  RunReceiptFile
} from '../../../lib/types'
import { DEFAULT_RUN_RECEIPT_BOUNDS } from '../../../lib/types'

/**
 * The Git facts behind a receipt, read in a fixed number of bounded calls.
 *
 * A receipt for a run needs three things from Git and nothing else: the branch
 * it ended on, the commits it made, and the files it touched. Each is one read
 * for the whole range, so the cost is constant no matter how large the changeset
 * is   never one process per file, and never a synchronous child process on the
 * main thread.
 *
 * The port is deliberately narrow so a test can count the calls a receipt makes
 * and fail loudly when a later change reintroduces a per-file read.
 */

/** The Git operations a receipt read uses, and the only ones it may use. */
export interface ReceiptGit {
  getStatus(projectPath: string): Promise<GitStatus>
  log(projectPath: string, limit: number): Promise<{ hash: string; shortHash: string; message: string; author: string; date: number }[]>
  rangeFiles(
    projectPath: string,
    from: string,
    to?: string
  ): Promise<
    { path: string; oldPath?: string; status: GitFileStatus; additions: number; deletions: number; binary: boolean }[]
  >
}

/** Everything one receipt read learns from Git. */
export interface ReceiptGitFacts {
  branch: string | null
  headSha: string | null
  commits: RunReceiptCommit[]
  files: RunReceiptFile[]
  uncommitted: RunReceiptFile[]
  truncated: { commits: boolean; files: boolean; uncommitted: boolean }
}

/** A Git file status mapped to the receipt's own letters. */
function receiptStatus(status: GitFileStatus): RunReceiptFile['status'] {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'added'
    case 'deleted':
      return 'deleted'
    case 'renamed':
      return 'renamed'
    default:
      return 'modified'
  }
}

function toReceiptFile(file: {
  path: string
  oldPath?: string
  status: GitFileStatus
  additions: number
  deletions: number
  binary: boolean
}): RunReceiptFile {
  return {
    path: file.path,
    ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
    status: receiptStatus(file.status),
    additions: file.additions,
    deletions: file.deletions,
    binary: file.binary
  }
}

/**
 * Commits reachable from HEAD but not from the base, newest first.
 *
 * The log read is bounded, and it stops the moment it reaches the base, so a run
 * that made three commits never pays for the checkout's whole history. If the
 * bound is reached first, the list says it was truncated rather than pretending
 * the run made exactly `bounds.commits` commits.
 */
export function commitsSince(
  entries: readonly { hash: string; shortHash: string; message: string; author: string; date: number }[],
  baseSha: string,
  bounds: RunReceiptBounds = DEFAULT_RUN_RECEIPT_BOUNDS
): { commits: RunReceiptCommit[]; truncated: boolean } {
  const commits: RunReceiptCommit[] = []
  for (const entry of entries) {
    if (entry.hash === baseSha) return { commits, truncated: false }
    commits.push({
      hash: entry.hash,
      shortHash: entry.shortHash,
      subject: entry.message,
      author: entry.author,
      at: entry.date
    })
    if (commits.length >= bounds.commits) return { commits, truncated: true }
  }
  // The base was not in the page, so there may be more commits above the bound.
  return { commits, truncated: entries.length >= bounds.commits }
}

/** Read the branch, commits and files a run's range covers. */
export async function readReceiptGitFacts(
  git: ReceiptGit,
  input: {
    projectPath: string
    baseSha: string
    bounds?: RunReceiptBounds
  }
): Promise<ReceiptGitFacts> {
  const bounds = input.bounds ?? DEFAULT_RUN_RECEIPT_BOUNDS
  // One status read, for the branch and the head commit the range ends at.
  const status = await git.getStatus(input.projectPath)
  // One log read, bounded, walked only as far as the run's base.
  const log = await git.log(input.projectPath, bounds.commits * 4 + 1)
  const { commits, truncated: commitsTruncated } = commitsSince(log, input.baseSha, bounds)
  // The newest commit the log returned is HEAD; without one the range has no
  // readable head and the receipt says so rather than borrowing a sha.
  const headSha = commits[0]?.hash ?? null
  // One range read for the run's own commits, and one for what it left behind.
  const [files, uncommitted] = await Promise.all([
    headSha && headSha !== input.baseSha
      ? git.rangeFiles(input.projectPath, input.baseSha, headSha)
      : Promise.resolve([]),
    git.rangeFiles(input.projectPath, 'HEAD')
  ])
  return {
    branch: status.branch,
    headSha,
    commits,
    files: files.slice(0, bounds.files).map(toReceiptFile),
    uncommitted: uncommitted.slice(0, bounds.files).map(toReceiptFile),
    truncated: {
      commits: commitsTruncated,
      files: files.length > bounds.files,
      uncommitted: uncommitted.length > bounds.files
    }
  }
}
