import type { GitPullStrategy, GitSyncDirection, GitSyncResult } from '$shared/types'
import type { GitSyncJob } from '$lib/stores/git-sync-jobs.svelte'

/**
 * What one sync is about to do, in one line: the strategy, the direction, and
 * the end it trades commits with, named the way the chooser named it.
 *
 * The chooser's footer, the checklist line of the run panel and its dock chip
 * all read this, so a strategy the user picked is described identically after
 * the modal is gone.
 */
export function syncIntegrationLabel(
  direction: GitSyncDirection,
  strategy: GitPullStrategy,
  peerLabel: string
): string {
  if (direction === 'from') {
    if (strategy === 'rebase') return `Rebasing this checkout onto ${peerLabel}`
    if (strategy === 'ff-only') return `Fast-forwarding from ${peerLabel}`
    return `Merging ${peerLabel} into this checkout`
  }
  if (strategy === 'rebase')
    return `Rebasing this checkout onto ${peerLabel}, then fast-forwarding it`
  if (strategy === 'ff-only') return `Fast-forwarding ${peerLabel} to this branch`
  return `Merging this branch into ${peerLabel}`
}

/**
 * What a finished sync reports: how it ended, what moved, and what it left
 * behind.
 *
 * The run panel is the only surface a sync reports through, so the outcome is
 * described here once and rendered there, whatever started the run.
 */
export interface SyncOutcomeCopy {
  /**
   * Whether the commits landed cleanly. `attention` means something about this
   * run needs the user: conflicts to resolve, a remote ref that could not be
   * refreshed, or work the integration left behind in one of the checkouts.
   */
  tone: 'success' | 'attention'
  /** One sentence: what moved, or why it did not. */
  summary: string
  /** One line each for what to do or look at next; empty when there is nothing. */
  notes: string[]
  /** One line per thing the integration left behind; empty when it left nothing. */
  findings: string[]
}

/** What a finished sync reports, in the words the chooser used for the other end. */
export function syncOutcomeCopy(result: GitSyncResult): SyncOutcomeCopy {
  const peer = result.peerLabel
  const findings = integrationFindings(result)
  const tone = findings.length > 0 ? 'attention' : 'success'
  /**
   * What the checkout the integration wrote into needs before it is usable again.
   * Named by this run's direction rather than by the peer's label, which is a noun
   * phrase and would read as a sentence starting mid-thought.
   */
  const leftBehind =
    result.direction === 'from'
      ? 'This checkout needs attention before its next build or start.'
      : 'The other end needs attention before its next build or start.'

  if (result.status.conflicted.length > 0) {
    return {
      tone: 'attention',
      summary:
        result.direction === 'from'
          ? `Syncing from ${peer} hit conflicts`
          : `Rebasing onto ${result.peerBranch} hit conflicts`,
      notes: [
        result.direction === 'from'
          ? 'Resolve them in this checkout, then continue the integration.'
          : `Resolve them here, then sync to ${peer} again.`
      ],
      findings
    }
  }

  if (result.direction === 'from') {
    const summary =
      result.incoming === 0
        ? `Already up to date with ${peer}`
        : `Synced ${counted(result.incoming, 'commit')} from ${peer}`
    if (result.remote && !result.fetched) {
      return {
        tone: 'attention',
        summary,
        notes: [
          `${result.remote}/${result.peerBranch} could not be refreshed, so this run compared the local ref.`,
          ...(findings.length > 0 ? [leftBehind] : [])
        ],
        findings
      }
    }
    return { tone, summary, notes: findings.length > 0 ? [leftBehind] : [], findings }
  }

  const summary =
    result.incoming === 0
      ? `Nothing to send: ${peer} already has ${result.branch}'s commits`
      : `Sent ${counted(result.incoming, 'commit')} to ${peer}`
  return {
    tone,
    summary,
    notes: [
      ...(result.peerAhead > 0
        ? [`${result.peerBranch} has ${counted(result.peerAhead, 'unpushed commit')}.`]
        : []),
      ...(findings.length > 0 ? [leftBehind] : [])
    ],
    findings
  }
}

/**
 * What the run panel and its dock chip say the run is doing, or how it ended.
 *
 * A finished run reports its own outcome, so a docked chip never summarizes a
 * failed sync as "Failed" when git already named what happened.
 */
export function gitSyncJobStatusLabel(job: GitSyncJob): string {
  if (job.result) return syncOutcomeCopy(job.result).summary
  if (job.status === 'running') {
    return syncIntegrationLabel(job.direction, job.strategy, job.peerLabel)
  }
  return 'Failed'
}

/**
 * Strategy wording for the chooser, per direction. The three strategies do not
 * mean the same thing in both directions, so the sentences are chosen by
 * direction rather than composed from a fragment.
 */
export function syncStrategyNotes(direction: GitSyncDirection): { label: string; note: string }[] {
  if (direction === 'from') {
    return [
      {
        label: 'Merge',
        note: 'Keeps both histories and may create a merge commit.'
      },
      {
        label: 'Rebase',
        note: "Replays this checkout's commits on top of the other end."
      },
      {
        label: 'Fast-forward only',
        note: 'Integrates only when no reconciliation is needed.'
      }
    ]
  }
  return [
    {
      label: 'Merge',
      note: 'Merges this branch into the other end and refuses if that would conflict. Resolve it here with a sync from that end instead.'
    },
    {
      label: 'Rebase',
      note: "Replays this branch's commits on top of the other end, then moves it onto them. Keeps the other end linear, rewrites this branch."
    },
    {
      label: 'Fast-forward only',
      note: 'Moves the other end only when it has not yet diverged.'
    }
  ]
}

/** How many broken imports a panel names before it counts the rest. */
const MAX_LISTED_REFERENCES = 3

/**
 * What the integration left behind, in the checkout it wrote into, one line
 * each.
 *
 * Both findings are silent by nature: git reports a clean integration either
 * way, and the breakage only shows up in the checkout's next build or start.
 * `from` writes this checkout, so the setup to run again is this one's; `to`
 * writes the peer, so the peer is the checkout that is stale.
 */
function integrationFindings(result: GitSyncResult): string[] {
  const findings: string[] = []
  const references = result.danglingReferences
  const listed = references.slice(0, MAX_LISTED_REFERENCES)
  for (const reference of listed) {
    findings.push(`${reference.file} imports ${reference.specifier}, which the integration removed`)
  }
  const remaining = references.length - listed.length
  if (remaining > 0) findings.push(`and ${counted(remaining, 'more broken import')}`)
  if (result.changedDependencyManifests.length > 0) {
    const manifests = result.changedDependencyManifests.join(', ')
    findings.push(
      result.direction === 'from'
        ? `Run this checkout's setup again: ${manifests} changed`
        : `Run the setup for ${result.peerLabel} again: ${manifests} changed`
    )
  }
  return findings
}

/** `1 commit`, `3 commits`. */
function counted(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}
