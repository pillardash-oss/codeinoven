import { invoke } from '$lib/ipc.svelte'
import type {
  GitHubMutationResult,
  GitHubPermissionRequired,
  IssueLabel,
  IssueMilestone,
  IssueReference,
  NewIssueInput,
  PrReactionContent,
  PrReactionGroup,
  RepositoryMentionUser
} from '$shared/types'
import { errorMessage, prReactionBusyKey, type GitOperation } from './git-store-helpers'
import type { CachedIssuePatch } from './git-store-issues.svelte'

/** One metadata write's outcome: what the provider stored, or why it did not. */
export type IssueMetadataOutcome<T> =
  { status: 'saved'; value: T } | { status: 'failed'; message: string }

/** The store services the issue operations need, so the class stays decoupled. */
export interface GitIssueOperationAccess {
  markBusy(operation: GitOperation, busy: boolean): void
  setError(message: string | null): void
  setGitHubPermission(permission: GitHubPermissionRequired | null): void
  /** Rewrite a cached row after a successful write, so the list shows the truth. */
  patchIssue(owner: string, repo: string, issueNumber: number, patch: CachedIssuePatch): void
  /** Replace one subject's reactions in the cached bundle, from the write's answer. */
  patchBundleReactions(
    owner: string,
    repo: string,
    issueNumber: number,
    nodeId: string,
    groups: PrReactionGroup[]
  ): void
}

/** Online issue operations, backed by the store's shared state. */
export class GitIssueOperations {
  constructor(private readonly access: GitIssueOperationAccess) {}

  private resolveMutation<T>(result: GitHubMutationResult<T>): T | null {
    if (result.status === 'permission_required') {
      this.access.setGitHubPermission(result)
      return null
    }
    this.access.setGitHubPermission(null)
    return result.value
  }

  /** Open a new issue on the repository. */
  async createIssue(projectId: string, input: NewIssueInput): Promise<IssueReference | null> {
    this.access.markBusy('issue-create', true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      return this.resolveMutation(await invoke('issue:create', projectId, input))
    } catch (reason) {
      this.access.setError(errorMessage(reason, 'Issue could not be created'))
      return null
    } finally {
      this.access.markBusy('issue-create', false)
    }
  }

  /** Rewrite an issue's title and/or body. */
  async updateIssue(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    title: string | undefined,
    body: string | undefined
  ): Promise<IssueReference | null> {
    this.access.markBusy('issue-update', true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      return this.resolveMutation(
        await invoke('issue:update', projectId, owner, repo, issueNumber, title, body)
      )
    } catch (reason) {
      this.access.setError(errorMessage(reason, 'Issue could not be updated'))
      return null
    } finally {
      this.access.markBusy('issue-update', false)
    }
  }

  /**
   * Close or reopen an issue.
   *
   * The cached row and its detail bundle are both corrected straight away, so the
   * listing drains or refills the row and the open reader shows the new state
   * without a refetch that would blank the conversation it is showing.
   */
  async setIssueState(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    state: 'open' | 'closed',
    stateReason?: 'completed' | 'not_planned'
  ): Promise<IssueReference | null> {
    this.access.markBusy('issue-state', true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      const reference = this.resolveMutation(
        await invoke('issue:state', projectId, owner, repo, issueNumber, state, stateReason)
      )
      if (reference) {
        this.access.patchIssue(owner, repo, issueNumber, {
          state,
          stateReason: state === 'closed' ? (stateReason ?? null) : null
        })
      }
      return reference
    } catch (reason) {
      this.access.setError(
        errorMessage(
          reason,
          state === 'closed' ? 'Issue could not be closed' : 'Issue could not be reopened'
        )
      )
      return null
    } finally {
      this.access.markBusy('issue-state', false)
    }
  }

  /**
   * Post a comment on an issue's conversation.
   *
   * The conversation is one ordered list, so the reader reads it back from the
   * provider after a comment write rather than splicing a row in by hand; this
   * only reports whether the write landed.
   */
  async createIssueComment(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<boolean> {
    this.access.markBusy('issue-comment', true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      const posted = this.resolveMutation(
        await invoke('issue:comment', projectId, owner, repo, issueNumber, body)
      )
      if (!posted) return false
      return true
    } catch (reason) {
      this.access.setError(errorMessage(reason, 'Comment could not be posted'))
      return false
    } finally {
      this.access.markBusy('issue-comment', false)
    }
  }

  /** Rewrite an already-posted issue comment. */
  async updateIssueComment(
    projectId: string,
    owner: string,
    repo: string,
    commentId: number,
    body: string
  ): Promise<boolean> {
    this.access.markBusy('issue-comment-edit', true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      const saved = this.resolveMutation(
        await invoke('issue:commentEdit', projectId, owner, repo, commentId, body)
      )
      if (!saved) return false
      return true
    } catch (reason) {
      this.access.setError(errorMessage(reason, 'Comment could not be saved'))
      return false
    } finally {
      this.access.markBusy('issue-comment-edit', false)
    }
  }

  /** Permanently delete an issue comment. */
  async deleteIssueComment(
    projectId: string,
    owner: string,
    repo: string,
    commentId: number
  ): Promise<boolean> {
    this.access.markBusy('issue-comment-delete', true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      const result = await invoke('issue:commentDelete', projectId, owner, repo, commentId)
      if (result.status === 'permission_required') {
        this.access.setGitHubPermission(result)
        return false
      }
      return true
    } catch (reason) {
      this.access.setError(errorMessage(reason, 'Comment could not be deleted'))
      return false
    } finally {
      this.access.markBusy('issue-comment-delete', false)
    }
  }

  /** Replace the labels an issue carries, caching the labels the provider stored. */
  async setIssueLabels(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    labels: string[]
  ): Promise<IssueMetadataOutcome<IssueLabel[]>> {
    return this.writeMetadata(
      () => invoke('issue:setLabels', projectId, owner, repo, issueNumber, labels),
      'The labels could not be saved',
      (value) => this.access.patchIssue(owner, repo, issueNumber, { labels: value })
    )
  }

  /** Replace an issue's assignees, caching the accounts the provider stored. */
  async setIssueAssignees(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    logins: string[]
  ): Promise<IssueMetadataOutcome<RepositoryMentionUser[]>> {
    return this.writeMetadata(
      () => invoke('issue:setAssignees', projectId, owner, repo, issueNumber, logins),
      'The assignees could not be saved',
      (value) => this.access.patchIssue(owner, repo, issueNumber, { assignees: value })
    )
  }

  /** Attach a milestone to an issue, or clear it with `null`. */
  async setIssueMilestone(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    milestone: number | null
  ): Promise<IssueMetadataOutcome<IssueMilestone | null>> {
    return this.writeMetadata(
      () => invoke('issue:setMilestone', projectId, owner, repo, issueNumber, milestone),
      'The milestone could not be saved',
      (value) => this.access.patchIssue(owner, repo, issueNumber, { milestone: value })
    )
  }

  /**
   * Add or take back the signed-in account's reaction on the issue or one of its
   * comments.
   *
   * The write answers with the subject's reactions as they now stand, so the
   * cached bundle is corrected from that rather than refetched: a refetch would
   * blank the conversation the reader is looking at for the round trip.
   */
  async setIssueReaction(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    nodeId: string,
    content: PrReactionContent,
    add: boolean
  ): Promise<boolean> {
    const busyKey = prReactionBusyKey(nodeId, content)
    this.access.markBusy(busyKey, true)
    this.access.setError(null)
    this.access.setGitHubPermission(null)
    try {
      const groups = this.resolveMutation(
        await invoke('issue:react', projectId, owner, repo, issueNumber, nodeId, content, add)
      )
      if (groups === null) return false
      this.access.patchBundleReactions(owner, repo, issueNumber, nodeId, groups)
      return true
    } catch (reason) {
      this.access.setError(
        errorMessage(
          reason,
          add ? 'The reaction could not be added' : 'The reaction could not be removed'
        )
      )
      return false
    } finally {
      this.access.markBusy(busyKey, false)
    }
  }

  private async writeMetadata<T>(
    write: () => Promise<GitHubMutationResult<T>>,
    failureFallback: string,
    apply: (value: T) => void
  ): Promise<IssueMetadataOutcome<T>> {
    this.access.markBusy('issue-metadata', true)
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
      this.access.markBusy('issue-metadata', false)
    }
  }
}
