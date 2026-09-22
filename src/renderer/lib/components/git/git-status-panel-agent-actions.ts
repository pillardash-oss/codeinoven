import { invoke } from '$lib/ipc.svelte'
import { pathToFileUrl } from '$lib/mime'
import { reportError } from '$lib/stores/app-errors.svelte'
import { gitState } from '$lib/stores/git.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { threadSettings } from '$lib/stores/thread-settings.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import type { PromptAttachment } from '$shared/types'
import type {
  GitHubDeployment,
  GitHubDeploymentJob,
  GitHubDeploymentJobLog,
  GitHubWorkflowRun,
  Project,
  PullRequestSummary
} from '$shared/types'
import type { PrCommentChatSubject } from './git-status-panel-prompts'
import {
  prCommentAssignmentPrompt,
  prTriagePrompt,
  conflictResolutionPrompt,
  deploymentJobDiagnosisPrompt,
  workflowJobDiagnosisPrompt
} from './git-status-panel-prompts'

/** Open a new agent thread and return it, or null when unavailable. */
async function createDeploymentDiagnosisThread(projectId: string, title: string) {
  const project = await invoke('project:get', projectId).catch(() => null)
  if (!project) return
  const thread = await invoke('thread:create', {
    projectId,
    providerId: 'pi',
    title,
    workingDirectory: project.path,
    settings: { ...threadSettings.lastUsed }
  }).catch(() => null)
  if (!thread) return
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

/** Hand a failed workflow run job to a fresh diagnosis thread. */
export function diagnoseWorkflowJob(
  projectId: string,
  run: GitHubWorkflowRun,
  job: GitHubDeploymentJob,
  log: GitHubDeploymentJobLog | null
): void {
  const prompt = workflowJobDiagnosisPrompt(run, job, log)
  void (async () => {
    const project = await invoke('project:get', projectId).catch(() => null)
    if (!project) return
    const thread = await createDeploymentDiagnosisThread(
      projectId,
      `Review failed job: ${job.name}`
    )
    if (!thread) return
    const attachments = log ? await jobLogAttachment(projectId, log, thread.id) : []
    rendererRecovery.setDraft(projectId, thread.id, prompt, attachments, [])
    workspaceState.openThread(thread, project)
  })()
}

/** Hand a failed deployment job to a fresh diagnosis thread. */
export function diagnoseDeployment(
  projectId: string,
  owner: string,
  repo: string,
  deployment: GitHubDeployment,
  run: GitHubWorkflowRun | null,
  job: GitHubDeploymentJob,
  log: GitHubDeploymentJobLog | null
): void {
  const prompt = deploymentJobDiagnosisPrompt(deployment, run, job, log, owner, repo)
  void (async () => {
    const project = await invoke('project:get', projectId).catch(() => null)
    if (!project) return
    const thread = await createDeploymentDiagnosisThread(
      projectId,
      `Review failed job: ${job.name}`
    )
    if (!thread) return
    const attachments = log ? await jobLogAttachment(projectId, log, thread.id) : []
    rendererRecovery.setDraft(projectId, thread.id, prompt, attachments, [])
    workspaceState.openThread(thread, project)
  })()
}

/**
 * Open the thread an agent assignment runs in, or null when it could not be made.
 *
 * The thread exists before the assignment does, because the assignment records the
 * thread that owns it. Both are made from one user action, so a thread left behind
 * by a failed assignment is a stray the user can delete, never a report that claims
 * work no thread ever did.
 */
async function createAssignmentThread(projectId: string, projectPath: string, title: string) {
  return invoke('thread:create', {
    projectId,
    providerId: 'pi',
    title,
    workingDirectory: projectPath,
    settings: { ...threadSettings.lastUsed }
  }).catch(() => null)
}

/**
 * Hand a pull request to an agent as an assignment.
 *
 * The agent gets a fresh thread, its own report file, and a brief that tells it to
 * triage the pull request in a throwaway worktree and stop for a go-ahead. The report
 * lands in `.cio/git/pr/<number>/review-<id>.md`, which is what the reader's Agent
 * tab lists, and the thread is recorded as the assignment's owner so the tab can jump
 * back into it.
 *
 * The brief opens as a draft rather than sending itself: an assignment is a large
 * action, and this is the moment the user can add to it before the agent starts.
 */
export async function assignAgentToPullRequest(
  projectId: string,
  pr: PullRequestSummary
): Promise<void> {
  const project = await invoke('project:get', projectId).catch(() => null)
  if (!project) return
  const title = `Triage PR #${pr.number}`
  const thread = await createAssignmentThread(projectId, project.path, title)
  if (!thread) return
  const assignment = await gitState.createAgentAssignment(projectId, pr.number, thread.id, {
    kind: 'triage',
    title
  })
  if (!assignment) return
  rendererRecovery.setDraft(projectId, thread.id, prTriagePrompt(pr, assignment.reportPath), [], [])
  workspaceState.openThread(thread, project)
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
  const project = await invoke('project:get', projectId).catch(() => null)
  if (!project) return
  const title = `Comment by @${comment.author}`
  const thread = await createAssignmentThread(
    projectId,
    project.path,
    `${title} on PR #${pr.number}`
  )
  if (!thread) return
  const assignment = await gitState.createAgentAssignment(projectId, pr.number, thread.id, {
    kind: 'comment',
    title,
    url: comment.url
  })
  if (!assignment) return
  rendererRecovery.setDraft(
    projectId,
    thread.id,
    prCommentAssignmentPrompt(comment, body, pr, repository, assignment.reportPath),
    [],
    []
  )
  workspaceState.openThread(thread, project)
}

/** Reopen the thread that owns a pull request's agent assignment. */
export async function openAgentThread(projectId: string, threadId: string): Promise<void> {
  const [project, thread] = await Promise.all([
    invoke('project:get', projectId).catch(() => null),
    invoke('thread:get', projectId, threadId).catch(() => null)
  ])
  if (thread) workspaceState.openThread(thread, project)
}

/**
 * Open a thread that resolves the given conflicted paths, with the brief
 * pre-loaded as a draft so the user reviews it before sending. The panel's
 * own conflict controls stay the place the merge is completed from.
 */
async function launchConflictAgent(
  projectId: string,
  project: Project,
  title: string,
  conflictedPaths: string[],
  pullRequest: PullRequestSummary | null
): Promise<void> {
  const thread = await invoke('thread:create', {
    projectId,
    providerId: 'pi',
    title,
    workingDirectory: project.path,
    settings: { ...threadSettings.lastUsed }
  }).catch(() => null)
  if (!thread) return
  rendererRecovery.setDraft(
    projectId,
    thread.id,
    conflictResolutionPrompt(
      conflictedPaths,
      pullRequest,
      gitState.conflictState === 'rebase' ? 'rebase' : 'merge'
    ),
    [],
    []
  )
  workspaceState.openThread(thread, project)
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
 * Resolve a PR's online conflicts with the agent's help: prepare the working
 * tree, then (once `onPrepared` has let the panel switch views) hand the agent
 * a thread to resolve the conflict markers. The agent never pushes   the user
 * finishes with Complete merge.
 */
export async function resolvePrConflictsWithAgent(
  projectId: string,
  pr: PullRequestSummary,
  remote: string,
  returnBranch: string,
  onPrepared: () => void
): Promise<void> {
  const project = await invoke('project:get', projectId).catch(() => null)
  if (!project) return
  const prepared = await preparePrConflictSession(projectId, pr, remote, returnBranch)
  if (!prepared) return
  onPrepared()
  await launchConflictAgent(
    projectId,
    project,
    `Resolve conflicts in PR #${pr.number}`,
    [...gitState.conflicted],
    pr
  )
}

/**
 * Resolve whatever integration is in progress with the agent's help. The
 * conflicts are already in the working tree (a pull, a merge or a rebase), so
 * this only has to hand the agent the brief   the same brief the PR path uses.
 */
export async function resolveCurrentConflictsWithAgent(
  projectId: string,
  branchLabel: string
): Promise<void> {
  const project = await invoke('project:get', projectId).catch(() => null)
  if (!project) return
  await launchConflictAgent(
    projectId,
    project,
    `Resolve conflicts in ${branchLabel}`,
    [...gitState.conflicted],
    null
  )
}
