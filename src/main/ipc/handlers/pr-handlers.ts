import { ProviderHttpError } from '../../providers/github-provider'
import { Logger } from '../../system/logger'
import { isNetworkError } from '../../util/network-error'
import {
  MAX_GITHUB_NUMERIC_ID,
  validateBoundedInteger,
  validateBoundedString,
  validateBranchName,
  validateEntityId,
  validateMergeCommitMessage,
  validateMergeCommitTitle,
  validateMergeMethod,
  validatePrAssigneeLogins,
  validatePrCommentBody,
  validatePrCreateInput,
  validatePrLabelNames,
  validatePrListRequest,
  validatePrMilestoneNumber,
  validatePrNumber,
  validatePrPage,
  validatePrState,
  validateDeploymentPage,
  validateWorkflowRunFilter,
  validateWorkflowRerunMode
} from '../ipc-validation'
import { canonicalGitHubBranch, resolveGitHubRemoteIdentity, runGitHubMutation } from './shared'
import { GITHUB_REPOSITORY_ACCESS_MESSAGE, GITHUB_TRANSIENT_MESSAGE } from './shared'
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import type { IpcHandlerContext } from './context'

const PR_PAGE_SIZE = 20
/** How many runs, or deployments, one Deployments page carries. */
const DEPLOYMENT_PAGE_SIZE = 20

/**
 * One listing read, with the two failures that are answers rather than rejections.
 *
 * A repository the App cannot see and a transport outage travel back as values,
 * exactly as `pr:page` reports them, so the Deployments view keeps the rows it was
 * already showing and still says why they may be stale.
 */
async function readDeploymentListing<Item>(
  page: number,
  read: () => Promise<{ items: Item[]; page: number; hasMore: boolean }>
): Promise<{
  items: Item[]
  page: number
  hasMore: boolean
  accessError?: string
  transientError?: string
}> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof ProviderHttpError && (error.status === 403 || error.status === 404)) {
      return { items: [], page, hasMore: false, accessError: GITHUB_REPOSITORY_ACCESS_MESSAGE }
    }
    if (isNetworkError(error)) {
      return { items: [], page, hasMore: false, transientError: GITHUB_TRANSIENT_MESSAGE }
    }
    throw error
  }
}

export function registerPrHandlers(ctx: IpcHandlerContext): void {
  const {
    projectManager,
    repositoryService,
    gitService,
    resolveProjectPath,
    providerForProject,
    pullRequestTarget
  } = ctx

  const remoteIdentity = async (
    projectId: string,
    scopeBucketId?: string
  ): Promise<{ owner: string; repo: string }> =>
    resolveGitHubRemoteIdentity(
      repositoryService,
      await resolveProjectPath(projectId, scopeBucketId)
    )
  ipcMain.handle(
    'pr:create',
    async (_, projectId: unknown, input: unknown, scopeBucketId?: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const provider = await providerForProject(safeProjectId)
      if (!provider) throw new Error('Configure a GitHub token first (Git panel → Credentials)')
      const safeScopeBucketId =
        scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
      const identity = await remoteIdentity(safeProjectId, safeScopeBucketId)
      const draft = validatePrCreateInput(input)
      return runGitHubMutation(identity.owner, identity.repo, () =>
        provider.createPullRequest({
          owner: identity.owner,
          repo: identity.repo,
          title: draft.title,
          body: draft.body,
          head: draft.head,
          base: draft.base,
          draft: draft.draft
        })
      )
    }
  )
  ipcMain.handle(
    'pr:list',
    async (_, projectId: unknown, owner: unknown, repo: unknown, state?: unknown) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) return []
      return provider.listPullRequests({
        owner: validateBoundedString(owner, 'PR owner', 1, 128),
        repo: validateBoundedString(repo, 'PR repository', 1, 128),
        ...(state === undefined ? {} : { state: validatePrState(state) })
      })
    }
  )
  ipcMain.handle(
    'pr:merge',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      pullNumber: unknown,
      method: unknown,
      commitTitle?: unknown,
      commitMessage?: unknown
    ) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) throw new Error('Configure a GitHub token first (Git panel → Credentials)')
      const safeOwner = validateBoundedString(owner, 'PR owner', 1, 128)
      const safeRepo = validateBoundedString(repo, 'PR repository', 1, 128)
      return runGitHubMutation(safeOwner, safeRepo, () =>
        provider.mergePullRequest({
          owner: safeOwner,
          repo: safeRepo,
          pullNumber: validatePrNumber(pullNumber),
          method: validateMergeMethod(method),
          ...(commitTitle === undefined
            ? {}
            : { commitTitle: validateMergeCommitTitle(commitTitle) }),
          ...(commitMessage === undefined
            ? {}
            : { commitMessage: validateMergeCommitMessage(commitMessage) })
        })
      )
    }
  )

  ipcMain.handle(
    'pr:compare',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      base: unknown,
      head: unknown,
      scopeBucketId?: unknown
    ) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const provider = await providerForProject(safeProjectId)
      // A compare with nobody signed in is not a branch fact, and it is the one
      // failure the form can resolve: signing in again re-arms it, whereas
      // "nothing to compare" is the branches answering for themselves. Reported
      // as data so the two never read the same in the panel.
      if (!provider) return { status: 'signed_out' as const }
      const safeBase = canonicalGitHubBranch(validateBranchName(base, 'Compare base'))
      const safeHead = canonicalGitHubBranch(validateBranchName(head, 'Compare head'))
      if (safeBase === safeHead) {
        return {
          source: 'local' as const,
          status: 'identical' as const,
          aheadBy: 0,
          behindBy: 0,
          totalCommits: 0,
          filesChanged: 0,
          hasChanges: false
        }
      }
      const input = {
        owner: validateBoundedString(owner, 'PR owner', 1, 128),
        repo: validateBoundedString(repo, 'PR repository', 1, 128),
        base: safeBase,
        head: safeHead
      }
      // Warn when an open PR already exists for this exact head→base pair
      // GitHub would reject a duplicate creation with a 422. The lookup is
      // advisory and never allowed to block the compare itself.
      let existing = null
      try {
        // The advisory duplicate check wants the plainest listing there is: every
        // open pull request, newest first, no relationship filter.
        const openPrs = await provider.listPullRequestPage({
          owner: input.owner,
          repo: input.repo,
          state: 'open',
          page: 1,
          perPage: 100,
          filter: 'all',
          sort: 'updated',
          cursor: null
        })
        const match = openPrs.items.find(
          (pr) =>
            canonicalGitHubBranch(pr.headRef) === safeHead &&
            canonicalGitHubBranch(pr.baseRef) === safeBase
        )
        if (match) {
          existing = match
        }
      } catch {
        existing = null
      }
      let remoteCompare = null
      let missingRemoteHead: ProviderHttpError | null = null
      try {
        remoteCompare = await provider.comparePullRequests(input)
        if (remoteCompare.hasChanges)
          return existing ? { ...remoteCompare, existing } : remoteCompare
      } catch (error) {
        // A branch that has never been pushed cannot be compared by GitHub yet.
        if (!(error instanceof ProviderHttpError) || error.status !== 404) throw error
        missingRemoteHead = error
      }
      const localCompare = await gitService.comparePullRequestBranches(
        await resolveProjectPath(
          safeProjectId,
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        safeBase,
        safeHead
      )
      if (localCompare?.hasChanges) return existing ? { ...localCompare, existing } : localCompare
      const fallback = remoteCompare ?? localCompare
      if (fallback) return existing ? { ...fallback, existing } : fallback
      throw missingRemoteHead ?? new Error('Could not compare these branches')
    }
  )

  ipcMain.handle(
    'pr:reopen',
    async (_, projectId: unknown, owner: unknown, repo: unknown, pullNumber: unknown) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      return runGitHubMutation(target.owner, target.repo, () => provider.reopenPullRequest(target))
    }
  )

  ipcMain.handle(
    'pr:ready',
    async (_, projectId: unknown, owner: unknown, repo: unknown, pullNumber: unknown) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      return runGitHubMutation(target.owner, target.repo, () =>
        provider.markPullRequestReadyForReview(target)
      )
    }
  )

  ipcMain.handle(
    'pr:close',
    async (_, projectId: unknown, owner: unknown, repo: unknown, pullNumber: unknown) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      return runGitHubMutation(target.owner, target.repo, () => provider.closePullRequest(target))
    }
  )

  /**
   * What a merged pull request's head branch is as far as deleting it goes.
   *
   * Read beside the merge so the reader only draws "Delete branch" for a branch
   * that is both unprotected and still there. A branch name is not a pull
   * request, so it resolves the repository's provider itself rather than through
   * `pullRequestTarget`.
   *
   * A failed read answers null rather than rejecting: the caller offers no action
   * on an answer it does not have, and a transport blip on a merged pull request
   * is weather rather than a defect worth a main-process error log.
   */
  ipcMain.handle(
    'pr:branchState',
    async (_, projectId: unknown, owner: unknown, repo: unknown, branch: unknown) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) throw new Error('Sign in to GitHub first (Git panel → GitHub account)')
      try {
        return await provider.readBranchDeletionState({
          owner: validateBoundedString(owner, 'PR owner', 1, 128),
          repo: validateBoundedString(repo, 'PR repository', 1, 128),
          branch: validateBranchName(branch)
        })
      } catch (reason) {
        if (!isNetworkError(reason)) Logger.dev('Branch deletion state could not be read', reason)
        return null
      }
    }
  )

  ipcMain.handle(
    'pr:deleteBranch',
    async (_, projectId: unknown, owner: unknown, repo: unknown, branch: unknown) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) throw new Error('Sign in to GitHub first (Git panel → GitHub account)')
      const target = {
        owner: validateBoundedString(owner, 'PR owner', 1, 128),
        repo: validateBoundedString(repo, 'PR repository', 1, 128),
        branch: validateBranchName(branch)
      }
      return runGitHubMutation(target.owner, target.repo, () => provider.deleteBranch(target))
    }
  )

  ipcMain.handle(
    'pr:update',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      pullNumber: unknown,
      title: unknown,
      body: unknown
    ) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      return runGitHubMutation(target.owner, target.repo, () =>
        provider.updatePullRequest({
          ...target,
          title: title === undefined ? undefined : validatePrCommentBody(title, true),
          body: body === undefined ? undefined : validatePrCommentBody(body, true)
        })
      )
    }
  )

  ipcMain.handle(
    'pr:setLabels',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      pullNumber: unknown,
      labels: unknown
    ) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      const safeLabels = validatePrLabelNames(labels)
      return runGitHubMutation(target.owner, target.repo, () =>
        provider.setPullRequestLabels({ ...target, labels: safeLabels })
      )
    }
  )

  ipcMain.handle(
    'pr:setAssignees',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      pullNumber: unknown,
      logins: unknown
    ) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      const safeLogins = validatePrAssigneeLogins(logins)
      return runGitHubMutation(target.owner, target.repo, () =>
        provider.setPullRequestAssignees({ ...target, logins: safeLogins })
      )
    }
  )

  ipcMain.handle(
    'pr:setMilestone',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      pullNumber: unknown,
      milestone: unknown
    ) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      const safeMilestone = milestone === null ? null : validatePrMilestoneNumber(milestone)
      return runGitHubMutation(target.owner, target.repo, () =>
        provider.setPullRequestMilestone({ ...target, milestone: safeMilestone })
      )
    }
  )

  ipcMain.handle('pr:labels', async (_, projectId: unknown, owner: unknown, repo: unknown) => {
    const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
    if (!provider) throw new Error('Sign in to GitHub first (Git panel → GitHub account)')
    return provider.listRepositoryLabels({
      owner: validateBoundedString(owner, 'PR owner', 1, 128),
      repo: validateBoundedString(repo, 'PR repository', 1, 128)
    })
  })

  ipcMain.handle('pr:milestones', async (_, projectId: unknown, owner: unknown, repo: unknown) => {
    const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
    if (!provider) throw new Error('Sign in to GitHub first (Git panel → GitHub account)')
    return provider.listRepositoryMilestones({
      owner: validateBoundedString(owner, 'PR owner', 1, 128),
      repo: validateBoundedString(repo, 'PR repository', 1, 128)
    })
  })

  ipcMain.handle(
    'pr:page',
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
      const listing = validatePrListRequest(request)
      // An unauthenticated page is NOT an empty page   the renderer must be
      // able to tell "no open PRs" from "GitHub isn't connected yet", or the
      // header conflict indicator would treat a cold start as zero conflicts.
      if (!provider) throw new Error('Sign in to GitHub first (Git panel → GitHub account)')
      try {
        return await provider.listPullRequestPage({
          owner: validateBoundedString(owner, 'PR owner', 1, 128),
          repo: validateBoundedString(repo, 'PR repository', 1, 128),
          state: validatePrState(state),
          page: safePage,
          perPage: PR_PAGE_SIZE,
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
        // call: the renderer keeps the rows it already has and shows the line,
        // and Electron records no handler error for it.
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
    'pr:search',
    async (_, projectId: unknown, owner: unknown, repo: unknown, state: unknown, text: unknown) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) throw new Error('Sign in to GitHub first (Git panel → GitHub account)')
      return provider.searchPullRequests({
        owner: validateBoundedString(owner, 'PR owner', 1, 128),
        repo: validateBoundedString(repo, 'PR repository', 1, 128),
        state: validatePrState(state),
        // Bounded like every other search term that reaches the provider, so the
        // query GitHub builds stays a query rather than a page of text.
        text: typeof text === 'string' ? text.slice(0, 256) : ''
      })
    }
  )

  ipcMain.handle(
    'deployment:activity',
    async (_, projectId: unknown, owner: unknown, repo: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const provider = await providerForProject(safeProjectId)
      if (!provider) throw new Error('Sign in to GitHub to monitor deployments')
      let hasDeployments: boolean
      try {
        hasDeployments = await provider.hasDeploymentActivity({
          owner: validateBoundedString(owner, 'Deployment owner', 1, 128),
          repo: validateBoundedString(repo, 'Deployment repository', 1, 128)
        })
      } catch (error) {
        if (error instanceof ProviderHttpError && (error.status === 403 || error.status === 404)) {
          return { hasDeployments: false, accessError: GITHUB_REPOSITORY_ACCESS_MESSAGE }
        }
        throw error
      }
      // The repo either deploys or it doesn't   persist that fact so the
      // Deployments tab only ever appears when there is something to show.
      if (hasDeployments) {
        await projectManager.setHasDeployments(safeProjectId, true).catch(() => undefined)
      }
      return { hasDeployments }
    }
  )

  ipcMain.handle(
    'deployment:runs',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      filter: unknown,
      page: unknown
    ) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) throw new Error('Sign in to GitHub to monitor deployments')
      const safePage = validateDeploymentPage(page)
      const safeFilter = validateWorkflowRunFilter(filter)
      return readDeploymentListing(safePage, () =>
        provider.listWorkflowRunPage({
          owner: validateBoundedString(owner, 'Deployment owner', 1, 128),
          repo: validateBoundedString(repo, 'Deployment repository', 1, 128),
          filter: safeFilter,
          page: safePage,
          perPage: DEPLOYMENT_PAGE_SIZE
        })
      )
    }
  )

  ipcMain.handle(
    'deployment:deployments',
    async (_, projectId: unknown, owner: unknown, repo: unknown, page: unknown) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) throw new Error('Sign in to GitHub to monitor deployments')
      const safePage = validateDeploymentPage(page)
      return readDeploymentListing(safePage, () =>
        provider.listDeploymentPage({
          owner: validateBoundedString(owner, 'Deployment owner', 1, 128),
          repo: validateBoundedString(repo, 'Deployment repository', 1, 128),
          page: safePage,
          perPage: DEPLOYMENT_PAGE_SIZE
        })
      )
    }
  )

  ipcMain.handle(
    'deployment:detail',
    async (_, projectId: unknown, owner: unknown, repo: unknown, deploymentId: unknown) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) throw new Error('Sign in to GitHub to inspect deployments')
      return provider.getDeploymentDetail({
        owner: validateBoundedString(owner, 'Deployment owner', 1, 128),
        repo: validateBoundedString(repo, 'Deployment repository', 1, 128),
        deploymentId: validateBoundedInteger(
          deploymentId,
          'Deployment ID',
          1,
          MAX_GITHUB_NUMERIC_ID
        )
      })
    }
  )

  ipcMain.handle(
    'deployment:runDetail',
    async (_, projectId: unknown, owner: unknown, repo: unknown, runId: unknown) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) throw new Error('Sign in to GitHub to inspect workflow runs')
      return provider.getWorkflowRunDetail({
        owner: validateBoundedString(owner, 'Deployment owner', 1, 128),
        repo: validateBoundedString(repo, 'Deployment repository', 1, 128),
        runId: validateBoundedInteger(runId, 'Workflow run ID', 1, MAX_GITHUB_NUMERIC_ID)
      })
    }
  )

  ipcMain.handle(
    'deployment:jobLog',
    async (_, projectId: unknown, owner: unknown, repo: unknown, jobId: unknown) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) throw new Error('Sign in to GitHub to read job logs')
      return provider.getDeploymentJobLog({
        owner: validateBoundedString(owner, 'Deployment owner', 1, 128),
        repo: validateBoundedString(repo, 'Deployment repository', 1, 128),
        jobId: validateBoundedInteger(jobId, 'Job ID', 1, MAX_GITHUB_NUMERIC_ID)
      })
    }
  )

  ipcMain.handle(
    'deployment:rerunRun',
    async (_, projectId: unknown, owner: unknown, repo: unknown, runId: unknown, mode: unknown) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) throw new Error('Sign in to GitHub to re-run workflow runs')
      const target = {
        owner: validateBoundedString(owner, 'Deployment owner', 1, 128),
        repo: validateBoundedString(repo, 'Deployment repository', 1, 128)
      }
      return runGitHubMutation(
        target.owner,
        target.repo,
        async () => {
          await provider.rerunWorkflowRun({
            ...target,
            runId: validateBoundedInteger(runId, 'Workflow run ID', 1, MAX_GITHUB_NUMERIC_ID),
            mode: validateWorkflowRerunMode(mode)
          })
          return null
        },
        'Actions read and write access'
      )
    }
  )

  ipcMain.handle(
    'deployment:cancelRun',
    async (_, projectId: unknown, owner: unknown, repo: unknown, runId: unknown) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) throw new Error('Sign in to GitHub to cancel workflow runs')
      const target = {
        owner: validateBoundedString(owner, 'Deployment owner', 1, 128),
        repo: validateBoundedString(repo, 'Deployment repository', 1, 128)
      }
      return runGitHubMutation(
        target.owner,
        target.repo,
        async () => {
          await provider.cancelWorkflowRun({
            ...target,
            runId: validateBoundedInteger(runId, 'Workflow run ID', 1, MAX_GITHUB_NUMERIC_ID)
          })
          return null
        },
        'Actions read and write access'
      )
    }
  )
}
