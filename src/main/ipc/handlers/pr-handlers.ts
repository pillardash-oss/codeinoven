import { GitHubProvider, ProviderHttpError } from '../../providers/github-provider'
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
  validatePrCommentBody,
  validatePrCreateInput,
  validatePrListRequest,
  validatePrNumber,
  validatePrPage,
  validatePrState,
  validateWorkflowRerunMode
} from '../ipc-validation'
import { canonicalGitHubBranch, runGitHubMutation } from './shared'
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import type { GitHubDeploymentOverview } from '../../../lib/types'
import type { IpcHandlerContext } from './context'

const PR_PAGE_SIZE = 20
const GITHUB_REPOSITORY_ACCESS_MESSAGE =
  'GitHub cannot access this repository. Install the CodeInOven GitHub App on it and grant the requested repository permissions.'
/** Returned instead of a raw fetch failure when GitHub is unreachable (offline). */
const GITHUB_OFFLINE_MESSAGE =
  'GitHub is unreachable right now. Pull requests will refresh automatically once you are back online.'

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
  ): Promise<{ owner: string; repo: string }> => {
    const remoteUrl = await repositoryService.getRemoteOrigin(
      await resolveProjectPath(projectId, scopeBucketId)
    )
    const provider = new GitHubProvider('')
    const identity = provider.resolveRepositoryIdentity(remoteUrl ?? '')
    if (!identity) {
      throw new Error('No GitHub remote (origin) is configured for this project')
    }
    return identity
  }
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
      if (!provider) throw new Error('Sign in to GitHub to create pull requests')
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
        const openPrs = await provider.listPullRequestPage({
          owner: input.owner,
          repo: input.repo,
          state: 'open',
          page: 1,
          perPage: 100
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
        // An unreachable GitHub is a transient state, not a broken feature
        // degrade to an offline page so the renderer keeps its last known data.
        if (isNetworkError(error)) {
          return { items: [], page: safePage, hasMore: false, accessError: GITHUB_OFFLINE_MESSAGE }
        }
        throw error
      }
    }
  )

  ipcMain.handle(
    'deployment:overview',
    async (_, projectId: unknown, owner: unknown, repo: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const provider = await providerForProject(safeProjectId)
      if (!provider) throw new Error('Sign in to GitHub to monitor deployments')
      let overview: GitHubDeploymentOverview
      try {
        overview = await provider.getDeploymentOverview({
          owner: validateBoundedString(owner, 'Deployment owner', 1, 128),
          repo: validateBoundedString(repo, 'Deployment repository', 1, 128)
        })
      } catch (error) {
        if (error instanceof ProviderHttpError && (error.status === 403 || error.status === 404)) {
          return {
            workflowRuns: [],
            deployments: [],
            fetchedAt: Date.now(),
            hasDeployments: false,
            accessError: GITHUB_REPOSITORY_ACCESS_MESSAGE
          }
        }
        throw error
      }
      // The repo either deploys or it doesn't   persist that fact so the
      // Deployments tab only ever appears when there is something to show.
      const hasDeployments = overview.deployments.length > 0 || overview.workflowRuns.length > 0
      if (hasDeployments) {
        await projectManager.setHasDeployments(safeProjectId, true).catch(() => undefined)
      }
      return { ...overview, hasDeployments }
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
}
