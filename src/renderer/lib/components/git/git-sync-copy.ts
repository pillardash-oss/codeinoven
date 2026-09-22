import { toast } from 'svelte-sonner'
import { showToastWarning } from '$lib/stores/app-errors.svelte'
import type { DanglingReference, GitSyncResult } from '$shared/types'

/**
 * Report a completed sync exactly once, in the words the picker used for the
 * other end.
 *
 * Both surfaces that can start a sync (the Git panel and a scope's own menu)
 * report through here, so the same operation can never describe itself
 * differently depending on where the user clicked. A conflicted integration is
 * a warning rather than an error: the commits are on disk to reconcile, and the
 * conflict UI is the next step, not a retry.
 */
export function reportSyncResult(result: GitSyncResult): void {
  const peer = result.peerLabel

  if (result.status.conflicted.length > 0) {
    showToastWarning(
      result.direction === 'from'
        ? `Syncing from ${peer} hit conflicts. Resolve them in this checkout.`
        : `Rebasing onto ${result.peerBranch} hit conflicts. Resolve them here, then sync to ${peer} again.`
    )
    return
  }

  if (result.direction === 'from') {
    const summary =
      result.incoming === 0
        ? `Already up to date with ${peer}`
        : `Synced ${String(result.incoming)} commit${result.incoming === 1 ? '' : 's'} from ${peer}`
    if (result.remote && !result.fetched) {
      showToastWarning(`${summary}. ${result.remote}/${result.peerBranch} could not be refreshed.`)
      return
    }
    if (reportIntegrationFindings(summary, result)) return
    toast.success(summary)
    return
  }

  const summary =
    result.incoming === 0
      ? `Nothing to send: ${peer} already has ${result.branch}'s commits`
      : `Sent ${String(result.incoming)} commit${result.incoming === 1 ? '' : 's'} to ${peer}`
  if (result.peerAhead > 0) {
    toast.success(
      `${summary}. ${result.peerBranch} has ${String(result.peerAhead)} unpushed commit${result.peerAhead === 1 ? '' : 's'}.`
    )
    return
  }
  if (reportIntegrationFindings(summary, result)) return
  toast.success(summary)
}

/**
 * Strategy wording for the chooser, per direction. The three strategies do not
 * mean the same thing in both directions, so the sentences are chosen by
 * direction rather than composed from a fragment.
 */
export function syncStrategyNotes(direction: 'from' | 'to'): { label: string; note: string }[] {
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

/** How many broken imports a toast names before it counts the rest. */
const MAX_LISTED_REFERENCES = 3

/**
 * Report what the integration left behind, in the checkout the commits landed
 * in, and return true when it warned instead of reporting a plain success.
 *
 * Both findings are silent by nature: git reports a clean integration either
 * way, and the breakage only shows up in the checkout's next build or start.
 */
function reportIntegrationFindings(summary: string, result: GitSyncResult): boolean {
  const references = result.danglingReferences
  const manifests = result.changedDependencyManifests
  if (references.length === 0 && manifests.length === 0) return false

  const findings: string[] = []
  if (references.length > 0) {
    findings.push(`${String(references.length)} broken import${references.length === 1 ? '' : 's'}`)
  }
  if (manifests.length > 0) {
    findings.push(
      `${String(manifests.length)} changed dependency manifest${manifests.length === 1 ? '' : 's'}`
    )
  }

  showToastWarning(`${summary}, leaving ${findings.join(' and ')}.`, {
    duration: 20_000,
    description: describeIntegrationFindings(references, manifests)
  })
  return true
}

/**
 * One line, because a toast description is a single line: what is broken, and
 * what has to run before this checkout is usable again.
 */
function describeIntegrationFindings(references: DanglingReference[], manifests: string[]): string {
  const listed = references
    .slice(0, MAX_LISTED_REFERENCES)
    .map((reference) => `${reference.file} imports ${reference.specifier}, which was removed`)
  const remaining = references.length - listed.length
  if (remaining > 0) listed.push(`and ${String(remaining)} more`)
  if (manifests.length > 0) {
    listed.push(`Run the setup for this checkout again: ${manifests.join(', ')} changed`)
  }
  return listed.join('. ')
}
