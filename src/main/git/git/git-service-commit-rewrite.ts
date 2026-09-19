import { rm } from 'fs/promises'
import { isAbsolute, resolve } from 'path'
import type { SimpleGit } from 'simple-git'
import { createGitClient } from './git-service-runtime'
import { detectConflictState } from './git-service-status'
import { isAncestor } from './git-service-diffs'

/** One `git ls-tree` entry: the mode and blob a path holds in a tree. */
interface TreeEntry {
  mode: string
  sha: string
}

/** How many paths a reflog entry names before it summarises the rest. */
const REFLOG_PATH_LIMIT = 2

export interface CommitPathRemoval {
  directory: string
  /** Commit to rewrite, as the history view knows it (a hash). */
  target: string
  /** Repository-relative paths whose changes leave that commit. */
  paths: string[]
}

/**
 * Take the given paths' changes out of one commit and out of nothing else.
 *
 * The rewritten commit holds each path at its parent's version, so the commit
 * looks like it never touched them, and every commit after it is replayed with
 * its own content intact but with a new hash. The working tree is never written
 * to and the index is only moved for those paths, which is what leaves the
 * change behind as an ordinary unstaged one: a file the commit added comes back
 * as untracked, a modification as ` M`, a deletion the commit made as ` D`.
 * Nothing is checked out on the way, so a dirty working tree can neither block
 * the rewrite nor be stashed and restored around it.
 *
 * Refuses rather than guesses whenever the rewrite could not be exact: an
 * unknown or off-branch commit, a merge (the target, or one in the replayed
 * range), a path the commit does not change, a rename, a later commit that
 * touches the same path, a staged edit to it.
 */
export async function removeCommitPathChanges(removal: CommitPathRemoval): Promise<void> {
  const { directory, target, paths } = removal
  if (paths.length === 0) return
  const git = createGitClient(directory)

  const targetSha = await resolveCommit(git, target)
  const headSha = (await git.raw(['rev-parse', 'HEAD'])).trim()
  if (!(await isAncestor(git, targetSha, headSha))) {
    throw new Error('Only a commit on the current branch can be rewritten')
  }
  await assertNoOpenIntegration(git, directory)
  await assertNotMergeCommit(git, targetSha)
  await assertCommitChangesPaths(git, targetSha, paths)
  await assertReplayIsExact(git, targetSha, paths)
  await assertNothingStaged(git, paths)

  const parentSha = await resolveParent(git, targetSha)
  const tip = await replayCommits(git, directory, targetSha, parentSha, paths)

  await git.raw([
    'update-ref',
    '-m',
    `CodeInOven: drop ${describePaths(paths)} from ${targetSha.slice(0, 7)}`,
    await headRefOf(git),
    tip,
    headSha
  ])
  await moveIndexEntries(git, tip, paths)
}

async function replayCommits(
  git: SimpleGit,
  directory: string,
  targetSha: string,
  parentSha: string | null,
  paths: string[]
): Promise<string> {
  const indexPath = await gitDirPath(git, directory, `cio-commit-rewrite-${process.pid}.index`)
  const plumbing = createGitClient(directory).env({ GIT_INDEX_FILE: indexPath })
  try {
    // The root commit has no earlier content for a path, so it is its own
    // reference and a path it added simply leaves its tree.
    const reference = parentSha ?? targetSha
    let rewrittenParent = await rewriteCommit(
      git,
      plumbing,
      indexPath,
      targetSha,
      parentSha,
      reference,
      paths
    )
    for (const source of await replayOrder(git, targetSha)) {
      // Each later commit keeps its own content: it only inherits what the
      // rewritten commit before it holds for the paths that left the range.
      rewrittenParent = await rewriteCommit(
        git,
        plumbing,
        indexPath,
        source,
        rewrittenParent,
        rewrittenParent,
        paths
      )
    }
    return rewrittenParent
  } finally {
    await rm(indexPath, { force: true }).catch(() => undefined)
  }
}

/** Commits after `targetSha`, oldest first: the order a replay has to follow. */
async function replayOrder(git: SimpleGit, targetSha: string): Promise<string[]> {
  const output = await git.raw(['rev-list', '--reverse', `${targetSha}..HEAD`])
  return output.split('\n').filter((line) => line.trim())
}

/**
 * One rewritten commit: `source`'s tree with the given paths replaced by the
 * entries `reference` holds for them, on top of `parentSha`, keeping the
 * original message and the original author and committer stamps so the commit
 * reads exactly as it did apart from the paths that left it.
 */
async function rewriteCommit(
  git: SimpleGit,
  plumbing: SimpleGit,
  indexPath: string,
  source: string,
  parentSha: string | null,
  reference: string,
  paths: string[]
): Promise<string> {
  await plumbing.raw(['read-tree', source])
  for (const path of paths) {
    const entry = await treeEntry(plumbing, reference, path)
    if (!entry) {
      await plumbing.raw(['update-index', '--force-remove', '--', path])
      continue
    }
    await plumbing.raw([
      'update-index',
      '--add',
      '--cacheinfo',
      `${entry.mode},${entry.sha},${path}`
    ])
  }
  const tree = (await plumbing.raw(['write-tree'])).trim()
  const message = (await git.raw(['show', '-s', '--format=%B', source])).replace(/\n+$/u, '')
  const identity = await readIdentity(git, source)
  const args = ['commit-tree', tree, '-m', message]
  if (parentSha) args.push('-p', parentSha)
  const created = await plumbing.env({ GIT_INDEX_FILE: indexPath, ...identity }).raw(args)
  return created.trim()
}

/**
 * The author and committer stamps of a commit, read as the environment git
 * wants them back in: a replayed commit must not be re-dated to now, or every
 * rewritten row in the history view would read as if it happened today.
 */
async function readIdentity(git: SimpleGit, source: string): Promise<Record<string, string>> {
  const format = '%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI'
  const [authorName, authorEmail, authorDate, committerName, committerEmail, committerDate] = (
    await git.raw(['show', '-s', `--format=${format}`, source])
  )
    .trim()
    .split('\0')
  return {
    GIT_AUTHOR_NAME: authorName ?? '',
    GIT_AUTHOR_EMAIL: authorEmail ?? '',
    GIT_AUTHOR_DATE: authorDate ?? '',
    GIT_COMMITTER_NAME: committerName ?? '',
    GIT_COMMITTER_EMAIL: committerEmail ?? '',
    GIT_COMMITTER_DATE: committerDate ?? ''
  }
}

/** Point the index at what the rewritten commit holds for these paths. */
async function moveIndexEntries(git: SimpleGit, tip: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    const entry = await treeEntry(git, tip, path)
    if (!entry) {
      await git.raw(['update-index', '--force-remove', '--', path])
      continue
    }
    await git.raw(['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.sha},${path}`])
  }
}

async function treeEntry(git: SimpleGit, treeish: string, path: string): Promise<TreeEntry | null> {
  const output = (await git.raw(['ls-tree', treeish, '--', path])).trim()
  if (!output) return null
  const [meta] = output.split('\n')
  const [mode, , sha] = (meta ?? '').split(/\s+/u)
  if (!mode || !sha) return null
  return { mode, sha }
}

async function resolveCommit(git: SimpleGit, rev: string): Promise<string> {
  const resolved = await git
    .raw(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
    .then((value) => value.trim())
    .catch(() => '')
  if (!resolved) throw new Error('That commit is no longer in this repository')
  return resolved
}

/** A merge commit's second parent cannot be honoured by a linear replay. */
async function assertNotMergeCommit(git: SimpleGit, sha: string): Promise<void> {
  const second = await git
    .raw(['rev-parse', '--verify', '--quiet', `${sha}^2`])
    .then((value) => value.trim())
    .catch(() => '')
  if (second) throw new Error('A merge commit has no single parent to rewrite it against')
}

async function resolveParent(git: SimpleGit, sha: string): Promise<string | null> {
  const parent = await git
    .raw(['rev-parse', '--verify', '--quiet', `${sha}^`])
    .then((value) => value.trim())
    .catch(() => '')
  return parent || null
}

async function headRefOf(git: SimpleGit): Promise<string> {
  const branch = await git
    .raw(['symbolic-ref', '--quiet', 'HEAD'])
    .then((value) => value.trim())
    .catch(() => '')
  return branch || 'HEAD'
}

async function gitDirPath(git: SimpleGit, directory: string, name: string): Promise<string> {
  const resolved = await git.raw(['rev-parse', '--git-path', name])
  const trimmed = resolved.trim()
  return isAbsolute(trimmed) ? trimmed : resolve(directory, trimmed)
}

/** A merge or an open integration has refs of its own to move; refuse first. */
async function assertNoOpenIntegration(git: SimpleGit, directory: string): Promise<void> {
  const state = await detectConflictState(git, directory)
  if (state === 'merge') throw new Error('Finish or abort the merge before rewriting a commit')
  if (state === 'rebase') throw new Error('Finish or abort the rebase before rewriting a commit')
}

/**
 * Every selected path has to be one the commit itself changes, and a renamed
 * path is refused: taking the rename out would mean putting the old path back
 * as well, and a half-restored rename is worse than saying so.
 */
async function assertCommitChangesPaths(
  git: SimpleGit,
  sha: string,
  paths: string[]
): Promise<void> {
  const output = await git.raw([
    'diff-tree',
    '--root',
    '-r',
    '-M',
    '--no-commit-id',
    '--name-status',
    sha
  ])
  const statuses = new Map<string, string>()
  for (const line of output.split('\n')) {
    const [status, first, second] = line.split('\t')
    if (!status || !first) continue
    statuses.set(second ? second : first, status.charAt(0))
  }
  for (const path of paths) {
    const status = statuses.get(path)
    if (!status) throw new Error(`That commit does not change ${path}`)
    if (status === 'R') {
      throw new Error(`${path} was renamed in that commit, so it cannot be taken out of it`)
    }
  }
}

/**
 * A replay copies each later commit onto the rewritten one, so it can only stay
 * exact while those commits leave the selected paths alone. A merge in the
 * range would also have to be flattened, which is a different rewrite entirely.
 */
async function assertReplayIsExact(git: SimpleGit, sha: string, paths: string[]): Promise<void> {
  const merges = (await git.raw(['rev-list', '--merges', `${sha}..HEAD`])).trim()
  if (merges) {
    throw new Error('A merge commit after it would have to be flattened; rewrite the range first')
  }
  const touched = (await git.raw(['rev-list', `${sha}..HEAD`, '--', ...paths]))
    .split('\n')
    .filter((line) => line.trim())
  if (touched.length === 0) return
  const short = (touched[0] ?? '').slice(0, 7)
  throw new Error(
    `A later commit (${short}) also changes ${describePaths(paths)}; take it out of that commit first`
  )
}

/** A staged edit to these paths is the user's own work: the index move would lose it. */
async function assertNothingStaged(git: SimpleGit, paths: string[]): Promise<void> {
  const staged = (await git.raw(['diff', '--cached', '--name-only', '--', ...paths])).trim()
  if (!staged) return
  throw new Error(`Commit or unstage the changes to ${describePaths(paths)} first`)
}

/** A reflog entry and an error message name the paths, bounded to stay readable. */
function describePaths(paths: string[]): string {
  if (paths.length <= REFLOG_PATH_LIMIT) return paths.join(', ')
  return `${paths.slice(0, REFLOG_PATH_LIMIT).join(', ')} and ${paths.length - REFLOG_PATH_LIMIT} more`
}
