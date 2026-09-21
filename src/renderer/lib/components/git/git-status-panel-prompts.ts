import { failedJobLogEvidence } from '$shared/github-job-log'
import { UTILITY_INVOKE_TOOL_NAME, UTILITY_SEARCH_TOOL_NAME } from '$shared/gateway-tools'
import { APP_SCOPE_UTILITY_ID } from '$shared/utility-ids'
import { SCOPE_CAPABILITY_SEARCH_QUERY } from '$shared/scope-tool'
import type {
  GitHubDeployment,
  GitHubDeploymentJob,
  GitHubDeploymentJobLog,
  GitHubWorkflowRun,
  PullRequestSummary
} from '$shared/types'

/**
 * The comment a temporary explain / quick chat is anchored on, resolved to the
 * few facts the chat needs. The comment body itself never travels here: it is
 * attached to the chat as the selection.
 */
export interface PrCommentChatSubject {
  /** Login that wrote the comment, as the provider declared it. */
  author: string
  /** Permalink GitHub itself uses for this exact comment. */
  url: string
  /** Human label for what kind of entry it is, e.g. `inline review`. */
  kindLabel: string
  /** Inline anchor `path:line`, present only for an inline review comment. */
  location?: string
}

/**
 * The pinned context a temporary chat opened on a pull request comment is
 * anchored with.
 *
 * A side chat normally rides the parent conversation's transcript, but a
 * comment opened from the reader has no such transcript behind it. What gives
 * the agent its bearings instead is the pull request the comment belongs to
 * and the comment's own permalink, which is also the canonical way back to the
 * remote copy of anything the comment references.
 */
export function prCommentChatContext(
  comment: PrCommentChatSubject,
  pr: PullRequestSummary,
  repository: string
): string {
  return [
    'The user opened this comment from the pull request reader and is asking about it. Everything below is read-only context for that question.',
    `Pull request: #${pr.number} "${pr.title}" in ${repository} (${pr.headRef} \u2192 ${pr.baseRef})`,
    `Comment: ${comment.kindLabel} by @${comment.author}`,
    `Comment link: ${comment.url}`,
    ...(comment.location ? [`Inline location: ${comment.location}`] : []),
    'The comment body is attached to this chat as the selection.'
  ].join('\n')
}

/**
 * The instruction a temporary explain chat receives when it is opened from a
 * pull request comment.
 *
 * The point of the brief is grounding. A comment refers to code that may exist
 * in the working tree, only on the pull request's head, or nowhere the agent
 * can read. The agent has read-only tools only, so fetching the remote copy is
 * a deliberate step the user authorizes, not something the agent does on its
 * own.
 */
export function prCommentExplainPrompt(comment: PrCommentChatSubject): string {
  return [
    'Explain the attached pull request comment (its link is in the context above).',
    '',
    'Ground every claim in code you have actually read:',
    '- Look for what the comment references (a file, symbol, or behaviour) in the current working tree with the read, glob, and grep tools, and cite the exact project-relative path and line you read.',
    ...(comment.location
      ? [
          `- The comment is anchored at ${comment.location}; start there and confirm it still matches what you read.`
        ]
      : []),
    '- If the referenced code is not in the working tree, say plainly that it is missing here and name what is missing. It then lives only on the remote: the pull request head, another branch, or another repository.',
    '- Do not fetch the remote copy on your own. When grounding needs it, state exactly which remote file or link you would fetch and ask the user whether to fetch it. Only after the user agrees, read it with the web fetch tool: the file as it exists on the pull request head lives at `https://raw.githubusercontent.com/<owner>/<repo>/<headRef>/<path>` (repository and head are in the context above), and the comment link is the reference for the comment itself.',
    '- Never describe code or line numbers you have not read, and do not pad the answer with guesses.',
    '',
    'Then explain what the comment is saying and why it matters for this pull request, in everyday language and without unnecessary jargon.',
    'Stay read-only: do not modify files, commit, push, or run mutating commands.'
  ].join('\n')
}

/** The first message the review agent receives   explicit about isolation and output. */
export function agentReviewPrompt(pr: PullRequestSummary, reportDirectory: string): string {
  return [
    `Review pull request #${pr.number}   "${pr.title}" (${pr.headRef} → ${pr.baseRef}) by ${pr.authorLogin}.`,
    `PR URL: ${pr.url}`,
    '',
    'Work in isolation so my current working tree is never touched. I am asking you for that, so',
    'set up an app-managed worktree scope: it is deliberately not in your tool list, so call',
    `\`${UTILITY_SEARCH_TOOL_NAME}\` with query "${SCOPE_CAPABILITY_SEARCH_QUERY}", activate the`,
    `\`${APP_SCOPE_UTILITY_ID}\` result, then invoke it with \`${UTILITY_INVOKE_TOOL_NAME}\`. Never run`,
    '`git worktree` yourself: only a checkout made that way lands on the scope board with its',
    'branch, health and threads.',
    `1. \`git fetch origin pull/${pr.number}/head:pr-${pr.number}\``,
    `2. \`${APP_SCOPE_UTILITY_ID}\` operation "create" with input`,
    `   { "title": "Review PR #${pr.number}", "baseBranch": "pr-${pr.number}" } so the scope owns`,
    '   the checkout and this thread moves into it.',
    `3. Review the diff against \`${pr.baseRef}\` inside that scope   correctness, edge cases,`,
    '   security, test coverage, and anything that would break existing behavior.',
    '4. Run the project checks/tests that are relevant to the changed files.',
    '',
    `Write your findings to \`${reportDirectory}/review.md\`: a short verdict line, then findings`,
    'ordered most severe first with file:line references and concrete failure scenarios.',
    `When you are done, hand the scope back: \`${APP_SCOPE_UTILITY_ID}\` operation "delete_scope"`,
    'with input { "threads": "move-to-default", "deleteBranch": true }, then drop the fetched',
    `branch with \`git branch -D pr-${pr.number}\`. Do not push anything and do not merge the PR.`
  ].join('\n')
}

/**
 * The first message the conflict-resolution agent receives. The agent resolves
 * and stages; on a merge it stops there, because the merge commit is the
 * user's step (Complete merge writes it, and pushes the resolution and deletes
 * the temporary branch when a pull request is involved). A rebase stop has no
 * such step in this panel, so that brief still asks for the commit.
 */
export function conflictResolutionPrompt(
  conflictedPaths: string[],
  pullRequest: PullRequestSummary | null,
  integration: 'merge' | 'rebase'
): string {
  const subject = pullRequest
    ? [
        `Resolve the merge conflicts in pull request #${pullRequest.number}   "${pullRequest.title}" (${pullRequest.headRef} → ${pullRequest.baseRef}).`,
        `The head branch \`pr-${pullRequest.number}\` is already checked out and \`${pullRequest.baseRef}\` has been merged into it, so the conflicts are in the working tree.`
      ]
    : [
        `Resolve the conflicts left by the in-progress ${integration} in this worktree.`,
        'The conflicts are already in the working tree, in the files listed below.'
      ]
  const handOff =
    integration === 'merge'
      ? [
          'Then stage exactly the files you resolved, one `git add <path>` per file   never `git add -A`.',
          `Do NOT commit and do NOT push   the user completes the merge from the Git panel, which writes the merge commit${pullRequest ? ', pushes the resolution back to the pull request, and deletes the temporary branch' : ''}.`
        ]
      : [
          'Then stage and commit the resolutions:',
          '1. `git add -A`',
          '2. `git commit -m "Resolve conflicts"`',
          'Do NOT push   the user finishes from the Git panel.'
        ]
  return [
    ...subject,
    '',
    conflictedPaths.length > 0
      ? `Conflicted files: ${conflictedPaths.map((path) => `\`${path}\``).join(', ')}`
      : 'There are no conflicted files remaining in the working tree.',
    '',
    'For each conflicted file:',
    '1. Read it and resolve the `<<<<<<<`, `=======`, and `>>>>>>>` conflict markers, keeping the correct merged content.',
    '2. Run the relevant project checks/tests to make sure the resolution is sound.',
    '',
    ...handOff
  ].join('\n')
}

/** The prompt an agent receives to review and fix a failed workflow run job. */
export function workflowJobDiagnosisPrompt(
  run: GitHubWorkflowRun,
  job: GitHubDeploymentJob,
  log: GitHubDeploymentJobLog | null
): string {
  return [
    `Review and resolve the failed GitHub Actions job "${job.name}" only.`,
    `Workflow: ${run.name} #${run.runNumber}`,
    `Run ID: ${run.id}`,
    `Status: ${run.status}${run.conclusion ? ` / ${run.conclusion}` : ''}`,
    `Branch: ${run.branch || '(unknown)'}`,
    `Commit: ${run.headSha || '(unknown)'}`,
    ...(run.url ? [`Workflow URL: ${run.url}`] : []),
    '',
    ...failedJobLogEvidence(job, log),
    '',
    'Use the supplied job metadata and log as the primary evidence. Do not assume GitHub or the remote repository is accessible.',
    'If local repository files are available, inspect only what is relevant to this failed job and reproduce the failure where practical.',
    'If the cause is in this repository, implement the smallest correct fix, run the relevant checks/tests, and commit the completed change.',
    'If repository access is unavailable, diagnose from the evidence and give the exact file/configuration change or operator action required.',
    'If the cause is external infrastructure, permissions, or secrets, do not guess or expose credentials.',
    'Do not push, rerun workflows, or deploy.'
  ].join('\n')
}

/** The prompt an agent receives to review and fix a failed deployment job. */
export function deploymentJobDiagnosisPrompt(
  deployment: GitHubDeployment,
  run: GitHubWorkflowRun | null,
  job: GitHubDeploymentJob,
  log: GitHubDeploymentJobLog | null,
  owner: string,
  repo: string
): string {
  const deploymentUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/deployments/${deployment.id}`
  return [
    `Review and resolve the failed deployment job "${job.name}" only.`,
    `Deployment ID: ${deployment.id}`,
    `Status: ${deployment.latestStatus?.state ?? 'unknown'}`,
    `Ref: ${deployment.ref || '(unknown)'}`,
    `Commit: ${deployment.sha || '(unknown)'}`,
    `Deployment URL: ${deploymentUrl}`,
    ...(run ? [`Linked workflow run: ${run.name} #${run.runNumber} (ID ${run.id})`] : []),
    '',
    ...failedJobLogEvidence(job, log),
    '',
    'Use the supplied job metadata and log as the primary evidence. Do not assume GitHub or the remote repository is accessible.',
    'If local repository files are available, inspect only what is relevant to this failed job and reproduce the failure where practical.',
    'If the cause is in this repository, implement the smallest correct fix, run the relevant checks/tests, and commit the completed change.',
    'If repository access is unavailable, diagnose from the evidence and give the exact file/configuration change or operator action required.',
    'If the cause is external infrastructure, permissions, or secrets, do not guess or expose credentials.',
    'Do not push, rerun workflows, or deploy.'
  ].join('\n')
}
