import { gitState, GitState } from '$lib/stores/git.svelte'
import { prLifecycleStore } from '$lib/stores/pr-lifecycle.svelte'
import { DEFAULT_SCOPE_BUCKET_ID } from '$shared/types'
import { assignAgentToIssue } from './git-status-panel-agent-actions'
import type { IssueSummary } from '$shared/types'

/**
 * What an issue can be made to do, wherever it was reached from.
 *
 * The Issues tab offers these from its rows and from its reader, and the
 * Notifications view offers them for an issue a notification named, in the
 * repository that notification came from. One implementation each, so the agent
 * brief, the GitHub write and the pull request sheet cannot differ by which door
 * the issue was opened through.
 */

/** Hand one issue to an agent, reading its description first so the brief has it. */
export async function workOnIssue(
  projectId: string,
  identity: { owner: string; repo: string },
  issue: IssueSummary
): Promise<void> {
  await gitState.ensureIssueBundle(projectId, identity.owner, identity.repo, issue.number)
  const body =
    gitState.issueBundles[GitState.issueBundleKey(identity.owner, identity.repo, issue.number)]
      ?.detail.body ?? null
  await assignAgentToIssue(projectId, issue, `${identity.owner}/${identity.repo}`, body)
}

/**
 * Settle an issue on GitHub.
 *
 * A close carries GitHub's own reason, so a dismissal is recorded apart from a
 * resolution. The write becomes an event on the issue's history, so the cached
 * history is dropped for it to be read back rather than shown behind the change.
 * Reports whether GitHub accepted it.
 */
export async function setIssueState(
  projectId: string,
  identity: { owner: string; repo: string },
  issue: IssueSummary,
  state: 'open' | 'closed',
  stateReason?: 'completed' | 'not_planned'
): Promise<boolean> {
  const reference = await gitState.setIssueState(
    projectId,
    identity.owner,
    identity.repo,
    issue.number,
    state,
    stateReason
  )
  if (!reference) return false
  gitState.invalidateConversationTimeline(identity.owner, identity.repo, issue.number)
  return true
}

/**
 * Open the create-PR sheet prefilled to close the issue.
 *
 * The description carries GitHub's own closing keyword, so merging the pull
 * request resolves the issue, and the link makes the connection visible to a
 * reader who arrives at the pull request first. Only meaningful for an issue in
 * the project's own repository: the sheet composes a pull request there.
 */
export function composePullRequestForIssue(
  projectId: string,
  threadId: string,
  scopeBucketId: string,
  issue: IssueSummary
): void {
  prLifecycleStore.open(projectId, threadId, scopeBucketId || DEFAULT_SCOPE_BUCKET_ID, {
    title: issue.title,
    body: `Closes #${issue.number}\n\n${issue.url}`
  })
}
