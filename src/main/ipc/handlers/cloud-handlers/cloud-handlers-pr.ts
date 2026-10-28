import { harnessFailureIssue } from '../../../chat/chat-engine/chat-engine-errors'
import {
  createPrAgentAssignment,
  listPrAgentReports,
  summarizePrAgentAssignments
} from '../../../git/pr-agent-assignments'
import { Logger } from '../../../system/logger'
import { isNetworkError } from '../../../util/network-error'
import {
  validateBoolean,
  validateBoundedString,
  validateEntityId,
  validateGraphqlNodeId,
  validatePrAgentAssignmentInput,
  validatePrCommentBody,
  validatePrCommentId,
  validatePrCommentKind,
  validatePrMinimizeReason,
  validatePrNumber,
  validatePrNumbers,
  validatePrReactionContent,
  validatePrReviewEvent,
  validateThreadSettings
} from '../../ipc-validation'
import { runGitHubMutation } from '../shared'
import { trustedIpcMain as ipcMain } from '../../trusted-ipc-main'
import {
  PR_COMPOSE_OUTPUT_SCHEMA,
  PR_COMPOSE_SYSTEM_PROMPT,
  hasPrComposeResponse,
  prComposePrompt,
  prComposeRepairPrompt,
  prComposeResponse,
  validatePrComposeInput
} from './cloud-handlers-pr-compose'
import type {
  PrReactionMap,
  PullRequestComment,
  PullRequestDetail,
  PullRequestReview,
  PullRequestReviewComment
} from '../../../../lib/types'
import type { IpcHandlerContext } from '../context'

/**
 * Every subject in one pull request bundle that can be reacted to, as node ids.
 *
 * The description is a field on the pull request rather than a comment, so it
 * contributes the pull request's own node id; the rest are the issue comments,
 * the reviews and the inline comments the conversation draws. Duplicates are
 * dropped because one subject can be reachable twice (a review and the threads
 * it wrote), and the batched read wants a unique id list.
 */
function reactionSubjects(
  detail: PullRequestDetail,
  comments: PullRequestComment[],
  reviews: PullRequestReview[],
  reviewComments: PullRequestReviewComment[]
): string[] {
  const ids = [
    detail.nodeId,
    ...comments.map((comment) => comment.nodeId),
    ...reviews.map((review) => review.nodeId),
    ...reviewComments.map((comment) => comment.nodeId)
  ]
  return [...new Set(ids.filter((id): id is string => id !== null))]
}

export function registerPullRequestHandlers(ctx: IpcHandlerContext): void {
  const { chatEngine, gitService, providerForProject, pullRequestTarget, resolveProjectPath } = ctx

  ipcMain.handle(
    'pr:bundle',
    async (_, projectId: unknown, owner: unknown, repo: unknown, pullNumber: unknown) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      // Fetched together so the sidebar renders one complete view, not six
      // staggered ones. Optional surfaces degrade to empty rather than failing
      // the whole bundle (e.g. a repo with checks disabled).
      const [
        detail,
        commits,
        comments,
        reviews,
        reviewComments,
        reviewThreads,
        files,
        checks,
        stackResult
      ] = await Promise.all([
        provider.getPullRequest(target),
        provider.listPullRequestCommits(target).catch(() => []),
        provider.listPullRequestComments(target).catch(() => []),
        provider.listPullRequestReviews(target).catch(() => []),
        provider.listPullRequestReviewComments(target).catch(() => []),
        // Resolution is GraphQL-only and optional: a thread the read could not
        // reach must not cost the reader the comments themselves.
        provider.listPullRequestReviewThreads(target).catch(() => []),
        provider.listPullRequestFiles(target).catch(() => []),
        provider.getPullRequestChecks(target).catch(() => ({ state: 'none' as const, checks: [] })),
        provider.listPullRequestStack(target).then(
          (stack) => ({ stack, stackError: undefined }),
          () => ({ stack: [], stackError: 'PR stack could not be loaded. Refresh to retry.' })
        )
      ])
      // Reactions are one batched read over every subject the conversation draws,
      // so it follows the comments rather than racing them: their node ids are
      // what it addresses. Optional like the threads, for the same reason   a
      // comment list is worth showing even when its reactions could not be read.
      const reactions = await provider
        .listReactions(reactionSubjects(detail, comments, reviews, reviewComments))
        .catch((): PrReactionMap => ({}))
      return {
        detail,
        ...stackResult,
        commits,
        comments,
        reviews,
        reviewComments,
        reviewThreads,
        reactions,
        files,
        checks,
        fetchedAt: Date.now()
      }
    }
  )

  ipcMain.handle(
    'pr:commitFiles',
    async (_, projectId: unknown, owner: unknown, repo: unknown, sha: unknown) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) throw new Error('Sign in to GitHub first (Git panel → GitHub account)')
      return provider.getCommitFiles(
        {
          owner: validateBoundedString(owner, 'PR owner', 1, 128),
          repo: validateBoundedString(repo, 'PR repository', 1, 128)
        },
        validateEntityId(sha, 'Commit sha')
      )
    }
  )

  ipcMain.handle(
    'pr:mentionUsers',
    async (_, projectId: unknown, owner: unknown, repo: unknown) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) throw new Error('Sign in to GitHub first (Git panel → GitHub account)')
      return provider.listRepositoryMentionUsers({
        owner: validateBoundedString(owner, 'PR owner', 1, 128),
        repo: validateBoundedString(repo, 'PR repository', 1, 128)
      })
    }
  )

  ipcMain.handle(
    'pr:detail',
    async (_, projectId: unknown, owner: unknown, repo: unknown, pullNumber: unknown) => {
      const {
        provider,
        owner: safeOwner,
        repo: safeRepo,
        pullNumber: safeNumber
      } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      try {
        return await provider.getPullRequest({
          owner: safeOwner,
          repo: safeRepo,
          pullNumber: safeNumber
        })
      } catch (reason) {
        // This channel powers the background mergeability probe, so transient
        // provider failures (timeouts, rate limits, flaky network) are expected.
        // Returning null avoids a noisy main-process "Error occurred in handler"
        // log for every probe retry; the caller already treats null as "unknown".
        // A transport failure is weather rather than a defect, so it is not
        // recorded at all; an unexpected failure still is.
        if (!isNetworkError(reason)) Logger.dev('PR detail fetch failed', reason)
        return null
      }
    }
  )

  ipcMain.handle('pr:agentReports', async (_, projectId: unknown, pullNumber: unknown) => {
    const projectPath = await resolveProjectPath(validateEntityId(projectId, 'Project ID'))
    return listPrAgentReports(projectPath, validatePrNumber(pullNumber))
  })

  ipcMain.handle('pr:agentAssignments', async (_, projectId: unknown, numbers: unknown) => {
    const projectPath = await resolveProjectPath(validateEntityId(projectId, 'Project ID'))
    return summarizePrAgentAssignments(projectPath, validatePrNumbers(numbers))
  })

  ipcMain.handle(
    'pr:comment',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      pullNumber: unknown,
      body: unknown
    ) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      return runGitHubMutation(target.owner, target.repo, () =>
        provider.createPullRequestComment({
          ...target,
          body: validatePrCommentBody(body)
        })
      )
    }
  )

  ipcMain.handle(
    'pr:commentEdit',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      pullNumber: unknown,
      kind: unknown,
      commentId: unknown,
      body: unknown
    ) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      const comment = {
        ...target,
        kind: validatePrCommentKind(kind),
        commentId: validatePrCommentId(commentId)
      }
      const text = validatePrCommentBody(body)
      return runGitHubMutation(target.owner, target.repo, async () => {
        if (comment.kind === 'review') {
          await provider.updatePullRequestReviewComment({ ...comment, body: text })
        } else {
          await provider.updatePullRequestComment({ ...comment, body: text })
        }
        // The reader refetches the bundle either way, so the edited entity is not
        // worth serializing, only whether the write landed.
        return true
      })
    }
  )

  ipcMain.handle(
    'pr:commentDelete',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      pullNumber: unknown,
      kind: unknown,
      commentId: unknown
    ) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      const comment = {
        ...target,
        kind: validatePrCommentKind(kind),
        commentId: validatePrCommentId(commentId)
      }
      return runGitHubMutation(target.owner, target.repo, async () => {
        await provider.deletePullRequestComment(comment)
        return true
      })
    }
  )

  ipcMain.handle(
    'pr:commentReply',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      pullNumber: unknown,
      commentId: unknown,
      body: unknown
    ) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      const id = validatePrCommentId(commentId)
      const text = validatePrCommentBody(body)
      return runGitHubMutation(target.owner, target.repo, () =>
        provider.replyToPullRequestReviewComment({ ...target, commentId: id, body: text })
      )
    }
  )

  ipcMain.handle(
    'pr:commentMinimize',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      pullNumber: unknown,
      nodeId: unknown,
      reason: unknown
    ) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      const id = validateGraphqlNodeId(nodeId)
      const classifier = validatePrMinimizeReason(reason)
      return runGitHubMutation(target.owner, target.repo, async () => {
        await provider.minimizePullRequestComment({ nodeId: id, reason: classifier })
        return true
      })
    }
  )

  ipcMain.handle(
    'pr:threadResolve',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      pullNumber: unknown,
      threadNodeId: unknown,
      resolved: unknown
    ) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      const nodeId = validateGraphqlNodeId(threadNodeId)
      const settled = validateBoolean(resolved, 'Resolved')
      return runGitHubMutation(target.owner, target.repo, async () => {
        await provider.setPullRequestReviewThreadResolved({ nodeId, resolved: settled })
        return true
      })
    }
  )

  ipcMain.handle(
    'pr:react',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      pullNumber: unknown,
      subjectNodeId: unknown,
      content: unknown,
      add: unknown
    ) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      const nodeId = validateGraphqlNodeId(subjectNodeId)
      const reaction = validatePrReactionContent(content)
      const adding = validateBoolean(add, 'Add reaction')
      return runGitHubMutation(target.owner, target.repo, () =>
        provider.setReaction({ nodeId, content: reaction, add: adding })
      )
    }
  )

  ipcMain.handle(
    'pr:review',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      pullNumber: unknown,
      event: unknown,
      body: unknown
    ) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      const verdict = validatePrReviewEvent(event)
      const text = validatePrCommentBody(body, true)
      // GitHub rejects a REQUEST_CHANGES or COMMENT review without a body.
      if (verdict !== 'APPROVE' && !text.trim()) {
        throw new Error('Leave a comment explaining the requested changes')
      }
      return runGitHubMutation(target.owner, target.repo, async () => {
        await provider.createPullRequestReview({ ...target, event: verdict, body: text })
        return null
      })
    }
  )

  ipcMain.handle(
    'pr:createAgentAssignment',
    async (_, projectId: unknown, pullNumber: unknown, threadId: unknown, input: unknown) => {
      const projectPath = await resolveProjectPath(validateEntityId(projectId, 'Project ID'))
      return createPrAgentAssignment(
        projectPath,
        validatePrNumber(pullNumber),
        validateEntityId(threadId, 'Thread ID'),
        validatePrAgentAssignmentInput(input)
      )
    }
  )

  ipcMain.handle('pr:composeWithAgent', async (_, ...args: unknown[]) => {
    const safeProjectId = validateEntityId(args[0], 'Project ID')
    const scopeBucketId = validateEntityId(args[1], 'Scope bucket ID')
    const virtualTaskId = validateEntityId(args[2], 'Virtual task ID')
    const requestedSettings = validateThreadSettings(args[3])
    const settings = validateThreadSettings({
      harnessId: requestedSettings.harnessId,
      providerId: requestedSettings.providerId,
      modelId: requestedSettings.modelId,
      thinkingLevel: requestedSettings.thinkingLevel,
      inferenceMode: 'normal',
      permissionLevel: 'auto_review',
      assignmentMode: false,
      loopMode: false,
      fileSystemMode: false
    })
    const input = validatePrComposeInput(args[4])
    // Everything past validation is an expected outcome rather than a thrown
    // failure: the harness the user picked may be missing, unauthenticated,
    // rate-limited, or unable to start. Returning it keeps the cause and the
    // retryability on the wire, so the sheet can offer a way out instead of an
    // exception it can only print.
    try {
      if (!chatEngine?.runVirtualTask) throw new Error('The PR compose agent is unavailable')
      const context = await gitService.pullRequestComposeContext(
        await resolveProjectPath(safeProjectId, scopeBucketId),
        input
      )
      const response = await chatEngine.runVirtualTask(
        safeProjectId,
        virtualTaskId,
        settings,
        `Compose PR: ${input.head} to ${input.base}`,
        prComposePrompt(input, context),
        {
          systemPrompt: PR_COMPOSE_SYSTEM_PROMPT,
          readOnly: true,
          allowedTools: [],
          structuredOutput: { schema: PR_COMPOSE_OUTPUT_SCHEMA, retryCount: 2 },
          textOutputFallback: {
            accepts: hasPrComposeResponse,
            repairPrompt: prComposeRepairPrompt
          }
        }
      )
      const report = prComposeResponse(response)
      if (!report.title.trim()) throw new Error('The PR compose agent returned no title')
      return { status: 'completed' as const, report: { ...report, taskId: virtualTaskId } }
    } catch (error) {
      // The outcome carries this to the sheet; the dev log keeps the raw cause
      // available when the sanitized message is not enough to diagnose with.
      Logger.dev('PR compose agent failed', error)
      return {
        status: 'failed' as const,
        issue: harnessFailureIssue(error, settings.harnessId)
      }
    }
  })
}
