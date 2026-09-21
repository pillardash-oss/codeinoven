import { invoke } from '$lib/ipc.svelte'
import type {
  GitHubMutationResult,
  GitHubPermissionRequired,
  PrCommentKind,
  PrComposeInput,
  PrComposeReport,
  PrCreateInput,
  PrMergeMethod,
  PrMinimizeReason,
  PrReviewEvent,
  PrState,
  PullRequestComment,
  PullRequestCompare,
  PullRequestReference,
  ThreadSettings
} from '$shared/types'
import { errorMessage, type GitOperation } from './git-store-helpers'

/** The store services the PR operations need, so the class stays decoupled. */
export interface GitPrOperationAccess {
  markBusy(operation: GitOperation, busy: boolean): void
  setError(message: string | null): void
  setGitHubPermission(permission: GitHubPermissionRequired | null): void
  scopeFor(projectId: string): string | undefined
  refreshConflictIndicators(projectId: string, force?: boolean): void
  updateDraftState(owner: string, repo: string, pullNumber: number, draft: boolean): void
}

/** Online pull request operations, backed by the store's shared state. */
export class GitPullRequestOperations {
  constructor(private readonly access: GitPrOperationAccess) {}

  private resolveMutation<T>(result: GitHubMutationResult<T>): T | null {
    if (result.status === 'permission_required') {
      this.access.setGitHubPermission(result)
      return null
    }
    this.access.setGitHubPermission(null)
    return result.value
  }

  async createPullRequest(
    projectId: string,
    input: PrCreateInput
  ): Promise<PullRequestReference | null> {
    this.access.markBusy('pr-create', true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      const scopeBucketId = this.access.scopeFor(projectId)
      const result = scopeBucketId
        ? await invoke('pr:create', projectId, input, scopeBucketId)
        : await invoke('pr:create', projectId, input)
      const reference = this.resolveMutation(result)
      // A new PR can already have conflicts - refresh the indicator immediately.
      this.access.refreshConflictIndicators(projectId, true)
      return reference
    } catch (reason) {
      this.access.setError(errorMessage(reason, 'Pull request could not be created'))
      return null
    } finally {
      this.access.markBusy('pr-create', false)
    }
  }

  async mergePullRequest(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    method: PrMergeMethod,
    commitTitle?: string,
    commitMessage?: string
  ): Promise<PullRequestReference | null> {
    this.access.markBusy('pr-merge', true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      const reference = this.resolveMutation(
        await invoke(
          'pr:merge',
          projectId,
          owner,
          repo,
          pullNumber,
          method,
          commitTitle,
          commitMessage
        )
      )
      // Merging removes the PR from the open set - refresh the indicator.
      this.access.refreshConflictIndicators(projectId, true)
      return reference
    } catch (reason) {
      this.access.setError(errorMessage(reason, 'Pull request could not be merged'))
      return null
    } finally {
      this.access.markBusy('pr-merge', false)
    }
  }

  /** Promote a draft pull request to ready-for-review before merge. */
  async markPullRequestReadyForReview(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<PullRequestReference | null> {
    this.access.markBusy('pr-ready', true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      const reference = this.resolveMutation(
        await invoke('pr:ready', projectId, owner, repo, pullNumber)
      )
      if (reference) this.access.updateDraftState(owner, repo, pullNumber, false)
      return reference
    } catch (reason) {
      this.access.setError(
        errorMessage(reason, 'Pull request could not be marked ready for review')
      )
      return null
    } finally {
      this.access.markBusy('pr-ready', false)
    }
  }

  async listPullRequests(
    projectId: string,
    owner: string,
    repo: string,
    state: PrState = 'open'
  ): Promise<PullRequestReference[]> {
    try {
      return await invoke('pr:list', projectId, owner, repo, state)
    } catch {
      return []
    }
  }

  /**
   * The remote's actual default branch, so the PR form can preselect the
   * real base instead of guessing "main" for repos that target something else.
   */
  async getDefaultBranch(projectId: string): Promise<string | null> {
    try {
      const scopeBucketId = this.access.scopeFor(projectId)
      return scopeBucketId
        ? await invoke('git:defaultBranch', projectId, scopeBucketId)
        : await invoke('git:defaultBranch', projectId)
    } catch {
      return null
    }
  }

  /**
   * Compare two refs so the create-PR form can gate on there being a real
   * change. Returns null on failure so the form can disable creation safely.
   */
  async comparePullRequests(
    projectId: string,
    owner: string,
    repo: string,
    base: string,
    head: string
  ): Promise<PullRequestCompare | null> {
    try {
      const scopeBucketId = this.access.scopeFor(projectId)
      return scopeBucketId
        ? await invoke('pr:compare', projectId, owner, repo, base, head, scopeBucketId)
        : await invoke('pr:compare', projectId, owner, repo, base, head)
    } catch {
      return null
    }
  }

  /** Reopen a closed pull request, mirroring GitHub's reopen. */
  async reopenPullRequest(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<PullRequestReference | null> {
    this.access.markBusy('pr-reopen', true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      const reference = this.resolveMutation(
        await invoke('pr:reopen', projectId, owner, repo, pullNumber)
      )
      // A reopened PR may conflict again - refresh the indicator.
      this.access.refreshConflictIndicators(projectId, true)
      return reference
    } catch (reason) {
      this.access.setError(errorMessage(reason, 'Pull request could not be reopened'))
      return null
    } finally {
      this.access.markBusy('pr-reopen', false)
    }
  }

  /** Close an open pull request without merging, mirroring GitHub's close. */
  async closePullRequest(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<PullRequestReference | null> {
    this.access.markBusy('pr-close', true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      const reference = this.resolveMutation(
        await invoke('pr:close', projectId, owner, repo, pullNumber)
      )
      // Closing removes the PR from the open set - refresh the indicator.
      this.access.refreshConflictIndicators(projectId, true)
      return reference
    } catch (reason) {
      this.access.setError(errorMessage(reason, 'Pull request could not be closed'))
      return null
    } finally {
      this.access.markBusy('pr-close', false)
    }
  }

  /** Update an open pull request's title and/or description, mirroring GitHub's edit. */
  async updatePullRequest(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    title: string | undefined,
    body: string | undefined
  ): Promise<PullRequestReference | null> {
    this.access.markBusy('pr-update', true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      return this.resolveMutation(
        await invoke('pr:update', projectId, owner, repo, pullNumber, title, body)
      )
    } catch (reason) {
      this.access.setError(errorMessage(reason, 'Pull request could not be updated'))
      return null
    } finally {
      this.access.markBusy('pr-update', false)
    }
  }

  /** Run PR composition as a one-shot virtual agent task with no persisted thread. */
  async composeWithAgent(
    projectId: string,
    virtualTaskId: string,
    settings: ThreadSettings,
    input: PrComposeInput
  ): Promise<PrComposeReport | null> {
    this.access.setError(null)
    try {
      const scopeBucketId = this.access.scopeFor(projectId)
      if (!scopeBucketId) throw new Error('The pull request scope is unavailable')
      return await invoke(
        'pr:composeWithAgent',
        projectId,
        scopeBucketId,
        virtualTaskId,
        settings,
        input
      )
    } catch (reason) {
      this.access.setError(errorMessage(reason, 'The PR compose agent could not complete its task'))
      return null
    }
  }

  async commentOnPullRequest(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    body: string
  ): Promise<PullRequestComment | null> {
    this.access.markBusy('pr-comment', true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      return this.resolveMutation(
        await invoke('pr:comment', projectId, owner, repo, pullNumber, body)
      )
    } catch (reason) {
      this.access.setError(errorMessage(reason, 'The comment could not be posted'))
      return null
    } finally {
      this.access.markBusy('pr-comment', false)
    }
  }

  async reviewPullRequest(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    event: PrReviewEvent,
    body: string
  ): Promise<boolean> {
    this.access.markBusy('pr-review', true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      const result = await invoke('pr:review', projectId, owner, repo, pullNumber, event, body)
      if (result.status === 'permission_required') {
        this.access.setGitHubPermission(result)
        return false
      }
      return true
    } catch (reason) {
      this.access.setError(errorMessage(reason, 'The review could not be submitted'))
      return false
    } finally {
      this.access.markBusy('pr-review', false)
    }
  }

  /**
   * Rewrite an already-posted comment in place.
   *
   * `kind` selects the collection because GitHub stores conversation comments and
   * inline diff comments in two unrelated endpoints with independent id sequences.
   * The mutation returns only whether the write landed: the caller refetches the
   * bundle, which is the one path that keeps the reader's conversation, counts and
   * "edited" marker consistent with the server.
   */
  async editPrComment(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    kind: PrCommentKind,
    commentId: number,
    body: string
  ): Promise<boolean> {
    this.access.markBusy('pr-comment-edit', true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      return (
        this.resolveMutation(
          await invoke('pr:commentEdit', projectId, owner, repo, pullNumber, kind, commentId, body)
        ) === true
      )
    } catch (reason) {
      this.access.setError(errorMessage(reason, 'The comment could not be saved'))
      return false
    } finally {
      this.access.markBusy('pr-comment-edit', false)
    }
  }

  /**
   * Permanently delete a comment. GitHub only allows this for its author, so the
   * caller is responsible for only offering it on your own comment.
   */
  async deletePrComment(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    kind: PrCommentKind,
    commentId: number
  ): Promise<boolean> {
    this.access.markBusy('pr-comment-delete', true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      return (
        this.resolveMutation(
          await invoke('pr:commentDelete', projectId, owner, repo, pullNumber, kind, commentId)
        ) === true
      )
    } catch (reason) {
      this.access.setError(errorMessage(reason, 'The comment could not be deleted'))
      return false
    } finally {
      this.access.markBusy('pr-comment-delete', false)
    }
  }

  /**
   * Answer an inline review comment inside its thread.
   *
   * The reply joins the thread on GitHub rather than starting a new one, which is
   * why the whole comment is addressed: GitHub files the answer under the comment
   * it replies to. Returns whether the write landed; the caller refetches the
   * bundle so the thread, counts, and avatars come from the server.
   */
  async replyToPrReviewComment(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    commentId: number,
    body: string
  ): Promise<boolean> {
    this.access.markBusy('pr-comment-reply', true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      return (
        this.resolveMutation(
          await invoke('pr:commentReply', projectId, owner, repo, pullNumber, commentId, body)
        ) !== null
      )
    } catch (reason) {
      this.access.setError(errorMessage(reason, 'The reply could not be posted'))
      return false
    } finally {
      this.access.markBusy('pr-comment-reply', false)
    }
  }

  /**
   * Hide a comment behind GitHub's minimised treatment. Addresses the comment by
   * its GraphQL node id, because GitHub exposes no REST endpoint for this.
   */
  async minimizePrComment(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    nodeId: string,
    reason: PrMinimizeReason
  ): Promise<boolean> {
    this.access.markBusy('pr-comment-hide', true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      return (
        this.resolveMutation(
          await invoke('pr:commentMinimize', projectId, owner, repo, pullNumber, nodeId, reason)
        ) === true
      )
    } catch (error) {
      this.access.setError(errorMessage(error, 'The comment could not be hidden'))
      return false
    } finally {
      this.access.markBusy('pr-comment-hide', false)
    }
  }

  /** Create `.cio/git/pr/<number>/` so an agent has somewhere to write its report. */
  async createPrReviewWorkspace(
    projectId: string,
    pullNumber: number,
    threadId?: string
  ): Promise<string | null> {
    try {
      return await invoke('pr:reviewWorkspace', projectId, pullNumber, threadId)
    } catch (reason) {
      this.access.setError(errorMessage(reason, 'The review workspace could not be created'))
      return null
    }
  }
}
  /**
   * Settle or reopen one inline thread.
   *
   * Resolution belongs to the thread and lives on GraphQL, so this addresses the
   * thread's node id. Returns whether the write landed; the caller refetches the
   * bundle, which is what keeps the reader's thread list and its resolved marks
   * consistent with the server.
   */
  async setPrReviewThreadResolved(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    threadNodeId: string,
    resolved: boolean
  ): Promise<boolean> {
    this.access.markBusy('pr-thread-resolve', true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      return (
        this.resolveMutation(
          await invoke(
            'pr:threadResolve',
            projectId,
            owner,
            repo,
            pullNumber,
            threadNodeId,
            resolved
          )
        ) !== null
      )
    } catch (reason) {
      this.access.setError(
        errorMessage(
          reason,
          resolved ? 'The thread could not be resolved' : 'The thread could not be reopened'
        )
      )
      return false
    } finally {
      this.access.markBusy('pr-thread-resolve', false)
    }
  }

