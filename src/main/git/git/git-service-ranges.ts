import type { GitFileStatus } from '../../../lib/types'
import type { GitServiceCore } from './git-service-core'

/**
 * One file a commit range touched, with the line counts Git itself reported.
 *
 * Deliberately not a `GitDiff`: a receipt summarises a range, so it needs the
 * counts for every file at once and the diff text for none of them.
 */
export interface GitRangeFile {
  path: string
  oldPath?: string
  status: GitFileStatus
  additions: number
  deletions: number
  binary: boolean
}

/**
 * Range statistics: what a commit range changed, read in one bounded pair of
 * Git calls rather than one call per file.
 *
 * A run receipt answers "what did this run do" for a range from the run's base
 * to HEAD, and the same question for the working tree when the run left changes
 * uncommitted. Diffing per file would issue one Git process per changed path,
 * which on a large changeset is exactly the storm the receipt must never cause,
 * so both reads happen here, once each, and the caller shapes the result.
 */
export class GitServiceRanges {
  constructor(private readonly core: GitServiceCore) {}

  /**
   * Files changed in `from..to`, or in the working tree when `to` is omitted.
   *
   * `-M` makes Git report renames by their source path instead of a delete plus
   * an add, and `-z` removes the quoting that would otherwise mangle a path with
   * a space or a non-ASCII character.
   */
  async rangeFiles(projectPath: string, from: string, to?: string): Promise<GitRangeFile[]> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      return this.core.wrapError(projectPath, 'read', async () => {
        const git = this.core.client(directory)
        const range = to === undefined ? [from] : [from, to]
        const [statusText, numstatText] = await Promise.all([
          git.diff(['--name-status', '-M', '-z', ...range]),
          git.diff(['--numstat', '-M', '-z', ...range])
        ])
        return mergeRangeReads(parseNameStatus(statusText), parseNumstat(numstatText))
      })
    })
  }
}

/** Git's single-letter change kinds, as `--name-status` prints them. */
function statusFromLetter(letter: string): GitFileStatus {
  switch (letter[0]) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'added'
    case 'U':
      return 'conflicted'
    default:
      return 'modified'
  }
}

interface RangeEntry {
  path: string
  oldPath?: string
  status: GitFileStatus
}

/** Parse `git diff --name-status -z`, whose records are letter then path(s). */
export function parseNameStatus(text: string): RangeEntry[] {
  const tokens = text.split('\0')
  const entries: RangeEntry[] = []
  let index = 0
  while (index < tokens.length) {
    const letter = tokens[index]?.trim()
    index += 1
    if (!letter) continue
    const first = tokens[index]
    index += 1
    if (first === undefined) break
    if (letter.startsWith('R') || letter.startsWith('C')) {
      const second = tokens[index]
      index += 1
      if (second === undefined) break
      entries.push({ path: second, oldPath: first, status: statusFromLetter(letter) })
      continue
    }
    entries.push({ path: first, status: statusFromLetter(letter) })
  }
  return entries
}

interface NumstatEntry {
  path: string
  oldPath?: string
  additions: number
  deletions: number
  binary: boolean
}

/** Parse `git diff --numstat -z`, whose rename records carry two paths. */
export function parseNumstat(text: string): NumstatEntry[] {
  const tokens = text.split('\0')
  const entries: NumstatEntry[] = []
  let index = 0
  while (index < tokens.length) {
    const record = tokens[index]
    index += 1
    if (!record) continue
    const parts = record.split('\t')
    const added = parts[0] ?? '0'
    const deleted = parts[1] ?? '0'
    const inlinePath = parts[2]
    const binary = added === '-' || deleted === '-'
    const additions = binary ? 0 : Number.parseInt(added, 10) || 0
    const deletions = binary ? 0 : Number.parseInt(deleted, 10) || 0
    if (inlinePath && inlinePath.length > 0) {
      entries.push({ path: inlinePath, additions, deletions, binary })
      continue
    }
    // A rename: the record carried no path, so the next two tokens are the
    // source and the destination.
    const from = tokens[index]
    const to = tokens[index + 1]
    index += 2
    if (from === undefined || to === undefined) break
    entries.push({ path: to, oldPath: from, additions, deletions, binary })
  }
  return entries
}

/** Join the two reads by destination path, keeping a rename's source. */
export function mergeRangeReads(
  statuses: readonly RangeEntry[],
  counts: readonly NumstatEntry[]
): GitRangeFile[] {
  const countsByPath = new Map(counts.map((entry) => [entry.path, entry]))
  return statuses.map((entry) => {
    const counts_ = countsByPath.get(entry.path)
    return {
      path: entry.path,
      ...((entry.oldPath ?? counts_?.oldPath)
        ? { oldPath: entry.oldPath ?? counts_?.oldPath }
        : {}),
      status: entry.status,
      additions: counts_?.additions ?? 0,
      deletions: counts_?.deletions ?? 0,
      binary: counts_?.binary ?? false
    }
  })
}
