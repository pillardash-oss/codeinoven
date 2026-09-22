import { invoke } from '$lib/ipc.svelte'
import type {
  GitHubMutationResult,
  GitHubPermissionRequired,
  PrAgentAssignmentInput,
  PrAgentAssignmentWorkspace,
  PrCommentKind,
  PrComposeInput,
  PrComposeOutcome,
  PrCreateInput,
  PrMergeMethod,
  PrMinimizeReason,
  PrReviewEvent,
  PrState,
  PullRequestComment,
  PullRequestCompare,
  PullRequestLabel,
  PullRequestMilestone,
  PullRequestReference,
  RepositoryMentionUser,
  ThreadSettings
} from '$shared/types'
import { errorMessage, type GitOperation } from './git-store-helpers'
import { classifyProviderIssue } from '$shared/provider-issue'
import type { CachedPullRequestPatch } from './git-store-pull-requests.svelte'

/**
 * One pull request a batch could not act on, with the reason the provider gave.
 *
 * The reason travels with the number because a batch that sweeps a backlog has to
 * say which ones survived and why. Dropping either half is how "17 of 20 closed"
 * becomes indistinguishable from "20 closed".
 */
export interface PrBatchFailure {
  number: number
  message: string
}

/** What a lifecycle batch actually did. */
export interface PrBatchResult {
  succeeded: number[]
  failed: PrBatchFailure[]
  /**
   * Pull requests the batch never reached, because it stopped on a failure that
   * would repeat for every one of them (missing App access, most often). Listed
   * so the count in the result cannot imply more attempts than were made.
   */
  skipped: number[]
  /** Why the batch stopped early, or null when it ran to the end. */
  stoppedBy: string | null
}

/** What one pull request's turn in a batch did, as the loop reads it. */
type PrBatchStep =
  | { outcome: 'done' }
  | { outcome: 'failed'; message: string }
  /** The batch should not continue: the refusal applies to every remaining row. */
  | { outcome: 'stopped'; message: string }

/**
 * Whether a refusal is GitHub asking the caller to slow down.
 *
 * A secondary rate limit and an abuse-detection refusal are statements about the
 * caller, not about the pull request being written, and both name themselves in the
 * message GitHub returns. Recognising them is what keeps a throttled batch from
 * spending its remaining rows collecting the same 403, which is exactly the pattern
 * that turns a soft limit into a flagged one.
 */
function isThrottleRefusal(message: string): boolean {
  return /rate limit|abuse detection/iu.test(message)
}

/** One metadata write's outcome: what the provider stored, or why it did not. */
export type PrMetadataOutcome<T> =
  { status: 'saved'; value: T } | { status: 'failed'; message: string }

/** The store services the PR operations need, so the class stays decoupled. */
export interface GitPrOperationAccess {
  markBusy(operation: GitOperation, busy: boolean): void
  setError(message: string | null): void
  setGitHubPermission(permission: GitHubPermissionRequired | null): void
  scopeFor(projectId: string): string | undefined
  refreshConflictIndicators(projectId: string, force?: boolean): void
  /** Rewrite a cached row after a successful write, so the list shows the truth. */
  patchPullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    patch: CachedPullRequestPatch
  ): void
  /** Record a lifecycle change across the cached listings. */
  applyPullRequestState(
    owner: string,
    repo: string,
    pullNumber: number,
    state: 'open' | 'closed' | 'merged'
  ): void
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
      // Merging removes the PR from the open set: refresh the indicator, and record
      // the new state so the list behind the reader stops listing it as open.
      if (reference) this.access.applyPullRequestState(owner, repo, pullNumber, 'merged')
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
      if (reference) {
        this.access.patchPullRequest(owner, repo, pullNumber, { draft: false })
      }
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
      // A reopened PR may conflict again, and it has left the closed listing it was
      // read from. Refresh the indicator once and record where the row now belongs.
      if (reference) this.access.applyPullRequestState(owner, repo, pullNumber, 'open')
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
      // Closing removes the PR from the open set: refresh the indicator, and record
      // the new state so the list drains the row instead of listing it as open until
      // the page cache ages out.
      if (reference) this.access.applyPullRequestState(owner, repo, pullNumber, 'closed')
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

  /**
   * Close every pull request in a batch, one at a time.
   *
   * Sequential on purpose. Each single close refreshes the open-PR conflict
   * indicator, and that refresh lists the repository's open pull requests and then
   * probes the mergeability of each one GitHub has not computed yet. Twenty closes
   * fired together would be twenty listings and twenty probe sets stacked on twenty
   * writes: a secondary rate limit, and a panel competing with itself for one
   * window. So this closes one, then the next, and refreshes the indicator once at
   * the end.
   *
   * `comment` rides along when the user wants each pull request to say why it went.
   * It is posted before the close, so a pull request whose note could not be posted
   * stays open: closing it would leave a row that gives no reason, and the batch
   * result names the ones that need a second attempt.
   *
   * Nothing here sets the store's error. A batch's failures belong to the batch, so
   * they come back in the result and are reported next to the count the user
   * confirmed, rather than in a banner that names no pull request.
   */
  async closePullRequests(
    projectId: string,
    owner: string,
    repo: string,
    numbers: number[],
    comment: string | null = null
  ): Promise<PrBatchResult> {
    return this.runLifecycleBatch(
      projectId,
      owner,
      repo,
      numbers,
      'pr-close',
      'closed',
      'Pull request could not be closed',
      comment
    )
  }

  /** Reopen every pull request in a batch, one at a time, for the same reasons. */
  async reopenPullRequests(
    projectId: string,
    owner: string,
    repo: string,
    numbers: number[],
    comment: string | null = null
  ): Promise<PrBatchResult> {
    return this.runLifecycleBatch(
      projectId,
      owner,
      repo,
      numbers,
      'pr-reopen',
      'open',
      'Pull request could not be reopened',
      comment
    )
  }

  private async runLifecycleBatch(
    projectId: string,
    owner: string,
    repo: string,
    numbers: number[],
    operation: 'pr-close' | 'pr-reopen',
    nextState: 'open' | 'closed',
    failureFallback: string,
    comment: string | null
  ): Promise<PrBatchResult> {
    const succeeded: number[] = []
    const failed: PrBatchFailure[] = []
    const skipped: number[] = []
    let stoppedBy: string | null = null
    this.access.markBusy(operation, true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      for (const [index, pullNumber] of numbers.entries()) {
        const step = await this.runBatchStep(
          projectId,
          owner,
          repo,
          pullNumber,
          operation,
          nextState,
          failureFallback,
          comment
        )
        if (step.outcome === 'done') {
          succeeded.push(pullNumber)
          continue
        }
        failed.push({ number: pullNumber, message: step.message })
        // Two refusals say something about the batch rather than about this one pull
        // request: missing App access, and being asked to slow down. Neither gets
        // better on the next row, and continuing would spend the rest of the batch
        // collecting the same answer while making the next one likelier.
        if (step.outcome === 'stopped' || isThrottleRefusal(step.message)) {
          skipped.push(...numbers.slice(index + 1))
          stoppedBy = step.message
          break
        }
      }
    } finally {
      this.access.markBusy(operation, false)
    }
    // One check for the whole batch: the indicator is a property of the open set,
    // and the open set only changed once, however many rows changed it.
    if (succeeded.length > 0) this.access.refreshConflictIndicators(projectId, true)
    return { succeeded, failed, skipped, stoppedBy }
  }

  /**
   * One pull request's turn in a batch: the note first, then the state change.
   *
   * The note is posted on its own so a refusal is reported as the comment failing
   * rather than as the close failing for a reason the user cannot see, and so a pull
   * request whose note did not land is left untouched: closing it anyway would leave
   * a row that gives no reason, and the batch result names the ones to retry.
   */
  private async runBatchStep(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    operation: 'pr-close' | 'pr-reopen',
    nextState: 'open' | 'closed',
    failureFallback: string,
    comment: string | null
  ): Promise<PrBatchStep> {
    if (comment) {
      try {
        const posted = await invoke('pr:comment', projectId, owner, repo, pullNumber, comment)
        if (posted.status === 'permission_required') {
          this.access.setGitHubPermission(posted)
          return { outcome: 'stopped', message: posted.message }
        }
      } catch (reason) {
        return {
          outcome: 'failed',
          message: `The comment could not be posted, so the pull request was left untouched: ${errorMessage(
            reason,
            'the provider refused it'
          )}`
        }
      }
    }
    try {
      const result =
        operation === 'pr-close'
          ? await invoke('pr:close', projectId, owner, repo, pullNumber)
          : await invoke('pr:reopen', projectId, owner, repo, pullNumber)
      if (result.status === 'permission_required') {
        this.access.setGitHubPermission(result)
        return { outcome: 'stopped', message: result.message }
      }
      this.access.applyPullRequestState(owner, repo, pullNumber, nextState)
      return { outcome: 'done' }
    } catch (reason) {
      return { outcome: 'failed', message: errorMessage(reason, failureFallback) }
    }
  }

  /**
   * Replace the labels a pull request carries.
   *
   * The whole set travels at once, and the cached row is rewritten from the
   * provider's own answer rather than from the caller's intent, so a label the
   * repository renamed, or one it refused, cannot end up on screen as applied.
   */
  async setPullRequestLabels(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    labels: string[]
  ): Promise<PrMetadataOutcome<PullRequestLabel[]>> {
    return this.writeMetadata(
      () => invoke('pr:setLabels', projectId, owner, repo, pullNumber, labels),
      'The labels could not be saved',
      (value) => this.access.patchPullRequest(owner, repo, pullNumber, { labels: value })
    )
  }

  /** Replace a pull request's assignees, caching the accounts the provider stored. */
  async setPullRequestAssignees(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    logins: string[]
  ): Promise<PrMetadataOutcome<RepositoryMentionUser[]>> {
    return this.writeMetadata(
      () => invoke('pr:setAssignees', projectId, owner, repo, pullNumber, logins),
      'The assignees could not be saved',
      (value) => this.access.patchPullRequest(owner, repo, pullNumber, { assignees: value })
    )
  }

  /**
   * Attach a milestone to a pull request, or clear it with `null`.
   *
   * A cleared milestone is a successful write whose value is null, which is why the
   * outcome carries a status rather than leaning on a null return.
   */
  async setPullRequestMilestone(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    milestone: number | null
  ): Promise<PrMetadataOutcome<PullRequestMilestone | null>> {
    return this.writeMetadata(
      () => invoke('pr:setMilestone', projectId, owner, repo, pullNumber, milestone),
      'The milestone could not be saved',
      (value) => this.access.patchPullRequest(owner, repo, pullNumber, { milestone: value })
    )
  }

  private async writeMetadata<T>(
    write: () => Promise<GitHubMutationResult<T>>,
    failureFallback: string,
    apply: (value: T) => void
  ): Promise<PrMetadataOutcome<T>> {
    this.access.markBusy('pr-metadata', true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      const result = await write()
      if (result.status === 'permission_required') {
        this.access.setGitHubPermission(result)
        return { status: 'failed', message: result.message }
      }
      apply(result.value)
      return { status: 'saved', value: result.value }
    } catch (reason) {
      return { status: 'failed', message: errorMessage(reason, failureFallback) }
    } finally {
      this.access.markBusy('pr-metadata', false)
    }
  }

  /**
   * Run PR composition as a one-shot virtual agent task with no persisted thread.
   *
   * Always resolves to an outcome. A harness that cannot run is an expected
   * result of the user's own model choice, not an exception, so it comes back as
   * a `failed` outcome carrying its cause and retryability for the sheet to act on.
   */
  async composeWithAgent(
    projectId: string,
    virtualTaskId: string,
    settings: ThreadSettings,
    input: PrComposeInput
  ): Promise<PrComposeOutcome> {
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
      // Only a transport or validation failure reaches here; the task reports its
      // own failures as an outcome.
      const message = errorMessage(reason, 'The PR compose agent could not be started')
      return {
        status: 'failed',
        issue: {
          kind: classifyProviderIssue(message),
          message,
          harnessId: settings.harnessId,
          retryable: true
        }
      }
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

  /**
   * Open an agent assignment on a pull request and return its report path.
   *
   * The assignment owns its own report file, so a pull request can carry a triage
   * and any number of comment assignments without one overwriting another.
   */
  async createAgentAssignment(
    projectId: string,
    pullNumber: number,
    threadId: string,
    input: PrAgentAssignmentInput
  ): Promise<PrAgentAssignmentWorkspace | null> {
    try {
      return await invoke('pr:createAgentAssignment', projectId, pullNumber, threadId, input)
    } catch (reason) {
      this.access.setError(errorMessage(reason, 'The agent assignment could not be created'))
      return null
    }
  }
}
