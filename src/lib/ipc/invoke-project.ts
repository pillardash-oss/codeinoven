import type {
  AdoptableWorktreeInfo,
  CreateProjectInput,
  CustomIcon,
  DirectoryPreviewSession,
  EditorId,
  ManagedWorktreeDescriptor,
  Project,
  ProjectFileDropResult,
  ProjectFileEntry,
  ProjectFileInfo,
  ProjectFileTransferMode,
  ProjectTextFile,
  RepositoryPreflightResult,
  ScopeAppearancePatch,
  ScopeBoard,
  ScopeBucket,
  ScopeCollapsePatch,
  ScopeCreateInput,
  ScopeLifecycleAction,
  ScopeLifecyclePreflight,
  ScopeMergeMode,
  ScopeMergeOutcome,
  ScopeMergePreflight,
  ScopeTarget,
  ScopeWorktreeCreateInput,
  ScopeWorktreeDefaults,
  ScopeWorktreeHealth,
  ScopeWorktreeSourceInfo
} from '../types'
import type { Contract } from './contract-helpers'

export const invokeProjectContract = {
  'icon-library:list': {} as Contract<[], CustomIcon[]>,
  'icon-library:add': {} as Contract<[name: string, svg: string], CustomIcon>,
  /** Open the app-owned data directory in the operating system's file manager. */
  'storage:openDataDirectory': {} as Contract<[], boolean>,
  'project:search': {} as Contract<[query: string, limit?: number], Project[]>,
  'scope:get': {} as Contract<[projectId: string], ScopeBoard>,
  'scope:updateLayout': {} as Contract<[projectId: string, orderedIds: string[]], ScopeBoard>,
  'scope:updateAppearance': {} as Contract<
    [projectId: string, bucketId: string, patch: ScopeAppearancePatch],
    ScopeBoard
  >,
  'scope:updateCollapse': {} as Contract<
    [projectId: string, bucketId: string, patch: ScopeCollapsePatch],
    ScopeBoard
  >,
  'scope:create': {} as Contract<
    [projectId: string, input: ScopeCreateInput],
    { board: ScopeBoard; bucket: ScopeBucket }
  >,
  'scope:setArchive': {} as Contract<
    [projectId: string, bucketId: string, archived: boolean],
    ScopeBoard
  >,
  /** Pin or unpin a scope; pinned scopes are exempt from thread eviction. */
  'scope:setPinned': {} as Contract<
    [projectId: string, bucketId: string, pinned: boolean],
    ScopeBoard
  >,
  'scope:delete': {} as Contract<[projectId: string, bucketId: string], ScopeBoard>,
  /** Create an isolated managed worktree and attach it to a scope. */
  'scope:worktree:create': {} as Contract<
    [target: ScopeTarget, input: ScopeWorktreeCreateInput],
    ManagedWorktreeDescriptor
  >,
  /** Inspect the source checkout before creating a worktree. */
  'scope:worktree:sourceInfo': {} as Contract<[projectId: string], ScopeWorktreeSourceInfo>,
  /** Refresh the typed health state of a managed scope. */
  'scope:worktree:health': {} as Contract<[target: ScopeTarget], ScopeWorktreeHealth>,
  /** Repair an unhealthy managed scope according to its health category. */
  'scope:worktree:repair': {} as Contract<[target: ScopeTarget], ScopeWorktreeHealth>,
  /** Preview whether an existing Git worktree checkout can be adopted. */
  'scope:worktree:detectAdopt': {} as Contract<
    [projectId: string, sourcePath: string],
    AdoptableWorktreeInfo
  >,
  /** Adopt an existing raw Git worktree as a managed scope root. */
  'scope:worktree:adopt': {} as Contract<
    [target: ScopeTarget, input: { sourcePath: string; runSetup: boolean }],
    ManagedWorktreeDescriptor
  >,
  /** Compute a state-bound preflight and mint a single-use confirmation token. */
  'scope:worktree:preflight': {} as Contract<
    [action: ScopeLifecycleAction, target: ScopeTarget, options?: { scopeBucketId?: string }],
    ScopeLifecyclePreflight
  >,
  /** Consume a confirmation token to detach a managed worktree (optionally forced). */
  'scope:worktree:confirmDetach': {} as Contract<
    [target: ScopeTarget, confirmationId: string, force: boolean],
    void
  >,
  /** Consume a confirmation token to remove a managed worktree (optionally forced). */
  'scope:worktree:confirmRemove': {} as Contract<
    [target: ScopeTarget, confirmationId: string, force: boolean],
    void
  >,
  /** Consume a separate confirmation token to delete a managed scope's branch. */
  'scope:worktree:confirmDeleteBranch': {} as Contract<
    [target: ScopeTarget, confirmationId: string],
    void
  >,
  /** Fully delete a managed scope: worktree, bucket, and optionally branch. */
  'scope:worktree:confirmDeleteScope': {} as Contract<
    [target: ScopeTarget, confirmationId: string, deleteBranch: boolean],
    void
  >,
  /** Retry a failed/interrupted setup from its failed command. */
  'scope:worktree:retrySetup': {} as Contract<
    [target: ScopeTarget, options: { runSetup: boolean }],
    ManagedWorktreeDescriptor
  >,
  /** Preflight merging a managed scope into another scope and mint a token. */
  'scope:worktree:mergePreflight': {} as Contract<
    [target: ScopeTarget, mergeTarget: ScopeTarget, mode: ScopeMergeMode],
    ScopeMergePreflight
  >,
  /** Consume a merge token to merge a scope and apply its post-merge mode. */
  'scope:worktree:confirmMerge': {} as Contract<
    [target: ScopeTarget, mergeTarget: ScopeTarget, mode: ScopeMergeMode, confirmationId: string],
    ScopeMergeOutcome
  >,
  /** Update project-level managed-worktree defaults. */
  'scope:setWorktreeDefaults': {} as Contract<
    [projectId: string, defaults: ScopeWorktreeDefaults],
    ScopeBoard
  >,
  /**
   * Answer a destructive scope action an agent asked for. Only an `auto_review`
   * turn sends the request; the agent's tool call is waiting on this decision.
   */
  'scope:agentConfirmationRespond': {} as Contract<[requestId: string, approved: boolean], void>,
  'project:create': {} as Contract<[input: CreateProjectInput], Project>,
  /** Resolve an already-registered project by folder path (canonical match), so
   *  an OS hand-off of a folder that is open as a project never adds it twice. */
  'project:findByPath': {} as Contract<[path: string], Project | null>,
  /** Resolve the project that owns an absolute file path (deepest root wins), so
   *  an OS hand-off of a file that already belongs to a project opens in that
   *  project's editor rather than the standalone viewer. */
  'project:findFileOwner': {} as Contract<
    [path: string],
    { projectId: string; relativePath: string } | null
  >,
  /** Drain the paths the OS handed to CodeInOven before the renderer mounted. */
  'openWith:consumePending': {} as Contract<[], import('../types').OpenedPath[]>,
  /** Hand in-app paths (folders/files dropped on the project sidebar) to the
   *  same opener the OS hand-off uses, so both classify and route identically. */
  'openWith:openPaths': {} as Contract<[paths: string[]], void>,
  'project:delete': {} as Contract<[projectId: string, options?: { deleteFolder?: boolean }], void>,
  'project:ensureInbox': {} as Contract<[], Project>,
  'project:get': {} as Contract<[projectId: string], Project | null>,
  'project:getIcon': {} as Contract<[projectId: string], string | null>,
  'project:list': {} as Contract<[], Project[]>,
  'project:openInEditor': {} as Contract<[projectId: string], void>,
  'project:reorder': {} as Contract<[orderedIds: string[]], Project[]>,
  'project:setPinned': {} as Contract<[projectId: string, pinned: boolean], Project>,
  'project:setIcon': {} as Contract<[projectId: string, sourcePath: string], Project>,
  'project:clearIcon': {} as Contract<[projectId: string], Project>,
  'project:update': {} as Contract<
    [projectId: string, input: Partial<CreateProjectInput>],
    Project
  >,
  'projectFiles:list': {} as Contract<
    [projectId: string, relativeDirectory: string, scopeBucketId?: string, threadId?: string],
    ProjectFileEntry[]
  >,
  'projectFiles:search': {} as Contract<
    [
      projectId: string,
      query: string,
      category: 'all' | 'rules',
      scopeBucketId?: string,
      threadId?: string
    ],
    ProjectFileEntry[]
  >,
  'projectFiles:resolveCitationPaths': {} as Contract<
    [projectId: string, candidates: string[], scopeBucketId?: string],
    Record<string, string | null>
  >,
  'projectFiles:resolveExternalCitationPaths': {} as Contract<
    [absolutePaths: string[]],
    Record<string, boolean>
  >,
  'projectFiles:create': {} as Contract<
    [
      projectId: string,
      relativeDirectory: string,
      name: string,
      scopeBucketId?: string,
      threadId?: string
    ],
    ProjectFileEntry
  >,
  'projectFiles:createDirectory': {} as Contract<
    [
      projectId: string,
      relativeDirectory: string,
      name: string,
      scopeBucketId?: string,
      threadId?: string
    ],
    ProjectFileEntry
  >,
  'projectFiles:delete': {} as Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string, threadId?: string],
    void
  >,
  'projectFiles:info': {} as Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string, threadId?: string],
    ProjectFileInfo
  >,
  /** Serve one project directory (or the directory holding one HTML file) on a
   *  loopback origin and return the URL to open in the in-app browser. */
  'directoryPreview:open': {} as Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string, threadId?: string],
    DirectoryPreviewSession
  >,
  'projectFiles:openInEditor': {} as Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string, threadId?: string],
    void
  >,
  'projectFiles:openInEditorWith': {} as Contract<
    [
      projectId: string,
      relativePath: string,
      editorId: EditorId,
      scopeBucketId?: string,
      threadId?: string
    ],
    void
  >,
  'projectFiles:saveAs': {} as Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string, threadId?: string],
    string | null
  >,
  'projectFiles:paste': {} as Contract<
    [
      sourceProjectId: string,
      sourcePath: string,
      destinationProjectId: string,
      destinationDirectory: string,
      mode: ProjectFileTransferMode,
      sourceScopeBucketId?: string,
      destinationScopeBucketId?: string,
      sourceThreadId?: string,
      destinationThreadId?: string
    ],
    ProjectFileEntry
  >,
  'projectFiles:importPaths': {} as Contract<
    [
      projectId: string,
      sourcePaths: string[],
      destinationDirectory: string,
      scopeBucketId?: string,
      threadId?: string
    ],
    ProjectFileEntry[]
  >,
  'projectFiles:dropPaths': {} as Contract<
    [
      projectId: string,
      sourcePaths: string[],
      destinationDirectory: string,
      scopeBucketId?: string,
      threadId?: string
    ],
    ProjectFileDropResult[]
  >,
  'projectFiles:read': {} as Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string, threadId?: string],
    /** null when the file cannot be read as text (binary, too large, missing). */
    ProjectTextFile | null
  >,
  'projectFiles:rename': {} as Contract<
    [
      projectId: string,
      relativePath: string,
      name: string,
      scopeBucketId?: string,
      threadId?: string
    ],
    ProjectFileEntry
  >,
  'projectFiles:save': {} as Contract<
    [
      projectId: string,
      relativePath: string,
      content: string,
      expectedRevision: string,
      scopeBucketId?: string,
      threadId?: string
    ],
    ProjectTextFile
  >,
  'projectActions:list': {} as Contract<
    [projectId: string],
    import('../project-actions').ProjectAction[]
  >,
  'projectActions:save': {} as Contract<
    [
      projectId: string,
      actionId: string | null,
      input: import('../project-actions').ProjectActionInput,
      insertAfterId?: string | null
    ],
    import('../project-actions').ProjectAction
  >,
  'projectActions:delete': {} as Contract<[projectId: string, actionId: string], boolean>,
  'projectActions:reorder': {} as Contract<
    [projectId: string, orderedIds: string[]],
    import('../project-actions').ProjectAction[]
  >,
  'repository:init': {} as Contract<[projectPath: string], RepositoryPreflightResult>,
  'repository:preflight': {} as Contract<[projectPath: string], RepositoryPreflightResult>,
  'repository:remoteOrigin': {} as Contract<[projectPath: string], string | null>
}
