import type {
  GitBranchInfo,
  GitCommitInfo,
  GitConflictAnalysis,
  GitConflictSide,
  GitConflictWorkFile,
  GitCredentialStatus,
  GitDiff,
  GitFileChange,
  GitHubAuthStatus,
  GitHubAvatarRequest,
  GitHubDeploymentDetail,
  GitHubDeploymentJobLog,
  GitHubDeploymentOverviewResult,
  GitHubDeviceCode,
  GitHubMutationResult,
  GitHubPollResult,
  GitHubWorkflowRunDetail,
  GitIdentity,
  GitIdentityInput,
  GitInvocation,
  GitRebaseAction,
  GitRemoteInfo,
  GitRemoteUpdate,
  GitStashEntry,
  GitStatus,
  GitSyncDirection,
  GitSyncPeer,
  GitSyncPeerOption,
  GitSyncResult,
  MergeSummary,
  PrCommentKind,
  PrCreateInput,
  PrListRequest,
  PrMergeMethod,
  PrAgentAssignmentInput,
  PrAgentAssignmentSummary,
  PrAgentAssignmentWorkspace,
  PrAgentReport,
  PrMinimizeReason,
  PrResolveOptions,
  PrReviewEvent,
  PrState,
  PullRequestBundle,
  PullRequestComment,
  PullRequestCompare,
  PullRequestDetail,
  PullRequestFile,
  PullRequestLabel,
  PullRequestMilestone,
  PullRequestPage,
  PullRequestReference,
  PullRequestReviewComment,
  PrReactionContent,
  PrReactionGroup,
  PullRequestReviewResult,
  RepositoryMentionUser,
  ThreadSettings,
  WorkflowRerunMode,
  WorkflowRerunResult
} from '../types'
import type { Contract } from './contract-helpers'

export const invokeGitContract = {
  'git:defaultClonePath': {} as Contract<[url: string], string>,
  'git:cloneHandoff': {} as Contract<
    [input: { url: string; destination?: string }],
    { command: string; args: string[]; destination: string; repoName: string }
  >,
  'git:status': {} as Contract<[projectId: string, scopeBucketId?: string], GitStatus>,
  'git:diff': {} as Contract<
    [projectId: string, relativePath: string, staged: boolean, scopeBucketId?: string],
    GitDiff
  >,
  'git:analyzeConflict': {} as Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string],
    GitConflictAnalysis
  >,
  'git:prepareConflictWorkFile': {} as Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string],
    GitConflictWorkFile
  >,
  'git:saveConflictDraft': {} as Contract<
    [
      projectId: string,
      relativePath: string,
      content: string,
      stateJson: string,
      scopeBucketId?: string
    ],
    void
  >,
  'git:saveConflictResolution': {} as Contract<
    [projectId: string, relativePath: string, content: string, scopeBucketId?: string],
    GitStatus
  >,
  'git:stage': {} as Contract<
    [projectId: string, paths: string[], scopeBucketId?: string],
    GitStatus
  >,
  'git:resolveConflicted': {} as Contract<
    [projectId: string, path: string, scopeBucketId?: string],
    GitStatus
  >,
  /** Take one side of every unresolved conflict wholesale, then stage it. */
  'git:acceptConflictSide': {} as Contract<
    [projectId: string, side: GitConflictSide, scopeBucketId?: string],
    GitStatus
  >,
  'git:unstage': {} as Contract<
    [projectId: string, paths: string[], scopeBucketId?: string],
    GitStatus
  >,
  'git:restoreFiles': {} as Contract<
    [
      projectId: string,
      source: string,
      paths: string[],
      target: import('../types').GitRestoreTarget,
      scopeBucketId?: string
    ],
    GitStatus
  >,
  'git:commit': {} as Contract<
    [projectId: string, message: string, scopeBucketId?: string],
    GitStatus
  >,
  'git:init': {} as Contract<[projectId: string, scopeBucketId?: string], GitStatus>,
  'git:branches': {} as Contract<[projectId: string, scopeBucketId?: string], GitBranchInfo[]>,
  'git:defaultBranch': {} as Contract<[projectId: string, scopeBucketId?: string], string | null>,
  'git:checkout': {} as Contract<
    [projectId: string, branch: string, scopeBucketId?: string],
    GitInvocation<GitStatus>
  >,
  'git:createBranch': {} as Contract<
    [projectId: string, name: string, scopeBucketId?: string],
    GitInvocation<GitStatus>
  >,
  'git:createTrackingBranch': {} as Contract<
    [projectId: string, remote: string, branch: string, localName: string, scopeBucketId?: string],
    GitInvocation<GitStatus>
  >,
  'git:deleteBranch': {} as Contract<
    [projectId: string, name: string, force?: boolean, scopeBucketId?: string],
    GitInvocation<GitStatus>
  >,
  'git:deleteRemoteBranch': {} as Contract<
    [projectId: string, remote: string, name: string, scopeBucketId?: string],
    GitStatus
  >,
  'git:log': {} as Contract<
    [projectId: string, limit?: number, offset?: number, query?: string, scopeBucketId?: string],
    GitCommitInfo[]
  >,
  'git:remoteUpdates': {} as Contract<
    [projectId: string, scopeBucketId?: string],
    GitRemoteUpdate[]
  >,
  'git:commitDiff': {} as Contract<
    [projectId: string, hash: string, scopeBucketId?: string],
    GitFileChange[]
  >,
  'git:commitFileDiff': {} as Contract<
    [projectId: string, hash: string, path: string, scopeBucketId?: string],
    GitDiff
  >,
  'git:amend': {} as Contract<
    [projectId: string, message: string, scopeBucketId?: string],
    GitStatus
  >,
  'git:removeCommitChanges': {} as Contract<
    [projectId: string, hash: string, paths: string[], scopeBucketId?: string],
    GitStatus
  >,
  'git:reset': {} as Contract<
    [
      projectId: string,
      mode: import('../types').GitResetMode,
      target?: string,
      scopeBucketId?: string
    ],
    GitStatus
  >,
  'git:deleteCommit': {} as Contract<
    [projectId: string, target: string, scopeBucketId?: string],
    GitInvocation<GitStatus>
  >,
  'git:getIdentity': {} as Contract<[projectId: string, scopeBucketId?: string], GitIdentity>,
  'git:setIdentity': {} as Contract<
    [projectId: string, identity: GitIdentityInput, scopeBucketId?: string],
    GitIdentity
  >,
  'git:remotes': {} as Contract<[projectId: string, scopeBucketId?: string], GitRemoteInfo[]>,
  'git:addRemote': {} as Contract<
    [projectId: string, name: string, url: string, scopeBucketId?: string],
    GitRemoteInfo[]
  >,
  'git:setRemoteUrl': {} as Contract<
    [projectId: string, name: string, url: string, scopeBucketId?: string],
    GitRemoteInfo[]
  >,
  'git:removeRemote': {} as Contract<
    [projectId: string, name: string, scopeBucketId?: string],
    GitRemoteInfo[]
  >,
  'git:fetch': {} as Contract<[projectId: string, scopeBucketId?: string], GitStatus>,
  'git:fetchBranch': {} as Contract<
    [projectId: string, remote: string, branch: string, scopeBucketId?: string],
    GitStatus
  >,
  'git:pull': {} as Contract<[projectId: string, scopeBucketId?: string], GitInvocation<GitStatus>>,
  'git:pullIntegrate': {} as Contract<
    [
      projectId: string,
      options: {
        remote?: string
        branch?: string
        strategy: import('../types').GitPullStrategy
      },
      scopeBucketId?: string
    ],
    GitInvocation<GitStatus>
  >,
  /** Integrate another checkout or branch into a checkout, or fold a checkout's commits into one. */
  'git:syncWith': {} as Contract<
    [
      projectId: string,
      options: {
        direction: GitSyncDirection
        strategy: import('../types').GitPullStrategy
        peer: GitSyncPeer
      },
      scopeBucketId?: string
    ],
    GitInvocation<GitSyncResult>
  >,
  /** Every checkout and branch this project can sync with, as main names them. */
  'git:syncPeers': {} as Contract<[projectId: string, scopeBucketId?: string], GitSyncPeerOption[]>,
  'git:push': {} as Contract<
    [
      projectId: string,
      options: { setUpstream: boolean; remote?: string; branch?: string },
      scopeBucketId?: string
    ],
    GitInvocation<GitStatus>
  >,
  'git:getCredentialStatus': {} as Contract<[projectId: string], GitCredentialStatus>,
  'git:setCredential': {} as Contract<[projectId: string, token: string], GitCredentialStatus>,
  'git:removeCredential': {} as Contract<[projectId: string], GitCredentialStatus>,
  'git:merge': {} as Contract<
    [projectId: string, target: string, scopeBucketId?: string],
    GitInvocation<MergeSummary>
  >,
  'git:rebase': {} as Contract<
    [projectId: string, target: string, scopeBucketId?: string],
    GitInvocation<MergeSummary>
  >,
  'git:preparePrResolve': {} as Contract<
    [projectId: string, options: PrResolveOptions, scopeBucketId?: string],
    GitStatus
  >,
  'git:finishPrResolve': {} as Contract<
    [projectId: string, options: PrResolveOptions, scopeBucketId?: string],
    GitStatus
  >,
  'git:stash': {} as Contract<
    [projectId: string, message?: string, paths?: string[], scopeBucketId?: string],
    GitStatus
  >,
  'git:ignore': {} as Contract<
    [projectId: string, paths: string[], scopeBucketId?: string],
    GitStatus
  >,
  'git:discard': {} as Contract<
    [projectId: string, paths: string[], scopeBucketId?: string],
    GitStatus
  >,
  'git:stashList': {} as Contract<[projectId: string, scopeBucketId?: string], GitStashEntry[]>,
  'git:stashPop': {} as Contract<
    [projectId: string, id?: string, scopeBucketId?: string],
    GitInvocation<GitStatus>
  >,
  'git:stashDrop': {} as Contract<
    [projectId: string, id?: string, scopeBucketId?: string],
    GitStatus
  >,
  'git:stashDiff': {} as Contract<
    [projectId: string, id: string, scopeBucketId?: string],
    GitFileChange[]
  >,
  'git:stashFileDiff': {} as Contract<
    [projectId: string, id: string, path: string, scopeBucketId?: string],
    GitDiff
  >,
  'git:abortMerge': {} as Contract<[projectId: string, scopeBucketId?: string], GitStatus>,
  'git:abortRebase': {} as Contract<[projectId: string, scopeBucketId?: string], GitStatus>,
  /** Continue a stopped rebase, or drop the commit it stopped on. */
  'git:rebaseAction': {} as Contract<
    [projectId: string, action: GitRebaseAction, scopeBucketId?: string],
    GitInvocation<GitStatus>
  >,
  'pr:create': {} as Contract<
    [projectId: string, input: PrCreateInput, scopeBucketId?: string],
    GitHubMutationResult<PullRequestReference>
  >,
  'pr:list': {} as Contract<
    [projectId: string, owner: string, repo: string, state?: string],
    PullRequestReference[]
  >,
  'pr:merge': {} as Contract<
    [
      projectId: string,
      owner: string,
      repo: string,
      pullNumber: number,
      method: PrMergeMethod,
      commitTitle?: string,
      commitMessage?: string
    ],
    GitHubMutationResult<PullRequestReference>
  >,
  'pr:ready': {} as Contract<
    [projectId: string, owner: string, repo: string, pullNumber: number],
    GitHubMutationResult<PullRequestReference>
  >,
  'pr:compare': {} as Contract<
    [
      projectId: string,
      owner: string,
      repo: string,
      base: string,
      head: string,
      scopeBucketId?: string
    ],
    PullRequestCompare
  >,
  'pr:reopen': {} as Contract<
    [projectId: string, owner: string, repo: string, pullNumber: number],
    GitHubMutationResult<PullRequestReference>
  >,
  'pr:close': {} as Contract<
    [projectId: string, owner: string, repo: string, pullNumber: number],
    GitHubMutationResult<PullRequestReference>
  >,
  /**
   * Replace the labels a pull request carries, returning the labels it now has.
   * One write for the whole set rather than an add or a remove per label, so a
   * picker that toggles several chips costs one round trip and its result is the
   * server's own answer instead of a locally reconstructed guess.
   */
  'pr:setLabels': {} as Contract<
    [projectId: string, owner: string, repo: string, pullNumber: number, labels: string[]],
    GitHubMutationResult<PullRequestLabel[]>
  >,
  /** Replace a pull request's assignees, returning the accounts it now has. */
  'pr:setAssignees': {} as Contract<
    [projectId: string, owner: string, repo: string, pullNumber: number, logins: string[]],
    GitHubMutationResult<RepositoryMentionUser[]>
  >,
  /**
   * Attach or clear a pull request's milestone.
   *
   * `null` clears it, because a milestone is an issue field on GitHub and the
   * issues endpoint reads an explicit null as "detach".
   */
  'pr:setMilestone': {} as Contract<
    [projectId: string, owner: string, repo: string, pullNumber: number, milestone: number | null],
    GitHubMutationResult<PullRequestMilestone | null>
  >,
  /** The repository's own label catalog, for the label picker. */
  'pr:labels': {} as Contract<[projectId: string, owner: string, repo: string], PullRequestLabel[]>,
  /** The repository's open milestones, for the milestone picker. */
  'pr:milestones': {} as Contract<
    [projectId: string, owner: string, repo: string],
    PullRequestMilestone[]
  >,
  'pr:update': {} as Contract<
    [
      projectId: string,
      owner: string,
      repo: string,
      pullNumber: number,
      title: string | undefined,
      body: string | undefined
    ],
    GitHubMutationResult<PullRequestReference>
  >,
  'pr:page': {} as Contract<
    [
      projectId: string,
      owner: string,
      repo: string,
      state: PrState,
      page: number,
      /** Which relationship to keep, how to order, and where to continue from. */
      request: PrListRequest
    ],
    PullRequestPage
  >,
  /**
   * Read one pull request's detail. Hitting the detail endpoint forces GitHub
   * to compute mergeability, so it is used as the authoritative mergeability
   * probe when a list payload reported `mergeable`/`mergeable_state` as null.
   */
  'pr:detail': {} as Contract<
    [projectId: string, owner: string, repo: string, pullNumber: number],
    /** null when the provider request fails (timeout, rate limit, network). */
    PullRequestDetail | null
  >,
  'deployment:overview': {} as Contract<
    [projectId: string, owner: string, repo: string],
    GitHubDeploymentOverviewResult
  >,
  'deployment:detail': {} as Contract<
    [projectId: string, owner: string, repo: string, deploymentId: number],
    GitHubDeploymentDetail
  >,
  'deployment:runDetail': {} as Contract<
    [projectId: string, owner: string, repo: string, runId: number],
    GitHubWorkflowRunDetail
  >,
  'deployment:jobLog': {} as Contract<
    [projectId: string, owner: string, repo: string, jobId: number],
    GitHubDeploymentJobLog
  >,
  /**
   * Replay a workflow run's jobs (all, or only the failed ones). Returns the
   * mutation envelope so a read-only grant surfaces its permission prompt
   * instead of a bare failure.
   */
  'deployment:rerunRun': {} as Contract<
    [projectId: string, owner: string, repo: string, runId: number, mode: WorkflowRerunMode],
    WorkflowRerunResult
  >,
  /**
   * Read a project's cloud deployment config, or null when none exists. The
   * config is persisted by main under the CodeInOven config directory; the
   * renderer never touches the filesystem or Node APIs for it.
   */
  'cloudDeploy:getConfig': {} as Contract<
    [projectId: string],
    import('../types').CloudDeploymentConfig | null
  >,
  /**
   * Persist a project's cloud deployment config (selected providers + labelled
   * containers with credential references) and refresh the project's
   * has-deployments flag for panel visibility. Returns the stored config.
   */
  'cloudDeploy:saveConfig': {} as Contract<
    [projectId: string, config: import('../types').CloudDeploymentConfig],
    import('../types').CloudDeploymentConfig
  >,
  /** Remove a project's cloud deployment config and clear its has-deployments flag. */
  'cloudDeploy:clearConfig': {} as Contract<[projectId: string], void>,
  /** Update a container's label/id in a project's config. Returns the stored config. */
  'cloudDeploy:updateContainer': {} as Contract<
    [
      projectId: string,
      providerKind: import('../types').CloudDeploymentProviderKind,
      containerId: string,
      patch: { label?: string; id?: string }
    ],
    import('../types').CloudDeploymentConfig
  >,
  /** Remove a container from a project's config. Returns the stored config. */
  'cloudDeploy:removeContainer': {} as Contract<
    [
      projectId: string,
      providerKind: import('../types').CloudDeploymentProviderKind,
      containerId: string
    ],
    import('../types').CloudDeploymentConfig
  >,
  /** List every provider account in the global registry. */
  'cloudDeploy:listAccounts': {} as Contract<[], import('../types').CloudDeploymentAccountRegistry>,
  /**
   * Create a new provider account in the GLOBAL registry and vault its token by
   * account id. The account is reusable across every project that attaches it.
   * The plaintext token is vaulted by main via `safeStorage` and never crosses
   * back to the renderer. Returns the sanitized account (no secret).
   */
  'cloudDeploy:createAccount': {} as Contract<
    [
      providerKind: import('../types').CloudDeploymentProviderKind,
      accountLabel: string,
      token: string,
      baseUrl?: string
    ],
    import('../types').CloudDeploymentProviderAccount
  >,
  /** Update a global provider account's metadata (label, base URL, enabled). */
  'cloudDeploy:updateAccount': {} as Contract<
    [
      accountId: string,
      patch: {
        label?: string
        baseUrl?: string
        enabled?: boolean
      }
    ],
    import('../types').CloudDeploymentProviderAccount
  >,
  /**
   * Rotate a global provider account's secret. Update-only: the token is vaulted
   * and the current secret is never returned to the renderer. Returns the
   * sanitized account (secretRef cleared).
   */
  'cloudDeploy:rotateAccountSecret': {} as Contract<
    [accountId: string, token: string],
    import('../types').CloudDeploymentProviderAccount
  >,
  /** Remove a global provider account and its vaulted token. */
  'cloudDeploy:removeAccount': {} as Contract<[accountId: string], void>,
  /** Attach a global provider account to a project for a provider kind. */
  'cloudDeploy:attachAccount': {} as Contract<
    [
      projectId: string,
      providerKind: import('../types').CloudDeploymentProviderKind,
      accountId: string
    ],
    import('../types').CloudDeploymentConfig
  >,
  /** Detach a global provider account from a project for a provider kind. */
  'cloudDeploy:detachAccount': {} as Contract<
    [
      projectId: string,
      providerKind: import('../types').CloudDeploymentProviderKind,
      accountId: string
    ],
    import('../types').CloudDeploymentConfig
  >,
  /** Set which attached account is active for a provider within a project. */
  'cloudDeploy:setActiveAccount': {} as Contract<
    [
      projectId: string,
      providerKind: import('../types').CloudDeploymentProviderKind,
      accountId: string
    ],
    import('../types').CloudDeploymentConfig
  >,
  /**
   * Fetch a provider-agnostic snapshot of a configured provider's containers.
   * The adapter is resolved by kind via the registry; `hasDeployments` drives
   * whether the Cloud Deployments panel is shown at all. Provider/credential
   * failures are returned as `accessError` rather than rejecting IPC.
   */
  'cloudDeploy:overview': {} as Contract<
    [projectId: string, providerKind: import('../types').CloudDeploymentProviderKind],
    import('../types').CloudDeploymentResult
  >,
  /**
   * List every container the account can see on the provider (not filtered to
   * this project's mappings), so the add-container flow can offer a picker.
   * Provider/credential failures are returned as `{ accessError }`.
   */
  'cloudDeploy:availableContainers': {} as Contract<
    [
      projectId: string,
      providerKind: import('../types').CloudDeploymentProviderKind,
      /** Browse a specific attached account's containers instead of the
       *  project's active one (multi-account same-kind support). */
      accountId?: string
    ],
    import('../types').CloudDeploymentContainer[] | { accessError: string }
  >,
  /**
   * Latest snapshot for one configured container, or null when the provider
   * cannot resolve it.
   */
  'cloudDeploy:containerStatus': {} as Contract<
    [
      projectId: string,
      providerKind: import('../types').CloudDeploymentProviderKind,
      containerId: string,
      /** Resolve through the container's bound account when present. */
      accountId?: string
    ],
    import('../types').CloudDeploymentContainer | null
  >,
  /**
   * List the most recent deployments/builds for a container, newest first
   * (bounded to a UI window such as the last ten).
   */
  'cloudDeploy:deployments': {} as Contract<
    [
      projectId: string,
      providerKind: import('../types').CloudDeploymentProviderKind,
      containerId: string,
      /** Resolve through the container's bound account when present. */
      accountId?: string
    ],
    import('../types').CloudDeploymentDeployment[]
  >,
  /** Capped raw log text for a container's latest deployment. */
  'cloudDeploy:containerLog': {} as Contract<
    [
      projectId: string,
      providerKind: import('../types').CloudDeploymentProviderKind,
      containerId: string,
      deploymentId?: string,
      /** Resolve through the container's bound account when present. */
      accountId?: string
    ],
    { containerId: string; deploymentId: string | null; log: string }
  >,
  /** Everything the PR detail view needs, fetched in parallel in one round trip. */
  'pr:bundle': {} as Contract<
    [projectId: string, owner: string, repo: string, pullNumber: number],
    PullRequestBundle
  >,
  'pr:commitFiles': {} as Contract<
    [projectId: string, owner: string, repo: string, sha: string],
    PullRequestFile[]
  >,
  /** Assignable repository accounts, for @-mention autocomplete in PR conversations. */
  'pr:mentionUsers': {} as Contract<
    [projectId: string, owner: string, repo: string],
    RepositoryMentionUser[]
  >,
  /** Every agent assignment report a pull request holds, newest first. */
  'pr:agentReports': {} as Contract<[projectId: string, pullNumber: number], PrAgentReport[]>,
  /**
   * Assignment summaries for the rows a listing is about to draw. Batched on
   * purpose: a page of twenty rows must not be twenty round trips.
   */
  'pr:agentAssignments': {} as Contract<
    [projectId: string, numbers: number[]],
    Record<string, PrAgentAssignmentSummary>
  >,
  /** Open a new agent assignment on a pull request and return its report path. */
  'pr:createAgentAssignment': {} as Contract<
    [projectId: string, pullNumber: number, threadId: string, input: PrAgentAssignmentInput],
    PrAgentAssignmentWorkspace
  >,
  'pr:comment': {} as Contract<
    [projectId: string, owner: string, repo: string, pullNumber: number, body: string],
    GitHubMutationResult<PullRequestComment>
  >,
  /**
   * Rewrite a comment you authored. `kind` picks the collection: GitHub files
   * conversation comments and inline diff comments in two unrelated endpoints
   * with independent id sequences.
   */
  'pr:commentEdit': {} as Contract<
    [
      projectId: string,
      owner: string,
      repo: string,
      pullNumber: number,
      kind: PrCommentKind,
      commentId: number,
      body: string
    ],
    GitHubMutationResult<boolean>
  >,
  /** Permanently delete a comment you authored. */
  'pr:commentDelete': {} as Contract<
    [
      projectId: string,
      owner: string,
      repo: string,
      pullNumber: number,
      kind: PrCommentKind,
      commentId: number
    ],
    GitHubMutationResult<boolean>
  >,
  /**
   * Answer an inline review comment, keeping the answer in that comment's thread.
   * Only inline comments thread on GitHub, so this carries no `kind`.
   */
  'pr:commentReply': {} as Contract<
    [
      projectId: string,
      owner: string,
      repo: string,
      pullNumber: number,
      commentId: number,
      body: string
    ],
    GitHubMutationResult<PullRequestReviewComment>
  >,
  /** Hide a comment behind GitHub's minimised treatment, by GraphQL node id. */
  'pr:commentMinimize': {} as Contract<
    [
      projectId: string,
      owner: string,
      repo: string,
      pullNumber: number,
      nodeId: string,
      reason: PrMinimizeReason
    ],
    GitHubMutationResult<boolean>
  >,
  /**
   * Settle or reopen one inline thread. GitHub keeps resolution on the thread
   * rather than on its comments, and only GraphQL can read or write it, so the
   * caller passes the thread's node id.
   */
  'pr:threadResolve': {} as Contract<
    [
      projectId: string,
      owner: string,
      repo: string,
      pullNumber: number,
      threadNodeId: string,
      resolved: boolean
    ],
    GitHubMutationResult<boolean>
  >,
  /**
   * Add or take back the signed-in account's reaction on one comment.
   *
   * Addressed by the subject's GraphQL node id because that is the one handle
   * every reactable thing shares: the description, an issue comment, a review
   * and an inline comment are four different REST shapes and one `Reactable`.
   * The answer is the subject's reactions as the server now holds them, so the
   * caller corrects what it is showing without refetching the conversation.
   */
  'pr:react': {} as Contract<
    [
      projectId: string,
      owner: string,
      repo: string,
      pullNumber: number,
      subjectNodeId: string,
      content: PrReactionContent,
      /** True to react, false to take the reaction back. */
      add: boolean
    ],
    GitHubMutationResult<PrReactionGroup[]>
  >,
  'pr:review': {} as Contract<
    [
      projectId: string,
      owner: string,
      repo: string,
      pullNumber: number,
      event: PrReviewEvent,
      body: string
    ],
    PullRequestReviewResult
  >,
  /**
   * Run the PR-compose agent virtually and consume its temporary report.
   *
   * Resolves to a `failed` outcome rather than rejecting when the agent cannot
   * run: a harness that is missing, unauthenticated, rate-limited or unable to
   * start is an expected result of the user's own choice, and its cause has to
   * reach the sheet as data so it can offer the way out.
   */
  'pr:composeWithAgent': {} as Contract<
    [
      projectId: string,
      scopeBucketId: string,
      virtualTaskId: string,
      settings: ThreadSettings,
      input: import('../types').PrComposeInput
    ],
    import('../types').PrComposeOutcome
  >,
  'github:authStatus': {} as Contract<[], GitHubAuthStatus>,
  'github:startDeviceFlow': {} as Contract<[], GitHubDeviceCode>,
  'github:poll': {} as Contract<[deviceCode: string], GitHubPollResult>,
  'github:logout': {} as Contract<[], GitHubAuthStatus>,
  /**
   * Resolve account avatars, as `data:` URLs (the renderer's CSP blocks remote
   * image hosts). Each account carries the URL its provider declared, which wins
   * over the login-derived guess: a bot account's login alone resolves to
   * GitHub's generated identicon rather than the app's real picture. A login
   * GitHub has no picture for comes back as null, which the UI draws as its
   * monogram.
   */
  'github:avatars': {} as Contract<
    [accounts: GitHubAvatarRequest[]],
    Record<string, string | null>
  >,
  /**
   * Resolve images embedded in provider-authored markdown, as `data:` URLs, for
   * the same CSP reason. Only `https:` is accepted, and main additionally refuses
   * literal private hosts because it is the side that opens the connection.
   */
  'github:image': {} as Contract<[urls: string[]], Record<string, string | null>>
}
