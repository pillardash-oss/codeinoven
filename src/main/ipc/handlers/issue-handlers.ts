import { ProviderHttpError } from '../../providers/github-provider'
import { isNetworkError } from '../../util/network-error'
import {
  validateBoolean,
  validateBoundedString,
  validateEntityId,
  validateGraphqlNodeId,
  validateIssueListRequest,
  validateIssueNumber,
  validateIssueState,
  validateIssueStateReason,
  validateIssueTitle,
  validateNewIssueInput,
  validatePrAssigneeLogins,
  validatePrCommentBody,
  validatePrCommentId,
  validatePrLabelNames,
  validatePrMilestoneNumber,
  validatePrPage,
  validatePrReactionContent,
  validatePrState
} from '../ipc-validation'
import {
  GITHUB_REPOSITORY_ACCESS_MESSAGE,
  GITHUB_TRANSIENT_MESSAGE,
  resolveGitHubRemoteIdentity,
  runGitHubMutation
} from './shared'
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import type { GitProvider, IssueLinkInput } from '../../git/git-provider.interface'
import type { IpcHandlerContext } from './context'
import type { PrReactionMap } from '../../../lib/types'

const ISSUE_PAGE_SIZE = 20

/** The permission an issue write needs, named the way the App-install prompt reads it. */
const ISSUE_WRITE_ACCESS = 'Issues read and write access'

export function registerIssueHandlers(ctx: IpcHandlerContext): void {
  const { repositoryService, resolveProjectPath, providerForProject } = ctx

  /**
   * Resolve the provider plus a validated issue target in one step.
   *
   * Every issue call but the listing and the create addresses one issue, so the
   * provider/target preamble lives here rather than being repeated per handler.
   */
  const issueContext = async (
    projectId: unknown,
    owner: unknown,
    repo: unknown,
    issueNumber: unknown
  ): Promise<{
    provider: GitProvider
    owner: string
    repo: string
    issueNumber: number
  }> => {
    const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
    if (!provider) throw new Error('Sign in to GitHub first (Git panel → GitHub account)')
    return {
      provider,
      owner: validateBoundedString(owner, 'Issue owner', 1, 128),
      repo: validateBoundedString(repo, 'Issue repository', 1, 128),
      issueNumber: validateIssueNumber(issueNumber)
    }
  }

  ipcMain.handle(
    'issue:page',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      state: unknown,
      page: unknown,
      request: unknown
    ) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      const safePage = validatePrPage(page)
      const listing = validateIssueListRequest(request)
      // An unauthenticated page is NOT an empty page   the renderer must be able
      // to tell "no open issues" from "GitHub isn't connected yet".
      if (!provider) throw new Error('Sign in to GitHub first (Git panel → GitHub account)')
      try {
        return await provider.listIssuePage({
          owner: validateBoundedString(owner, 'Issue owner', 1, 128),
          repo: validateBoundedString(repo, 'Issue repository', 1, 128),
          state: validatePrState(state),
          page: safePage,
          perPage: ISSUE_PAGE_SIZE,
          filter: listing.filter,
          sort: listing.sort,
          cursor: listing.cursor
        })
      } catch (error) {
        if (error instanceof ProviderHttpError && (error.status === 403 || error.status === 404)) {
          return {
            items: [],
            page: safePage,
            hasMore: false,
            accessError: GITHUB_REPOSITORY_ACCESS_MESSAGE
          }
        }
        // A transient transport failure is reported as one, not as a rejected
        // call: the renderer keeps the rows it already has and shows the line.
        if (isNetworkError(error)) {
          return {
            items: [],
            page: safePage,
            hasMore: false,
            transientError: GITHUB_TRANSIENT_MESSAGE
          }
        }
        throw error
      }
    }
  )

  ipcMain.handle(
    'issue:bundle',
    async (_, projectId: unknown, owner: unknown, repo: unknown, issueNumber: unknown) => {
      const { provider, ...target } = await issueContext(projectId, owner, repo, issueNumber)
      // Fetched together so the reader renders one complete view rather than a
      // detail that arrives before its conversation. The comments are optional:
      // an issue is worth opening even when its conversation could not be read.
      const [detail, comments] = await Promise.all([
        provider.getIssue(target),
        provider.listIssueComments(target).catch(() => [])
      ])
      // Reactions are one batched read over both reactable subjects the reader
      // draws: the issue itself and each of its comments. Their node ids are what
      // it addresses, so it follows the comments rather than racing them, and it is
      // optional like the comments   the conversation is worth showing even when
      // its reactions could not be read.
      const subjects = [detail.nodeId, ...comments.map((comment) => comment.nodeId)].filter(
        (id): id is string => id !== null
      )
      const reactions = await provider
        .listReactions([...new Set(subjects)])
        .catch((): PrReactionMap => ({}))
      return { detail, comments, reactions, fetchedAt: Date.now() }
    }
  )

  ipcMain.handle(
    'issue:timeline',
    async (_, projectId: unknown, owner: unknown, repo: unknown, issueNumber: unknown) => {
      const { provider, ...target } = await issueContext(projectId, owner, repo, issueNumber)
      return provider.listIssueTimeline(target)
    }
  )

  ipcMain.handle(
    'issue:relationships',
    async (_, projectId: unknown, owner: unknown, repo: unknown, issueNumber: unknown) => {
      const { provider, ...target } = await issueContext(projectId, owner, repo, issueNumber)
      return provider.listIssueRelationships(target)
    }
  )

  ipcMain.handle(
    'issue:candidates',
    async (_, projectId: unknown, owner: unknown, repo: unknown, text: unknown) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) throw new Error('Sign in to GitHub to browse issues')
      return provider.searchIssueCandidates({
        owner: validateBoundedString(owner, 'Issue owner', 1, 128),
        repo: validateBoundedString(repo, 'Issue repository', 1, 128),
        text: validateBoundedString(text, 'Search text', 0, 256)
      })
    }
  )

  /**
   * Register one relationship write.
   *
   * All four take the same pair of node ids and differ only in the mutation they
   * call, so the provider resolution, the id validation and the permission mapping
   * live here instead of four times over. The ids are the only handles these
   * mutations accept, which is why they are validated as node ids and not numbers.
   */
  const relationshipWrite = (
    channel:
      'issue:addSubIssue' | 'issue:removeSubIssue' | 'issue:addBlockedBy' | 'issue:removeBlockedBy',
    mutation: (provider: GitProvider, input: IssueLinkInput) => Promise<void>
  ): void => {
    ipcMain.handle(
      channel,
      async (
        _,
        projectId: unknown,
        owner: unknown,
        repo: unknown,
        issueNodeId: unknown,
        relatedNodeId: unknown
      ) => {
        const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
        if (!provider) throw new Error('Sign in to GitHub to change issue relationships')
        const targetOwner = validateBoundedString(owner, 'Issue owner', 1, 128)
        const targetRepo = validateBoundedString(repo, 'Issue repository', 1, 128)
        const link: IssueLinkInput = {
          owner: targetOwner,
          repo: targetRepo,
          issueNodeId: validateGraphqlNodeId(issueNodeId),
          relatedNodeId: validateGraphqlNodeId(relatedNodeId)
        }
        return runGitHubMutation(
          targetOwner,
          targetRepo,
          () => mutation(provider, link),
          ISSUE_WRITE_ACCESS
        )
      }
    )
  }

  relationshipWrite('issue:addSubIssue', (provider, input) => provider.addIssueSubIssue(input))
  relationshipWrite('issue:removeSubIssue', (provider, input) =>
    provider.removeIssueSubIssue(input)
  )
  relationshipWrite('issue:addBlockedBy', (provider, input) => provider.addIssueBlockedBy(input))
  relationshipWrite('issue:removeBlockedBy', (provider, input) =>
    provider.removeIssueBlockedBy(input)
  )

  ipcMain.handle('issue:create', async (_, projectId: unknown, input: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    const provider = await providerForProject(safeProjectId)
    if (!provider) throw new Error('Sign in to GitHub to open issues')
    const identity = await resolveGitHubRemoteIdentity(
      repositoryService,
      await resolveProjectPath(safeProjectId)
    )
    const issue = validateNewIssueInput(input)
    return runGitHubMutation(
      identity.owner,
      identity.repo,
      () => provider.createIssue({ owner: identity.owner, repo: identity.repo, ...issue }),
      ISSUE_WRITE_ACCESS
    )
  })

  ipcMain.handle(
    'issue:update',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      issueNumber: unknown,
      title: unknown,
      body: unknown
    ) => {
      const { provider, ...target } = await issueContext(projectId, owner, repo, issueNumber)
      return runGitHubMutation(
        target.owner,
        target.repo,
        () =>
          provider.updateIssue({
            ...target,
            title: title === undefined ? undefined : validateIssueTitle(title),
            body: body === undefined ? undefined : validatePrCommentBody(body, true)
          }),
        ISSUE_WRITE_ACCESS
      )
    }
  )

  ipcMain.handle(
    'issue:state',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      issueNumber: unknown,
      state: unknown,
      stateReason?: unknown
    ) => {
      const { provider, ...target } = await issueContext(projectId, owner, repo, issueNumber)
      const nextState = validateIssueState(state)
      const reason =
        stateReason === undefined || stateReason === null
          ? undefined
          : validateIssueStateReason(stateReason)
      return runGitHubMutation(
        target.owner,
        target.repo,
        () =>
          provider.setIssueState({
            ...target,
            state: nextState,
            ...(reason ? { stateReason: reason } : {})
          }),
        ISSUE_WRITE_ACCESS
      )
    }
  )

  ipcMain.handle(
    'issue:comment',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      issueNumber: unknown,
      body: unknown
    ) => {
      const { provider, ...target } = await issueContext(projectId, owner, repo, issueNumber)
      return runGitHubMutation(
        target.owner,
        target.repo,
        () => provider.createIssueComment({ ...target, body: validatePrCommentBody(body) }),
        ISSUE_WRITE_ACCESS
      )
    }
  )

  ipcMain.handle(
    'issue:commentEdit',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      commentId: unknown,
      body: unknown
    ) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) throw new Error('Sign in to GitHub first (Git panel → GitHub account)')
      const ownerValue = validateBoundedString(owner, 'Issue owner', 1, 128)
      const repoValue = validateBoundedString(repo, 'Issue repository', 1, 128)
      return runGitHubMutation(
        ownerValue,
        repoValue,
        () =>
          provider.updateIssueComment({
            owner: ownerValue,
            repo: repoValue,
            commentId: validatePrCommentId(commentId),
            body: validatePrCommentBody(body)
          }),
        ISSUE_WRITE_ACCESS
      )
    }
  )

  ipcMain.handle(
    'issue:commentDelete',
    async (_, projectId: unknown, owner: unknown, repo: unknown, commentId: unknown) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) throw new Error('Sign in to GitHub first (Git panel → GitHub account)')
      const ownerValue = validateBoundedString(owner, 'Issue owner', 1, 128)
      const repoValue = validateBoundedString(repo, 'Issue repository', 1, 128)
      const id = validatePrCommentId(commentId)
      return runGitHubMutation(
        ownerValue,
        repoValue,
        async () => {
          await provider.deleteIssueComment({ owner: ownerValue, repo: repoValue, commentId: id })
          return null
        },
        ISSUE_WRITE_ACCESS
      )
    }
  )

  ipcMain.handle(
    'issue:setLabels',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      issueNumber: unknown,
      labels: unknown
    ) => {
      const { provider, ...target } = await issueContext(projectId, owner, repo, issueNumber)
      const safeLabels = validatePrLabelNames(labels)
      return runGitHubMutation(
        target.owner,
        target.repo,
        () =>
          provider.setPullRequestLabels({
            owner: target.owner,
            repo: target.repo,
            pullNumber: target.issueNumber,
            labels: safeLabels
          }),
        ISSUE_WRITE_ACCESS
      )
    }
  )

  ipcMain.handle(
    'issue:setAssignees',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      issueNumber: unknown,
      logins: unknown
    ) => {
      const { provider, ...target } = await issueContext(projectId, owner, repo, issueNumber)
      const safeLogins = validatePrAssigneeLogins(logins)
      return runGitHubMutation(
        target.owner,
        target.repo,
        () =>
          provider.setPullRequestAssignees({
            owner: target.owner,
            repo: target.repo,
            pullNumber: target.issueNumber,
            logins: safeLogins
          }),
        ISSUE_WRITE_ACCESS
      )
    }
  )

  ipcMain.handle(
    'issue:setMilestone',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      issueNumber: unknown,
      milestone: unknown
    ) => {
      const { provider, ...target } = await issueContext(projectId, owner, repo, issueNumber)
      const safeMilestone = milestone === null ? null : validatePrMilestoneNumber(milestone)
      return runGitHubMutation(
        target.owner,
        target.repo,
        () =>
          provider.setPullRequestMilestone({
            owner: target.owner,
            repo: target.repo,
            pullNumber: target.issueNumber,
            milestone: safeMilestone
          }),
        ISSUE_WRITE_ACCESS
      )
    }
  )

  ipcMain.handle(
    'issue:react',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      issueNumber: unknown,
      subjectNodeId: unknown,
      content: unknown,
      add: unknown
    ) => {
      const { provider, ...target } = await issueContext(projectId, owner, repo, issueNumber)
      return runGitHubMutation(
        target.owner,
        target.repo,
        () =>
          provider.setReaction({
            nodeId: validateGraphqlNodeId(subjectNodeId),
            content: validatePrReactionContent(content),
            add: validateBoolean(add, 'Add reaction')
          }),
        ISSUE_WRITE_ACCESS
      )
    }
  )
}
