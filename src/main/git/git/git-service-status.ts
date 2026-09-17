import { access } from 'fs/promises'
import { realpathSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import type { DefaultLogFields, SimpleGit, StatusResult } from 'simple-git'
import { toPosixPath } from '../../../lib/paths'
import type {
  GitBranchInfo,
  GitCommitInfo,
  GitCommitRef,
  GitFileChange,
  GitFileStatus,
  GitStatus,
  MergeSummary
} from '../../../lib/types'
import { parseWorktreePorcelain } from '../scope-worktree/scope-worktree-porcelain'

/** Number of commits returned by `git log` by default. */
export const DEFAULT_LOG_LIMIT = 50

/**
 * The `git log` fields this service reads. It mirrors simple-git's
 * `DefaultLogFields`   passing a custom `format` replaces those defaults
 * wholesale, so every field the mapper reads has to be listed here   and adds
 * `%P`, which carries the parent hashes the graph view draws its lanes from.
 */
export interface HistoryLogFields extends DefaultLogFields {
  parents: string
}

/** `%P` renders space-separated parent hashes; a root commit renders empty. */
export function parseCommitParents(raw: string): string[] {
  return raw.split(' ').filter((hash) => hash.length > 0)
}

/**
 * `%D` renders decorations as `HEAD -> main, origin/main, tag: v1.0`.
 * Normalized to `{ name, kind, head }` so no renderer parses git's syntax.
 */
export function parseCommitRefs(raw: string): GitCommitRef[] {
  const refs: GitCommitRef[] = []
  for (const decoration of raw.split(',')) {
    const trimmed = decoration.trim()
    if (trimmed.length === 0) continue
    if (trimmed === 'HEAD') {
      refs.push({ name: 'HEAD', kind: 'branch', head: true })
      continue
    }
    const isHead = trimmed.startsWith('HEAD -> ')
    const name = isHead ? trimmed.slice('HEAD -> '.length) : trimmed
    if (name.startsWith('tag: ')) {
      refs.push({ name: name.slice('tag: '.length), kind: 'tag', head: isHead })
      continue
    }
    refs.push({ name, kind: 'branch', head: isHead })
  }
  return refs
}

export function isUnbornBranchLogError(failure: unknown): boolean {
  if (!(failure instanceof Error)) return false
  const error = failure as { gitError?: string; message: string }
  const message = error.gitError ?? error.message
  return message.includes('does not have any commits yet')
}

export function mapCommit(entry: HistoryLogFields): GitCommitInfo {
  return {
    hash: entry.hash,
    shortHash: entry.hash.slice(0, 7),
    author: entry.author_name ?? entry.author_email ?? 'unknown',
    date: entry.date ? new Date(entry.date).getTime() : Date.now(),
    message: entry.message,
    body: entry.body,
    parents: parseCommitParents(entry.parents),
    refs: parseCommitRefs(entry.refs)
  }
}

/**
 * Detect an in-progress merge or rebase from git's control files.
 *
 * The control file is located through Git (`rev-parse --git-path`) rather
 * than assumed at `<checkout>/.git`: in a linked worktree `.git` is a file
 * pointing at `.git/worktrees/<name>`, so probing the checkout path would
 * report `none` for a worktree that is mid-merge and hide the conflict
 * controls (abort, resolve) the panel offers.
 */
export async function detectConflictState(
  git: SimpleGit,
  directory: string
): Promise<'merge' | 'rebase' | 'none'> {
  const controlPath = async (name: string): Promise<string> => {
    const resolved = await git
      .raw(['rev-parse', '--git-path', name])
      .then((value) => value.trim())
      .catch(() => '')
    if (!resolved) return resolve(directory, '.git', name)
    return isAbsolute(resolved) ? resolved : resolve(directory, resolved)
  }
  const probe = async (candidate: string): Promise<boolean> => {
    try {
      await access(candidate)
      return true
    } catch {
      return false
    }
  }
  if (await probe(await controlPath('MERGE_HEAD'))) return 'merge'
  const rebaseMerge = await probe(await controlPath('rebase-merge'))
  const rebaseApply = await probe(await controlPath('rebase-apply'))
  if (rebaseMerge || rebaseApply) return 'rebase'
  return 'none'
}

export function mapStatus(
  directory: string,
  status: StatusResult,
  conflictState: 'merge' | 'rebase' | 'none'
): GitStatus {
  const conflicted = status.conflicted
  const changes: GitFileChange[] = []
  for (const file of status.files) {
    const path = toPosixPath(file.path)
    const indexMarker = file.index?.trim() ?? ''
    const workMarker = file.working_dir?.trim() ?? ''
    const staged = indexMarker.length > 0 && indexMarker !== '?'
    const untracked = workMarker === '?' || status.not_added.includes(path)

    const push = (entry: GitFileChange): void => {
      changes.push(entry)
    }

    if (conflicted.includes(path)) {
      push({
        path,
        ...(file.from ? { oldPath: toPosixPath(file.from) } : {}),
        status: 'conflicted',
        staged
      })
      continue
    }
    if (untracked) {
      push({ path, status: 'untracked', staged: false })
      continue
    }

    const statusKind: GitFileStatus = file.from
      ? 'renamed'
      : file.index === 'D' || file.working_dir === 'D'
        ? 'deleted'
        : staged
          ? 'added'
          : 'modified'
    push({
      path,
      ...(file.from ? { oldPath: toPosixPath(file.from) } : {}),
      status: statusKind,
      staged
    })
    // git reports a file staged AND modified again as one entry with both
    // index and worktree markers ("MM"). Surface the unstaged half too so the
    // panel shows both the staged snapshot and the further modifications.
    if (staged && workMarker.length > 0 && workMarker !== '?' && workMarker !== 'D') {
      push({ path, status: 'modified', staged: false })
    }
  }

  const stagedChanges = changes.filter(
    (change) => change.staged && change.status !== 'conflicted'
  ).length
  const untrackedChanges = changes.filter((change) => change.status === 'untracked').length
  const unstagedChanges = changes.filter(
    (change) => !change.staged && change.status !== 'untracked' && change.status !== 'conflicted'
  ).length

  return {
    repositoryRoot: directory,
    branch: status.current ? status.current : null,
    detached: Boolean(status.current && status.current === 'HEAD'),
    upstream: status.tracking ?? null,
    conflictState,
    clean: status.isClean(),
    changes,
    stagedChanges,
    unstagedChanges,
    untrackedChanges,
    conflicted,
    ahead: status.ahead ?? 0,
    behind: status.behind ?? 0
  }
}

/** Map branch short names to the worktree paths that hold them. The entry for the checkout
 *  being operated on (`directory`) is skipped: its branch is the panel's current branch and
 *  already carries `current`, so it must not be double-flagged as a foreign worktree. Every
 *  other checkout   including the primary repository when viewed from a linked worktree  
 *  flags its branch, because git refuses checking that branch out anywhere else. */
export function worktreeBranchPaths(raw: string, directory: string): Map<string, string> {
  const entries = parseWorktreePorcelain(raw).entries
  const paths = new Map<string, string>()
  const directoryKey = worktreePathKey(directory)
  for (const entry of entries) {
    if (!entry.head?.startsWith('refs/heads/')) continue
    // Git reports realpaths; the operating directory may still contain symlinks, so both
    // sides are normalized before comparing (lexical fallback for vanished worktrees).
    if (worktreePathKey(entry.path) === directoryKey) continue
    paths.set(entry.head.slice('refs/heads/'.length), entry.path)
  }
  return paths
}

/** Stable comparison key for a worktree path: real location, or lexical resolution when the
 *  path no longer exists on disk. */
export function worktreePathKey(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

export function parseBranchRefs(
  raw: string,
  remoteNames: string[],
  worktreePaths: ReadonlyMap<string, string>
): GitBranchInfo[] {
  // `refname:short` disambiguates when a tag shares the branch's name (e.g. a
  // `nightly` tag and `nightly` branch render as `heads/nightly`), so the
  // operational branch `name` must be derived from the full ref instead
  // `git branch -d heads/nightly` fails with "branch not found".
  const localRefPrefix = 'refs/heads/'
  const remoteRefPrefix = 'refs/remotes/'
  const namesBySpecificity = [...remoteNames].sort((left, right) => right.length - left.length)
  const branches: GitBranchInfo[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const [fullRef, ref, head, upstream, remoteName, drift, symbolicTarget] = line.split('\t')
    if (!fullRef || !ref) continue
    if (fullRef.startsWith(localRefPrefix)) {
      const ahead = /ahead (\d+)/u.exec(drift ?? '')?.[1] ?? '0'
      const behind = /behind (\d+)/u.exec(drift ?? '')?.[1] ?? '0'
      const name = fullRef.slice(localRefPrefix.length)
      branches.push({
        kind: 'local',
        name,
        ref,
        current: head?.trim() === '*',
        remote: remoteName || null,
        upstream: upstream || null,
        ahead: Number.parseInt(ahead, 10) || 0,
        behind: Number.parseInt(behind, 10) || 0,
        worktreePath: worktreePaths.get(name) ?? null
      })
      continue
    }
    if (!fullRef.startsWith(remoteRefPrefix) || symbolicTarget) continue
    const relativeRef = fullRef.slice(remoteRefPrefix.length)
    const remote = namesBySpecificity.find((name) => relativeRef.startsWith(`${name}/`))
    if (!remote) continue
    const name = relativeRef.slice(remote.length + 1)
    if (!name || name === 'HEAD') continue
    branches.push({
      kind: 'remote',
      name,
      ref,
      current: false,
      remote,
      upstream: null,
      ahead: 0,
      behind: 0,
      worktreePath: null
    })
  }
  return branches
}

export function mapMergeResult(result: {
  conflicts?: Array<{ file?: string | null; reason?: string }>
  result?: string
  conflicted?: boolean
}): MergeSummary {
  const conflicts = result.conflicts ?? []
  const conflictedFiles = conflicts
    .map((conflict) => ({
      path: conflict.file ?? '',
      ...(conflict.reason ? { reason: conflict.reason } : {})
    }))
    .filter((entry) => entry.path.length > 0)
  const resultText = result.result ?? 'Merge completed.'
  const conflicted = result.conflicted ?? conflictedFiles.length > 0
  return {
    conflicted: conflictedFiles,
    merged: [],
    result: conflicted ? `${resultText} (${conflictedFiles.length} conflicted)` : resultText,
    aborted: false
  }
}

export function emptyMergeResult(result: string): MergeSummary {
  return { conflicted: [], merged: [], result, aborted: false }
}
