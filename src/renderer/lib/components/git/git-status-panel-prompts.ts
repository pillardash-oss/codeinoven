import { failedJobLogEvidence } from '$shared/github-job-log'
import { UTILITY_INVOKE_TOOL_NAME, UTILITY_SEARCH_TOOL_NAME } from '$shared/gateway-tools'
import { APP_SCOPE_UTILITY_ID } from '$shared/utility-ids'
import { SCOPE_CAPABILITY_SEARCH_QUERY } from '$shared/scope-tool'
import type {
  GitHubDeployment,
  GitHubDeploymentJob,
  GitHubDeploymentJobLog,
  GitHubWorkflowRun,
  PullRequestCheck,
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
  /**
   * The unified diff hunk GitHub showed with an inline comment, present only
   * when the comment came with one. It is the version of the code the comment
   * was written against, which the live working tree may no longer match.
   */
  diffHunk?: string | null
}

/**
 * A fence a body cannot close early.
 *
 * A comment that quotes code carries its own triple backticks, and a fixed fence
 * would end the quote at the first line of the example, leaving the rest of the
 * comment loose in the brief. So the fence is one backtick longer than anything the
 * text already contains.
 */
function fenceFor(text: string): string {
  const longest = /`{3,}/gu.exec(text)?.[0].length ?? 0
  return '`'.repeat(Math.max(3, longest + 1))
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
    ...(comment.diffHunk
      ? [
          '',
          'The diff GitHub showed with this comment, which is the code the comment was written against:',
          `${fenceFor(comment.diffHunk)}diff`,
          comment.diffHunk.trim(),
          fenceFor(comment.diffHunk)
        ]
      : []),
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
    ...(comment.diffHunk
      ? [
          '- The diff GitHub showed with this comment is in the context above. It is the code the comment was written against, so use it to identify exactly which lines are meant, and check whether the working tree still matches it.'
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

/**
 * The pinned context a temporary chat opened on a pull request from the list is
 * anchored with.
 *
 * The list holds a summary and nothing else: the body, the diff, and the checks
 * all live behind the detail bundle, which opening this chat deliberately does not
 * pay for. So the context names what the row itself knows, and the explain brief
 * says plainly that the diff was not supplied rather than letting the agent assume
 * it was.
 */
export function prSummaryChatContext(pr: PullRequestSummary, repository: string): string {
  const labels = (pr.labels ?? []).map((label) => label.name)
  const assignees = (pr.assignees ?? []).map((entry) => `@${entry.login}`)
  return [
    'The user opened this pull request from the list and is asking about it. Everything below is read-only context for that question.',
    `Pull request: #${pr.number} "${pr.title}" in ${repository} (${pr.headRef} \u2192 ${pr.baseRef})`,
    `State: ${pr.state}${pr.draft ? ' (draft)' : ''}, opened ${pr.createdAt || 'at an unknown time'} by @${pr.authorLogin}`,
    `Pull request link: ${pr.url}`,
    ...(labels.length > 0 ? [`Labels: ${labels.join(', ')}`] : []),
    ...(assignees.length > 0 ? [`Assigned to: ${assignees.join(', ')}`] : []),
    ...(pr.milestone ? [`Milestone: ${pr.milestone.title}`] : []),
    'The pull request description, diff, and checks are not part of this context: they were never fetched from the provider.',
    'The visible row text is attached to this chat as the selection.'
  ].join('\n')
}

/**
 * The instruction a temporary explain chat receives when it is opened from a
 * pull request in the list.
 *
 * Same contract as the comment brief: ground every claim in code actually read,
 * and treat the remote copy as something the user authorizes rather than something
 * the agent reaches for. The difference is what is missing here, which is the whole
 * pull request, so the agent is told that and asked to say what it needs.
 */
export function prSummaryExplainPrompt(pr: PullRequestSummary): string {
  return [
    'Explain the attached pull request (its link is in the context above).',
    '',
    'The diff was not supplied, so work from what you can read and be explicit about the rest:',
    `- Start in the current working tree. Look for the branch \`${pr.headRef}\`, files or symbols this pull request is likely to touch, and cite the exact project-relative path and line you read.`,
    ...(pr.baseRef
      ? [
          `- The pull request targets \`${pr.baseRef}\`, so anything you claim about behaviour is a claim about that branch plus the head, not about whatever is checked out now.`
        ]
      : []),
    '- If the head branch is not in the working tree, say plainly that it is missing here and name what is missing.',
    '- Do not fetch the remote copy on your own. When grounding needs the diff or a file as it exists on the head, state exactly what you would fetch and ask the user first. Only after the user agrees, read it with the web fetch tool: the changed files are on the pull request at the link above, and a file as it exists on the head lives at `https://raw.githubusercontent.com/<owner>/<repo>/<headRef>/<path>` (repository and head are in the context above).',
    '- Never describe a change, file, or line number you have not read.',
    '',
    'Then explain in everyday language what this pull request appears to change, what it is for, and what a reviewer should look at first. Where the list row does not tell you something, say so instead of filling the gap.',
    'Stay read-only: do not modify files, commit, push, or run mutating commands.'
  ].join('\n')
}

/**
 * The work order every agent assignment shares.
 *
 * An assignment is a thread with a mandate and a report file, whether it was opened
 * from a pull request or from one comment on it. The isolation, the testing
 * judgement, the report, and the stop before anything irreversible are the same in
 * both cases, so they are written once here and the two briefs differ only in what
 * they ask the agent to work out.
 */
function agentAssignmentPrompt(
  pr: PullRequestSummary,
  reportPath: string,
  mandate: string[]
): string {
  return [
    ...mandate,
    '',
    'Work in isolation so my current working tree is never touched. I am asking you for that, so',
    'set up an app-managed worktree scope: it is deliberately not in your tool list, so call',
    `\`${UTILITY_SEARCH_TOOL_NAME}\` with query "${SCOPE_CAPABILITY_SEARCH_QUERY}", activate the`,
    `\`${APP_SCOPE_UTILITY_ID}\` result, then invoke it with \`${UTILITY_INVOKE_TOOL_NAME}\`. Never run`,
    '`git worktree` yourself: only a checkout made that way lands on the scope board with its',
    'branch, health and threads.',
    `1. \`git fetch origin pull/${pr.number}/head:pr-${pr.number}\``,
    `2. \`${APP_SCOPE_UTILITY_ID}\` operation "create" with input`,
    `   { "title": "Agent on PR #${pr.number}", "baseBranch": "pr-${pr.number}" } so the scope owns`,
    '   the checkout and this thread moves into it.',
    `3. Read the diff against \`${pr.baseRef}\` inside that scope.`,
    '4. Test when the change warrants it. That judgement is yours: run the project checks that cover',
    '   the changed files, and if you decide testing is not warranted, say why in the report.',
    '',
    `Write your findings to \`${reportPath}\`. That file is what I read and approve from, so it has`,
    'to stand on its own:',
    '- A verdict line first: what this change is, and what you recommend I do with it.',
    '- Then the evidence, most important first, with file:line references you actually read.',
    '- Then the risk: what could break, and what you could not verify.',
    '- End with the exact next action you recommend, so I can approve it or send you back.',
    '',
    'Stop there. Do not push, merge, close, or comment on the pull request: the decision is mine,',
    'and I will give you the go-ahead in this thread.',
    `When you are done, hand the scope back: \`${APP_SCOPE_UTILITY_ID}\` operation "delete_scope"`,
    'with input { "threads": "move-to-default", "deleteBranch": true }, then drop the fetched',
    `branch with \`git branch -D pr-${pr.number}\`.`
  ].join('\n')
}

/**
 * The brief a pull request handed to an agent receives.
 *
 * Triage rather than review: a review says whether the code is good, and what I need
 * from an assignment is what this pull request is, where it came from, and whether
 * it is safe to take, so the report can end in a decision I can approve.
 */
export function prTriagePrompt(pr: PullRequestSummary, reportPath: string): string {
  return agentAssignmentPrompt(pr, reportPath, [
    `Triage pull request #${pr.number}: "${pr.title}" (${pr.headRef} → ${pr.baseRef}) by ${pr.authorLogin}.`,
    `Pull request link: ${pr.url}`,
    '',
    'Work out what this pull request actually is, why it exists, and whether it is safe to take:',
    '- What it changes, and what the change is for. A title and a diff rarely say the same thing.',
    '- Where it came from. If it is a dependency bump, read the release notes or changelog for the',
    '  versions it moves between and check for breaking changes, deprecations, and advisories. The',
    '  upstream changelog and the package registry are fair game to read; the title alone is not',
    '  evidence.',
    '- What it touches here, and whether anything in this repository still uses the changed code.',
    '- Whether the checks already on the pull request agree with what you find.',
    '- Whether it is a duplicate, a superseded change, or something that should be closed instead.'
  ])
}

/**
 * The brief a comment handed to an agent receives.
 *
 * The comment is the task, so everything about it is written into the brief: which
 * pull request it belongs to, its permalink, where it sits, the diff GitHub showed
 * with it, and its text. A read-only side chat can ride the comment as a selection,
 * but this is a real thread that has to still make sense after a restart, so nothing
 * is left to a transient attachment.
 */
export function prCommentAssignmentPrompt(
  comment: PrCommentChatSubject,
  body: string,
  pr: PullRequestSummary,
  repository: string,
  reportPath: string
): string {
  return agentAssignmentPrompt(pr, reportPath, [
    `Handle one comment on pull request #${pr.number}: "${pr.title}" (${pr.headRef} → ${pr.baseRef}) in ${repository}.`,
    `Pull request link: ${pr.url}`,
    '',
    `The comment is a ${comment.kindLabel} by @${comment.author}.`,
    `Comment link: ${comment.url}`,
    ...(comment.location ? [`Inline location: ${comment.location}`] : []),
    ...(comment.diffHunk
      ? [
          '',
          'The diff GitHub showed with this comment, which is the code it was written against:',
          `${fenceFor(comment.diffHunk)}diff`,
          comment.diffHunk.trim(),
          fenceFor(comment.diffHunk)
        ]
      : []),
    '',
    'The comment, verbatim:',
    fenceFor(body),
    body.trim(),
    fenceFor(body),
    '',
    'Work out what the comment is asking for before you do anything:',
    '- It may ask for a fix, a clarification, a revert, a test, or a second opinion. Read it against',
    '  the diff above and against the pull request as a whole, then say which one you concluded it is',
    '  and why.',
    '- If it is a question, answer it from code you have actually read. If it is a claim, check it and',
    '  say whether it holds.',
    '- If it points at something outside this repository, name exactly what you would need to read and',
    '  ask me, rather than guessing.',
    '- If it needs no action, say that plainly and recommend nothing.',
    '- If a reply is the right answer, draft it in the report word for word, so I can approve it as',
    '  written.'
  ])
}

/**
 * The brief a failed check handed to an agent receives.
 *
 * A check is a claim about the pull request that has already been answered no, so
 * the task is not to decide whether to trust it but to say what it means: whether
 * this repository is wrong, the runner is wrong, or the check is asking for
 * something the pull request never promised. The failing step's own output is the
 * evidence, and the whole log rides along as an attachment so the excerpt never
 * has to stand in for it.
 */
export function prCheckAssignmentPrompt(
  pr: PullRequestSummary,
  repository: string,
  check: PullRequestCheck,
  job: GitHubDeploymentJob | null,
  log: GitHubDeploymentJobLog | null,
  reportPath: string
): string {
  return agentAssignmentPrompt(pr, reportPath, [
    `Diagnose the failed check "${check.name}" on pull request #${pr.number}: "${pr.title}" (${pr.headRef} → ${pr.baseRef}) in ${repository}.`,
    `Pull request link: ${pr.url}`,
    `Check state: ${check.conclusion ?? check.status}`,
    ...(check.url ? [`Check link: ${check.url}`] : []),
    ...(check.workflowRunId !== null ? [`Workflow run ID: ${check.workflowRunId}`] : []),
    '',
    ...(job
      ? failedJobLogEvidence(job, log)
      : [
          'The job behind this check could not be read from here, so its log is not supplied.',
          ...(log ? ['The raw log is attached to this message regardless.'] : [])
        ]),
    '',
    'Work out why it failed before you decide anything:',
    '- Reproduce it inside the scope where that is practical: find the workflow that runs this check, read the step that failed, and run the same command there.',
    '- Separate the causes, and say which one you concluded it is: a defect this change introduced, a defect already on the base branch, a flake, a runner or infrastructure problem, or a check that is stricter than the code it tests.',
    '- Blame the right side. When the check itself is wrong (a stale action version, a wrong path, a version pinned too tightly), the fix belongs in the workflow, not in the code it flagged, and it may well belong in a different pull request.',
    '- If the cause is outside this repository (a secret, a permission, a hosted runner, a third-party service), do not guess and do not ask for credentials: name the operator action instead.',
    '- If the log was not supplied and reading a step matters, say exactly which job or step you need and ask me first; do not fetch it on your own.',
    '- Once you have concluded the fix, implement the smallest correct one inside the scope and run the command that failed, so the report can say whether it now passes.'
  ])
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
