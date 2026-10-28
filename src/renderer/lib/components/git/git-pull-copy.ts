import type { GitPullJob } from '$lib/stores/git-pull-jobs.svelte'
import type { GitPullStrategy, GitStatus } from '$shared/types'
import { syncIntegrationLabel } from './git-sync-copy'

/**
 * What one pull is about to do, what a finished pull moved, and how a run
 * stands in the dock chip.
 *
 * The split button's menu, the chooser and the run panel all read the strategy
 * wording from here, so a strategy the user picked is described identically
 * before and after the chooser is gone.
 */

/** One strategy as every pull surface offers it. */
export interface PullStrategyOption {
  value: GitPullStrategy
  label: string
  /** One sentence on what the strategy does to this checkout. */
  note: string
}

/**
 * The three strategies, in the order the surfaces offer them: the safest first,
 * the one that can rewrite local commits last.
 */
export const PULL_STRATEGY_OPTIONS: readonly PullStrategyOption[] = [
  {
    value: 'ff-only',
    label: 'Fast-forward only',
    note: 'Integrates only when no reconciliation is needed, and refuses otherwise.'
  },
  {
    value: 'rebase',
    label: 'Rebase',
    note: "Replays this checkout's commits on top of the remote branch, rewriting them."
  },
  {
    value: 'merge',
    label: 'Merge',
    note: 'Keeps both histories and may create a merge commit.'
  }
]

/** The one-word name of a strategy, for a menu or a line of detail. */
export function pullStrategyLabel(strategy: GitPullStrategy): string {
  return PULL_STRATEGY_OPTIONS.find((option) => option.value === strategy)?.label ?? 'Merge'
}

/** The remote ref a run reads, e.g. `origin/main`. */
export function pullRef(remote: string, branch: string): string {
  return `${remote}/${branch}`
}

/** What the run is doing, in one line, in the same words a sync uses. */
export function pullIntegrationLabel(
  strategy: GitPullStrategy,
  remote: string,
  branch: string
): string {
  return syncIntegrationLabel('from', strategy, pullRef(remote, branch))
}

/** What a finished pull reports. */
export interface PullOutcomeCopy {
  /**
   * Whether the commits landed cleanly. `attention` means the run needs the
   * user: conflicts to resolve, or commits now waiting to be published.
   */
  tone: 'success' | 'attention'
  /** One sentence: what moved, or why it did not. */
  summary: string
  /** One line each for what to do or look at next; empty when there is nothing. */
  notes: string[]
}

/** How many conflicted files the panel names before it counts the rest. */
const MAX_LISTED_FILES = 3

function counted(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

/** What the strategy did to the branch, once it landed. */
function landedSummary(strategy: GitPullStrategy, ref: string): string {
  if (strategy === 'rebase') return `Rebased this checkout onto ${ref}`
  if (strategy === 'ff-only') return `Fast-forwarded this checkout to ${ref}`
  return `Merged ${ref} into this checkout`
}

/**
 * The outcome of one run, from the status the pull left behind. Null while the
 * run has not answered: a pull that never read a status reports its refusal
 * through `error` alone.
 */
export function pullOutcomeCopy(job: GitPullJob): PullOutcomeCopy | null {
  const result = job.result
  if (!result) return null

  const ref = pullRef(job.remote, job.branch)
  const conflicted = result.conflicted
  if (conflicted.length > 0) {
    const listed = conflicted.slice(0, MAX_LISTED_FILES)
    const remaining = conflicted.length - listed.length
    const files =
      remaining > 0
        ? `${listed.join(', ')} and ${counted(remaining, 'more file')}`
        : listed.join(', ')
    return {
      tone: 'attention',
      summary: `Pull from ${ref} stopped on a conflict`,
      notes: [
        `Resolve ${files} in the Changes view, then commit to finish the integration.`,
        'Nothing was rolled back: the commits that arrived are in this checkout.'
      ]
    }
  }

  return {
    tone: result.ahead > 0 ? 'attention' : 'success',
    summary: landedSummary(job.strategy, ref),
    notes: outcomeNotes(result, ref)
  }
}

/** What to look at once the commits are in, if anything. */
function outcomeNotes(result: GitStatus, ref: string): string[] {
  const notes: string[] = []
  if (result.ahead > 0) {
    notes.push(
      `${counted(result.ahead, 'commit')} on this branch ${result.ahead === 1 ? 'is' : 'are'} waiting to be pushed to ${ref}.`
    )
  }
  notes.push('Nothing was pushed to a remote.')
  return notes
}

/** The run's own line for the dock chip. */
export function gitPullJobStatusLabel(job: GitPullJob): string {
  if (job.result) return pullOutcomeCopy(job)?.summary ?? 'Pulled'
  if (job.status === 'running') return pullIntegrationLabel(job.strategy, job.remote, job.branch)
  return 'Failed'
}
