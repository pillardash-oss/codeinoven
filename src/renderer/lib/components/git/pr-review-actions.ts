import { invoke } from '$lib/ipc.svelte'
import { reportError } from '$lib/stores/app-errors.svelte'
import { scopeJobs } from '$lib/stores/scope-jobs.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { threadSettings } from '$lib/stores/thread-settings.svelte'
import {
  renderPrReviewPromptTemplate,
  prReviewCheckoutSentence,
  type PrReviewPromptFacts
} from '$shared/pr-review-prompt'
import { defaultCioPrompt } from '$shared/cio-prompts'
import {
  DEFAULT_SCOPE_WORKTREE_DEFAULTS,
  type PullRequestSummary,
  type ScopeRootDescriptor
} from '$shared/types'
import { agentAssist } from '../assist/agent-assist-store.svelte'
import { openAgentThread } from './git-status-panel-agent-actions'

export type PrReviewMode = 'self' | 'agent'
const preparations = new Set<string>()

/** The checkout name and branch a manual review of this pull request uses. */
export function prReviewCheckoutName(number: number): string {
  return `cio-pr-review-${number}`
}

/**
 * The brief a review agent receives.
 *
 * The wording is the editable `pr-review` CIO prompt, so a user who wants the
 * agent to fix what it finds instead of only reporting edits it in Settings and
 * this handoff follows. What the renderer adds is the pull request itself: the
 * exact commit to read, the base to compare it with, and the report file.
 */
async function reviewPrompt(
  pr: PullRequestSummary,
  remote: string,
  root: ScopeRootDescriptor | undefined,
  reportPath: string
): Promise<string> {
  const facts: PrReviewPromptFacts = {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseRef: pr.baseRef,
    remote,
    checkout: prReviewCheckoutSentence({
      number: pr.number,
      preparedHeadCommit: root?.kind === 'worktree' ? root.baseCommit : null
    }),
    reportPath
  }
  let template: string
  try {
    template = await invoke('cioPrompts:get', 'pr-review')
  } catch {
    // A prompt that cannot be read still has to produce a review: fall back to
    // the shipped default rather than sending the agent nothing.
    template = defaultCioPrompt('pr-review')
  }
  return renderPrReviewPromptTemplate(template, facts)
}

/**
 * Prepare a manual review of one pull request.
 *
 * "Review yourself" forks the head of the pull request into an isolated checkout
 * and opens a thread on it. "Review with agent" opens the shared setup panel
 * first, so the review runs on a model, thinking level, Oven and scope the user
 * picked, and only then sends the brief.
 */
export async function reviewPullRequest(
  projectId: string,
  pr: PullRequestSummary,
  remote: string,
  mode: PrReviewMode
): Promise<void> {
  if (mode === 'agent') {
    agentAssist.open({
      projectId,
      title: `Review PR #${pr.number} with agent`,
      summary:
        'The agent compares this pull request with its merge base, then reports findings on it.',
      scopeBucketId: null,
      newCheckout: {
        title: prReviewCheckoutName(pr.number),
        pullRequest: { number: pr.number, remote }
      },
      prepare: async ({ scopeBucketId, settings, project }) => {
        const reportTitle = `Review PR #${pr.number}`
        const thread = await invoke('thread:create', {
          projectId,
          providerId: settings.harnessId,
          title: reportTitle,
          workingDirectory: project.path,
          scopeBucketId,
          settings
        })
        if (!thread) throw new Error('The review thread could not be created')
        const assignment = await invoke(
          'pr:createAgentAssignment',
          projectId,
          pr.number,
          thread.id,
          { kind: 'triage', title: reportTitle }
        )
        const root = scopeState.boards
          .get(projectId)
          ?.buckets.find((bucket) => bucket.id === scopeBucketId)?.root
        return {
          threadId: thread.id,
          text: await reviewPrompt(pr, remote, root, assignment.reportPath)
        }
      }
    })
    return
  }

  const key = `${projectId}:${pr.number}`
  const title = prReviewCheckoutName(pr.number)
  if (
    preparations.has(key) ||
    scopeJobs.jobs.some(
      (job) => job.projectId === projectId && job.title === title && job.status === 'running'
    )
  )
    return
  preparations.add(key)
  try {
    const project = await invoke('project:get', projectId)
    if (!project || project.source !== 'local')
      throw new Error('PR review requires a local project')
    await scopeState.ensureBoardLoaded(projectId)
    const defaults =
      scopeState.boards.get(projectId)?.worktreeDefaults ?? DEFAULT_SCOPE_WORKTREE_DEFAULTS
    const settings = { ...threadSettings.lastUsed, assignmentMode: false, loopMode: false }
    // A manual review runs in its local scope even if the last thread used an Oven.
    delete settings.ovenId
    delete settings.ovenPath
    scopeJobs.create(
      projectId,
      {
        title,
        isolated: true,
        pullRequest: { number: pr.number, remote },
        ...defaults,
        // Setup remains a deliberate next step when reviewing third-party code.
        runSetup: false
      },
      {
        prepare: async (scopeBucketId) => {
          const thread = await invoke('thread:create', {
            projectId,
            providerId: settings.harnessId,
            title: `Review PR #${pr.number} yourself`,
            workingDirectory: project.path,
            scopeBucketId,
            settings
          })
          if (!thread)
            throw new Error('The review checkout is ready, but its thread could not be created')
          const open = () => {
            void openAgentThread(projectId, thread.id).catch((error: unknown) =>
              reportError(error, 'Could not open the review thread.')
            )
          }
          return { label: 'Open review', run: open }
        }
      }
    )
  } catch (error) {
    reportError(error, 'Could not prepare the PR review.')
  } finally {
    preparations.delete(key)
  }
}
