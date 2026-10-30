import { invoke } from '$lib/ipc.svelte'
import { pathToFileUrl } from '$lib/mime'
import { reportError } from '$lib/stores/app-errors.svelte'
import { gitState } from '$lib/stores/git.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import {
  DEFAULT_SCOPE_BUCKET_ID,
  type GitHubDeployment,
  type GitHubDeploymentJob,
  type GitHubDeploymentJobLog,
  type GitHubWorkflowRun,
  type IssueSummary,
  type Project,
  type PromptAttachment,
  type PullRequestCheck,
  type PullRequestSummary,
  type Thread,
  type ThreadSettings
} from '$shared/types'
import { agentAssist, type AgentAssistPrepared } from '../assist/agent-assist-store.svelte'
import type { PrCommentChatSubject } from './git-status-panel-prompts'
import { jobForCheck } from './pr-check-job'
import {
  prCommentAssignmentPrompt,
  prCheckAssignmentPrompt,
  prTriagePrompt,
  conflictResolutionPrompt,
  deploymentJobDiagnosisPrompt,
  issueWorkPrompt,
  workflowJobDiagnosisPrompt
} from './git-status-panel-prompts'

/**
 * Create the thread an agent handoff runs in.
 *
 * The dialog already resolved the scope and the run configuration, so this is
 * only the record: a thread in that scope, with the confirmed settings. It
 * throws rather than returning null, because a handoff that produced no thread
 * is a failure the dialog has to report.
 */
async function createHandoffThread(input: {
  projectId: string
  projectPath: string
  title: string
  settings: ThreadSettings
  scopeBucketId?: string
}): Promise<Thread> {
  const thread = await invoke('thread:create', {
    projectId: input.projectId,
    providerId: input.settings.harnessId,
    title: input.title,
    workingDirectory: input.projectPath,
    ...(input.scopeBucketId ? { scopeBucketId: input.scopeBucketId } : {}),
    settings: input.settings
  }).catch(() => null)
  if (!thread) throw new Error('The agent thread could not be created')
  return thread
}

/**
 * Save the full job log through the composer's existing pasted-text
 * pipeline (the same one used for long clipboard pastes), so large logs
 * never flow through the prompt itself (which caps at 200k characters).
 */
async function jobLogAttachment(
  projectId: string,
  log: GitHubDeploymentJobLog,
  threadId: string
): Promise<PromptAttachment[]> {
  try {
    const path = await invoke('attachment:saveText', { kind: 'chat', projectId, threadId }, log.log)
    return [{ mime: 'text/plain', url: pathToFileUrl(path), filename: 'Pasted text.txt' }]
  } catch (error) {
    reportError(error, 'Could not attach the job log.')
    return []
  }
}

/** Hand a failed workflow run job to an agent, with the log attached. */
export function diagnoseWorkflowJob(
  projectId: string,
  run: GitHubWorkflowRun,
  job: GitHubDeploymentJob,
  log: GitHubDeploymentJobLog | null
): void {
  agentAssist.open({
    projectId,
    title: `Diagnose ${job.name} with agent`,
    summary: `The agent reads the failed job${log ? ' and its log' : ''} and proposes a fix without changing the pipeline.`,
    scopeBucketId: DEFAULT_SCOPE_BUCKET_ID,
    prepare: async ({ project, settings, scopeBucketId }) => {
      const thread = await createHandoffThread({
        projectId,
        projectPath: project.path,
        title: `Review failed job: ${job.name}`,
        settings,
        scopeBucketId
      })
      const attachments = log ? await jobLogAttachment(projectId, log, thread.id) : []
      return {
        threadId: thread.id,
        text: workflowJobDiagnosisPrompt(run, job, log),
        attachments
      }
    }
  })
}

/** Hand a failed deployment job to an agent, with the log attached. */
export function diagnoseDeployment(
  projectId: string,
  owner: string,
  repo: string,
  deployment: GitHubDeployment,
  run: GitHubWorkflowRun | null,
  job: GitHubDeploymentJob,
  log: GitHubDeploymentJobLog | null
): void {
  agentAssist.open({
    projectId,
    title: `Diagnose ${job.name} with agent`,
    summary: `The agent reads the failed deployment${log ? ' and its log' : ''} and proposes a fix without redeploying.`,
    scopeBucketId: DEFAULT_SCOPE_BUCKET_ID,
    prepare: async ({ project, settings, scopeBucketId }) => {
      const thread = await createHandoffThread({
        projectId,
        projectPath: project.path,
        title: `Review failed job: ${job.name}`,
        settings,
        scopeBucketId
      })
      const attachments = log ? await jobLogAttachment(projectId, log, thread.id) : []
      return {
        threadId: thread.id,
        text: deploymentJobDiagnosisPrompt(deployment, run, job, log, owner, repo),
        attachments
      }
    }
  })
}

/**
 * Hand a pull request to an agent as an assignment.
 *
 * The agent gets a fresh thread, its own report file, and a brief that tells it to
 * triage the pull request and stop for a go-ahead. The report lands in
 * `.cio/git/pr/<number>/review-<id>.md`, which is what the reader's Agent
 * tab lists, and the thread is recorded as the assignment's owner so the tab can jump
 * back into it.
 */
export async function assignAgentToPullRequest(
  projectId: string,
  pr: PullRequestSummary
): Promise<void> {
  const title = `Triage PR #${pr.number}`
  agentAssist.open({
    projectId,
    title: `Triage PR #${pr.number} with agent`,
    summary: `The agent reads the pull request in the scope you pick and writes a triage report to it.`,
    scopeBucketId: DEFAULT_SCOPE_BUCKET_ID,
    newCheckout: { title: `triage-pr-${pr.number}` },
    prepare: async ({ project, settings, scopeBucketId }) => {
      const thread = await createHandoffThread({
        projectId,
        projectPath: project.path,
        title,
        settings,
        scopeBucketId
      })
      const assignment = await gitState.createAgentAssignment(projectId, pr.number, thread.id, {
        kind: 'triage',
        title
      })
      if (!assignment) throw new Error('The agent assignment could not be created')
      return { threadId: thread.id, text: prTriagePrompt(pr, assignment.reportPath) }
    }
  })
}

/**
 * Hand one comment to an agent as an assignment.
 *
 * Same mechanics as the pull request assignment, and a different task: the comment is
 * what the agent has to make sense of, so the brief carries the comment's text, its
 * permalink, its anchor and the diff GitHub showed with it, and asks the agent to
 * work out what the comment is asking for before it decides anything.
 */
export async function assignAgentToComment(
  projectId: string,
  pr: PullRequestSummary,
  repository: string,
  comment: PrCommentChatSubject,
  body: string
): Promise<void> {
  const title = `Comment by @${comment.author}`
  agentAssist.open({
    projectId,
    title: `Work on @${comment.author}'s comment with agent`,
    summary: `The agent reads the comment on PR #${pr.number} and answers it with a change or a finding.`,
    scopeBucketId: DEFAULT_SCOPE_BUCKET_ID,
    newCheckout: { title: `comment-pr-${pr.number}` },
    prepare: async ({ project, settings, scopeBucketId }) => {
      const thread = await createHandoffThread({
        projectId,
        projectPath: project.path,
        title: `${title} on PR #${pr.number}`,
        settings,
        scopeBucketId
      })
      const assignment = await gitState.createAgentAssignment(projectId, pr.number, thread.id, {
        kind: 'comment',
        title,
        url: comment.url
      })
      if (!assignment) throw new Error('The agent assignment could not be created')
      return {
        threadId: thread.id,
        text: prCommentAssignmentPrompt(comment, body, pr, repository, assignment.reportPath)
      }
    }
  })
}

/**
 * Hand a failed check to an agent as an assignment.
 *
 * The check is the task, so the brief carries everything known about it: the pull
 * request, the check's own state and link, the run and job behind it, and the
 * output of the step that failed. The whole log rides along as a file attachment,
 * because a job log runs to hundreds of kilobytes and only an excerpt fits in a
 * prompt.
 */
export async function assignAgentToCheck(
  projectId: string,
  pr: PullRequestSummary,
  identity: { owner: string; repo: string },
  check: PullRequestCheck
): Promise<void> {
  // GitHub names a job from the workflow, and a matrix leg's name carries its
  // whole parameter list, so the title is cut to what the sidecar accepts rather
  // than failing the whole assignment on a long one.
  const title = `Failed check: ${check.name}`.slice(0, 120)
  agentAssist.open({
    projectId,
    title: `Fix ${check.name} with agent`,
    summary: `The agent reads the failing check on PR #${pr.number}, works out why it failed, and proposes the fix.`,
    scopeBucketId: DEFAULT_SCOPE_BUCKET_ID,
    newCheckout: { title: `check-pr-${pr.number}` },
    prepare: async ({ project, settings, scopeBucketId }) => {
      const run =
        check.workflowRunId !== null
          ? await gitState
              .ensureWorkflowRunDetail(
                projectId,
                identity.owner,
                identity.repo,
                check.workflowRunId
              )
              .catch(() => null)
          : null
      const job = jobForCheck(run, check)
      const jobId = check.jobId ?? job?.id ?? null
      const log =
        jobId !== null
          ? await gitState
              .ensureDeploymentJobLog(projectId, identity.owner, identity.repo, jobId)
              .catch(() => null)
          : null
      const thread = await createHandoffThread({
        projectId,
        projectPath: project.path,
        title: `${title} on PR #${pr.number}`,
        settings,
        scopeBucketId
      })
      const assignment = await gitState.createAgentAssignment(projectId, pr.number, thread.id, {
        kind: 'check',
        title,
        ...(check.url ? { url: check.url } : {})
      })
      if (!assignment) throw new Error('The agent assignment could not be created')
      const attachments = log ? await jobLogAttachment(projectId, log, thread.id) : []
      return {
        threadId: thread.id,
        text: prCheckAssignmentPrompt(
          pr,
          `${identity.owner}/${identity.repo}`,
          check,
          job,
          log,
          assignment.reportPath
        ),
        attachments
      }
    }
  })
}

/**
 * Hand a GitHub issue to an agent as the work to do.
 *
 * A fresh thread seeded with the issue's own text, rather than the report-file
 * assignment the pull request surfaces use: an issue is a request for a change, so
 * the thread is where that change is made and reported, and the pull request stays
 * the user's own step once the change is reviewed.
 */
export async function assignAgentToIssue(
  projectId: string,
  issue: IssueSummary,
  repository: string,
  body: string | null
): Promise<void> {
  agentAssist.open({
    projectId,
    title: `Work on issue #${issue.number} with agent`,
    summary: `The agent reads issue #${issue.number} in the scope you pick and does the work it asks for.`,
    scopeBucketId: DEFAULT_SCOPE_BUCKET_ID,
    newCheckout: { title: `issue-${issue.number}` },
    prepare: async ({ project, settings, scopeBucketId }) => {
      const thread = await createHandoffThread({
        projectId,
        projectPath: project.path,
        title: `Work on issue #${issue.number}`,
        settings,
        scopeBucketId
      })
      return { threadId: thread.id, text: issueWorkPrompt(issue, repository, body) }
    }
  })
}

/** Reopen the thread that owns a pull request's agent assignment. */ export async function openAgentThread(
  projectId: string,
  threadId: string
): Promise<void> {
  const [project, thread] = await Promise.all([
    invoke('project:get', projectId).catch(() => null),
    invoke('thread:get', projectId, threadId).catch(() => null)
  ])
  if (thread) workspaceState.openThread(thread, project)
}

/**
 * Build the resolution thread for a checkout whose conflicts are already in the
 * working tree.
 *
 * The brief opens as a draft or is sent immediately, decided by the shared
 * runner; the panel's own conflict controls stay the place the merge is
 * completed from. The thread carries the scope the panel is attached to, so
 * conflicts that live in a managed worktree are resolved in that worktree. Main
 * derives the working root from the scope id and fails closed on an unhealthy
 * checkout, which is why the renderer never supplies a worktree path here.
 */
async function prepareConflictHandoff(input: {
  projectId: string
  project: Project
  settings: ThreadSettings
  scopeBucketId: string
  title: string
  conflictedPaths: string[]
  pullRequest: PullRequestSummary | null
}): Promise<AgentAssistPrepared> {
  const thread = await createHandoffThread({
    projectId: input.projectId,
    projectPath: input.project.path,
    title: input.title,
    settings: input.settings,
    scopeBucketId: input.scopeBucketId
  })
  return {
    threadId: thread.id,
    text: conflictResolutionPrompt(
      input.conflictedPaths,
      input.pullRequest,
      gitState.conflictState === 'rebase' ? 'rebase' : 'merge'
    )
  }
}

/**
 * Resolve a PR's online conflicts locally: check out the PR head, merge the
 * base in, and hand the resulting conflicts to the changes-tab conflict UI.
 * Resolves true when the working tree was prepared without an error.
 */
export async function preparePrConflictSession(
  projectId: string,
  pr: PullRequestSummary,
  remote: string,
  returnBranch: string
): Promise<boolean> {
  await gitState.preparePrResolve(projectId, {
    remote,
    pullNumber: pr.number,
    baseBranch: pr.baseRef,
    headBranch: pr.headRef,
    returnBranch
  })
  return !gitState.error
}

/**
 * Resolve a PR's online conflicts with the agent's help.
 *
 * The confirmed handoff first prepares the working tree and then builds the
 * thread on exactly that checkout, so the agent can never resolve markers in a
 * different directory from the one the panel prepared. The agent never pushes;
 * the user finishes with Complete merge.
 */
export async function resolvePrConflictsWithAgent(
  projectId: string,
  pr: PullRequestSummary,
  scopeBucketId: string,
  remote: string,
  returnBranch: string,
  onPrepared: () => void
): Promise<void> {
  agentAssist.open({
    projectId,
    title: `Resolve conflicts in PR #${pr.number} with agent`,
    summary:
      'The agent resolves the conflict markers in the prepared checkout, then stops for your review.',
    scopeBucketId,
    scopeLocked: true,
    prepare: async ({ project, settings }) => {
      const prepared = await preparePrConflictSession(projectId, pr, remote, returnBranch)
      if (!prepared)
        throw new Error(gitState.error ?? 'The pull request head could not be checked out here')
      onPrepared()
      return prepareConflictHandoff({
        projectId,
        project,
        settings,
        scopeBucketId,
        title: `Resolve conflicts in PR #${pr.number}`,
        conflictedPaths: [...gitState.conflicted],
        pullRequest: pr
      })
    }
  })
}

/**
 * Resolve whatever integration is in progress with the agent's help. The
 * conflicts are already in the working tree (a pull, a merge or a rebase), so
 * this only has to hand the agent the brief. The thread opens in
 * `scopeBucketId`, which is the checkout the conflicted working tree belongs to.
 */
export async function resolveCurrentConflictsWithAgent(
  projectId: string,
  scopeBucketId: string,
  branchLabel: string
): Promise<void> {
  agentAssist.open({
    projectId,
    title: `Resolve conflicts in ${branchLabel} with agent`,
    summary:
      'The agent resolves the conflict markers in this checkout, then stops for your review.',
    scopeBucketId,
    scopeLocked: true,
    prepare: async ({ project, settings }) =>
      prepareConflictHandoff({
        projectId,
        project,
        settings,
        scopeBucketId,
        title: `Resolve conflicts in ${branchLabel}`,
        conflictedPaths: [...gitState.conflicted],
        pullRequest: null
      })
  })
}
