import type { SimpleGit } from 'simple-git'
import type { PullRequestCompare, PrComposeInput } from '../../../lib/types'
import { boundedUtf8, refExists, untrackedComposeContext } from './git-service-diffs'

export interface PullRequestComposeContext {
  source: PrComposeInput['source']
  baseRef: string
  headRef: string
  commits: string
  diffSummary: string
  patch: string
  pendingPushBaseRef: string | null
  pendingCommits: string
  pendingDiffSummary: string
  pendingPatch: string
  worktreePatch: string
  untrackedFiles: string
  truncated: boolean
}

/**
 * Compare a local head with the selected merge target without requiring the
 * head to exist on the remote yet. The remote-tracking base is preferred so
 * the result matches the branch GitHub will merge into as closely as the
 * repository's latest fetch allows.
 */
export async function comparePullRequestBranches(
  git: SimpleGit,
  base: string,
  head: string
): Promise<PullRequestCompare | null> {
  const localHead = `refs/heads/${head}`
  if (!(await refExists(git, localHead))) return null

  const remoteBase = `refs/remotes/origin/${base}`
  const localBase = `refs/heads/${base}`
  const baseRef = (await refExists(git, remoteBase))
    ? remoteBase
    : (await refExists(git, localBase))
      ? localBase
      : null
  if (!baseRef) return null

  const counts = await git.raw(['rev-list', '--left-right', '--count', `${baseRef}...${localHead}`])
  const [behindBy = 0, aheadBy = 0] = counts
    .trim()
    .split(/\s+/u)
    .map((value) => Number.parseInt(value, 10))
  const status: PullRequestCompare['status'] =
    aheadBy > 0 && behindBy > 0
      ? 'diverged'
      : aheadBy > 0
        ? 'ahead'
        : behindBy > 0
          ? 'behind'
          : 'identical'
  const summary = await git.diffSummary([`${baseRef}...${localHead}`])
  return {
    source: 'local',
    status,
    aheadBy,
    behindBy,
    totalCommits: aheadBy,
    filesChanged: summary.files.length,
    hasChanges: aheadBy > 0
  }
}

/**
 * Build bounded, read-only evidence for a PR writing task. This never fetches,
 * checks out, stages, or otherwise changes repository state. Remote composition
 * uses cached origin refs. Local composition adds the commits and worktree delta
 * that the next push will publish.
 */
export async function buildPullRequestComposeContext(
  git: SimpleGit,
  directory: string,
  input: PrComposeInput
): Promise<PullRequestComposeContext> {
  const remoteBase = `refs/remotes/origin/${input.base}`
  const localBase = `refs/heads/${input.base}`
  const baseRef = (await refExists(git, remoteBase))
    ? remoteBase
    : (await refExists(git, localBase))
      ? localBase
      : null
  if (!baseRef) {
    throw new Error(`The selected base branch ${input.base} is not available locally`)
  }

  const remoteHead = `refs/remotes/origin/${input.head}`
  const localHead = `refs/heads/${input.head}`
  const headRef =
    input.source === 'remote'
      ? (await refExists(git, remoteHead))
        ? remoteHead
        : null
      : (await refExists(git, localHead))
        ? localHead
        : null
  if (!headRef) {
    const location = input.source === 'remote' ? `origin/${input.head}` : input.head
    throw new Error(`The selected head branch ${location} is not available locally`)
  }

  const fullRange = `${baseRef}..${headRef}`
  const fullDiffRange = `${baseRef}...${headRef}`
  const pendingPushBaseRef =
    input.source === 'local' && (await refExists(git, remoteHead)) ? remoteHead : null
  const pendingRange = pendingPushBaseRef ? `${pendingPushBaseRef}..${headRef}` : fullRange

  const readGit = async (args: string[]): Promise<string> => git.raw(args)
  const [commitsRaw, diffSummary, patchRaw, pendingCommitsRaw, pendingSummary, pendingRaw] =
    await Promise.all([
      readGit(['log', '--max-count=100', '--format=%h%x09%s', fullRange]),
      readGit(['diff', '--stat', fullDiffRange, '--']),
      readGit(['diff', '--no-ext-diff', '--unified=2', fullDiffRange, '--']),
      input.source === 'local'
        ? readGit(['log', '--max-count=100', '--format=%h%x09%s', pendingRange])
        : Promise.resolve(''),
      input.source === 'local'
        ? readGit(['diff', '--stat', pendingRange, '--'])
        : Promise.resolve(''),
      input.source === 'local'
        ? readGit(['diff', '--no-ext-diff', '--unified=2', pendingRange, '--'])
        : Promise.resolve('')
    ])

  const includeWorkingTree = input.source === 'local' && input.includeWorkingTree
  const [worktreeRaw, untracked] = includeWorkingTree
    ? await Promise.all([
        readGit(['diff', '--no-ext-diff', '--unified=2', 'HEAD', '--']),
        untrackedComposeContext(directory, git)
      ])
    : ['', { text: '', truncated: false }]

  const commits = boundedUtf8(commitsRaw.trim(), 16 * 1024)
  const patch = boundedUtf8(patchRaw.trim(), 56 * 1024)
  const pendingCommits = boundedUtf8(pendingCommitsRaw.trim(), 12 * 1024)
  const pendingPatch = boundedUtf8(pendingRaw.trim(), 20 * 1024)
  const worktreePatch = boundedUtf8(worktreeRaw.trim(), 20 * 1024)
  return {
    source: input.source,
    baseRef,
    headRef,
    commits: commits.text,
    diffSummary: diffSummary.trim(),
    patch: patch.text,
    pendingPushBaseRef,
    pendingCommits: pendingCommits.text,
    pendingDiffSummary: pendingSummary.trim(),
    pendingPatch: pendingPatch.text,
    worktreePatch: worktreePatch.text,
    untrackedFiles: untracked.text,
    truncated:
      commits.truncated ||
      patch.truncated ||
      pendingCommits.truncated ||
      pendingPatch.truncated ||
      worktreePatch.truncated ||
      untracked.truncated
  }
}
