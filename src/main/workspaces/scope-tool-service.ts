import { randomUUID } from 'crypto'
import { DEFAULT_SCOPE_BUCKET_ID } from '../../lib/types'
import type {
  GitMainSyncDirection,
  GitMainSyncResult,
  GitPullStrategy,
  GitStatus,
  PermissionLevel,
  ScopeAgentConfirmationRequest,
  ScopeBoard,
  ScopeBoardChangedEvent,
  ScopeBucket,
  ScopeEnvironmentMode,
  ScopeLifecycleSnapshot,
  ScopeMergeMode,
  ScopeSetupCommandSpec,
  ScopeTarget,
  ScopeToolAction,
  ScopeWorktreeHealth,
  ScopeWorktreeProgress,
  ScopeWorktreeProgressEvent
} from '../../lib/types'
import { SCOPE_TOOL_ACTIONS, SCOPE_TOOL_DESTRUCTIVE_ACTIONS } from '../../lib/types'
import { APP_SCOPE_UTILITY_ID } from '../../lib/utility-ids'
import { getScopeRootPath } from '../../lib/utils'
import { ScopeManager } from '../../lib/engines/scope-manager'
import { ProjectManager } from '../../lib/engines/project-manager'
import type { ScopeThreadLifecycle, ScopeWorktreeService } from '../git/scope-worktree-service'

/**
 * One agent turn's identity, as far as scope work is concerned. The gateway
 * supplies it so the tool never has to guess which project, thread or scope an
 * agent is acting from.
 */
export interface ScopeToolContext {
  projectId: string
  /** Scope the calling thread currently works in; the default target for `scope`. */
  scopeBucketId: string
  threadId: string
  threadTitle: string
  permissionLevel: PermissionLevel
}

/** Git operations the tool needs, supplied by the shared Git service. */
export interface ScopeToolGit {
  getStatus(projectPath: string): Promise<GitStatus>
  syncMain(
    projectPath: string,
    options: {
      direction: GitMainSyncDirection
      mainPath: string
      strategy: GitPullStrategy
      token?: string
    }
  ): Promise<GitMainSyncResult>
}

export interface ScopeToolServiceOptions {
  /** Scope-owned threads: counts, and the disposition a delete needs. */
  scopeThreads?: ScopeThreadLifecycle
  /**
   * Ask the user to confirm a destructive `auto_review` action. Resolves false
   * when nobody answers before the request expires, so silence never destroys
   * anything.
   */
  requestConfirmation?: (request: ScopeAgentConfirmationRequest) => Promise<boolean>
  /** Broadcast a live board invalidation after an agent mutates scope state. */
  onBoardChanged?: (event: ScopeBoardChangedEvent) => void
  /** Stream a worktree job's stages, tagged as agent-originated. */
  onProgress?: (event: ScopeWorktreeProgressEvent) => void
  /** Vaulted project credential, used to refresh main before a `from-main` sync. */
  resolveGitToken?: (projectId: string) => Promise<string | undefined>
  /** Configured pull strategy; `ask` is already resolved to a concrete one. */
  defaultPullStrategy?: () => Promise<GitPullStrategy>
  /** How long an unanswered `auto_review` confirmation waits before denying. */
  confirmationTimeoutMs?: number
}

/** Confirmation wait when the options do not name one: long enough to answer. */
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000

const MAX_TITLE_LENGTH = 120
const MAX_NAME_LENGTH = 80
const MAX_PATH_LENGTH = 4096
const MAX_REFERENCE_LENGTH = 200

const STRATEGIES: readonly GitPullStrategy[] = ['merge', 'rebase', 'ff-only']
const MERGE_MODES: readonly ScopeMergeMode[] = [
  'merge-keep',
  'merge-delete',
  'merge-move-to-default'
]
const ENVIRONMENT_MODES: readonly ScopeEnvironmentMode[] = ['copy', 'symlink']
const THREAD_DISPOSITIONS = ['move-to-default', 'delete'] as const

/** Every field the scope capability accepts; anything else is rejected, never ignored. */
const SCOPE_TOOL_INPUT_KEYS: ReadonlySet<string> = new Set([
  'action',
  'scope',
  'title',
  'name',
  'baseBranch',
  'runSetup',
  'environmentMode',
  'setupCommands',
  'attachThread',
  'sourcePath',
  'strategy',
  'mode',
  'target',
  'deleteBranch',
  'threads',
  'confirm'
])

const DESTRUCTIVE_ACTIONS: ReadonlySet<string> = new Set(SCOPE_TOOL_DESTRUCTIVE_ACTIONS)

type ThreadDisposition = (typeof THREAD_DISPOSITIONS)[number]

/** One scope as the tool reports it: enough to choose a target for the next call. */
interface ScopeSummary {
  id: string
  name: string
  kind: 'project' | 'worktree'
  /** Working root of the scope (project directory or managed worktree checkout). */
  path: string
  branch?: string
  baseBranch?: string
  directoryName?: string
  setupState?: string
  health?: ScopeWorktreeHealth
  threadCount: number
  archived: boolean
  pinned: boolean
  /** True for the scope the calling thread is in. */
  active: boolean
}

/** Parsed scope capability input. Every field is validated before it is used. */
interface ScopeToolCall {
  action: ScopeToolAction
  scope?: string
  title?: string
  name?: string
  baseBranch?: string
  runSetup?: boolean
  environmentMode?: ScopeEnvironmentMode
  setupCommands?: ScopeSetupCommandSpec[]
  attachThread?: boolean
  sourcePath?: string
  strategy?: GitPullStrategy
  mode?: ScopeMergeMode
  target?: string
  deleteBranch?: boolean
  threads?: ThreadDisposition
  confirm?: boolean
}

/**
 * Agents manage CodeInOven scopes and their managed Git worktrees through this
 * service, never through raw `git worktree`. Every action delegates to the same
 * `ScopeWorktreeService` and `ScopeManager` the scope board uses, so an
 * agent-created worktree is identity-, health-, sync- and lifecycle-complete on
 * the board the moment it exists.
 */
export class ScopeToolService {
  constructor(
    private readonly worktrees: ScopeWorktreeService,
    private readonly scopes: ScopeManager,
    private readonly projects: ProjectManager,
    private readonly git: ScopeToolGit,
    private readonly options: ScopeToolServiceOptions = {}
  ) {}

  /**
   * Run one gateway invocation of the scope capability for a turn. Reads are
   * free; writes mutate app-owned scope state; destructive actions pass through
   * the confirmation contract before anything is removed.
   */
  async execute(input: Record<string, unknown>, context: ScopeToolContext): Promise<unknown> {
    const call = parseScopeToolInput(input)
    const project = await this.projects.getProject(context.projectId)
    if (!project) throw new Error('The calling thread’s project no longer exists')
    if (project.source !== 'local' || !project.path) {
      throw new Error(
        'Scopes and managed worktrees need a local project repository; this project is remote.'
      )
    }
    const projectPath = project.path

    switch (call.action) {
      case 'list':
        return { scopes: await this.listScopes(context, projectPath) }
      case 'status':
        return await this.describeScope(
          context,
          projectPath,
          this.resolveScope(call.scope, context)
        )
      case 'conflicts':
        return await this.readConflicts(
          context,
          projectPath,
          this.resolveScope(call.scope, context)
        )
      case 'source_info':
        return await this.worktrees.sourceInfo(context.projectId)
      case 'detect_adoptable': {
        if (!call.sourcePath) throw new TypeError('sourcePath is required for detect_adoptable')
        return await this.worktrees.detectAdoptable(context.projectId, call.sourcePath)
      }
      case 'create':
        return await this.createScope(call, context, projectPath)
      case 'rename': {
        if (!call.name) throw new TypeError('name is required for rename')
        const bucket = this.resolveCustomScope(call.scope, context, 'renamed')
        this.scopes.updateAppearance(context.projectId, bucket.id, { name: call.name })
        return this.afterBoardChange(context, bucket.id, `renamed the scope to “${call.name}”`)
      }
      case 'pin':
      case 'unpin': {
        const pinning = call.action === 'pin'
        const bucket = this.resolveCustomScope(call.scope, context, pinning ? 'pinned' : 'unpinned')
        this.scopes.setPinned(context.projectId, bucket.id, pinning)
        return this.afterBoardChange(
          context,
          bucket.id,
          `${pinning ? 'pinned' : 'unpinned'} the scope ${bucket.name}`
        )
      }
      case 'archive':
      case 'restore': {
        const archiving = call.action === 'archive'
        const bucket = this.resolveCustomScope(
          call.scope,
          context,
          archiving ? 'archived' : 'restored'
        )
        this.scopes.setArchive(context.projectId, bucket.id, archiving)
        return this.afterBoardChange(
          context,
          bucket.id,
          `${archiving ? 'archived' : 'restored'} the scope ${bucket.name}`
        )
      }
      case 'adopt':
        return await this.adoptWorktree(call, context, projectPath)
      case 'repair': {
        const target = this.requireManagedTarget(call.scope, context)
        const health = await this.worktrees.repair(target)
        return {
          repaired: health.category === 'healthy',
          health,
          scope: await this.summarize(context, projectPath, target.scopeBucketId)
        }
      }
      case 'retry_setup': {
        const target = this.requireManagedTarget(call.scope, context)
        const bucket = this.requireBucket(target.scopeBucketId, context)
        const runSetup = call.runSetup ?? true
        await this.worktrees.runSetupFromFailure(
          target,
          { runSetup },
          this.progressFor(target, bucket.name)
        )
        return {
          setupState: runSetup ? 'rerun' : 'skipped',
          scope: await this.summarize(context, projectPath, target.scopeBucketId)
        }
      }
      case 'sync_from_main':
      case 'sync_to_main':
        return await this.syncWithMain(call, context, projectPath)
      case 'detach_worktree':
      case 'delete_scope':
      case 'merge_into_project':
        return await this.runDestructive(call, context, projectPath)
      default:
        throw new TypeError(`Unsupported ${APP_SCOPE_UTILITY_ID} action: ${String(call.action)}`)
    }
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  private async listScopes(
    context: ScopeToolContext,
    projectPath: string
  ): Promise<ScopeSummary[]> {
    const board = this.scopes.getBoard(context.projectId)
    const summaries: ScopeSummary[] = []
    // Sequential on purpose: each health probe runs git in the same repository,
    // and the project's worktree service serialises them anyway.
    for (const bucket of board.buckets) {
      summaries.push(await this.summarizeBucket(context, projectPath, bucket))
    }
    return summaries
  }

  private async summarize(
    context: ScopeToolContext,
    projectPath: string,
    bucketId: string
  ): Promise<ScopeSummary> {
    return await this.summarizeBucket(context, projectPath, this.requireBucket(bucketId, context))
  }

  private async summarizeBucket(
    context: ScopeToolContext,
    projectPath: string,
    bucket: ScopeBucket
  ): Promise<ScopeSummary> {
    const threadCount =
      (await this.options.scopeThreads?.countThreadsInScope(context.projectId, bucket.id)) ?? 0
    if (bucket.root.kind !== 'worktree') {
      return {
        id: bucket.id,
        name: bucket.name,
        kind: 'project',
        path: projectPath,
        threadCount,
        archived: bucket.archivedAt !== undefined,
        pinned: bucket.pinned === true,
        active: bucket.id === context.scopeBucketId
      }
    }
    return {
      id: bucket.id,
      name: bucket.name,
      kind: 'worktree',
      path: getScopeRootPath(context.projectId, bucket.root.directoryName),
      branch: bucket.root.branch,
      baseBranch: bucket.root.baseBranch,
      directoryName: bucket.root.directoryName,
      setupState: bucket.root.setup.state,
      health: await this.worktrees.health({
        projectId: context.projectId,
        scopeBucketId: bucket.id
      }),
      threadCount,
      archived: bucket.archivedAt !== undefined,
      pinned: bucket.pinned === true,
      active: bucket.id === context.scopeBucketId
    }
  }

  private async describeScope(
    context: ScopeToolContext,
    projectPath: string,
    bucket: ScopeBucket
  ): Promise<unknown> {
    const summary = await this.summarizeBucket(context, projectPath, bucket)
    const healthy = summary.kind !== 'worktree' || summary.health?.category === 'healthy'
    const git = healthy ? await this.git.getStatus(summary.path) : null
    return {
      scope: summary,
      git,
      setup:
        bucket.root.kind === 'worktree'
          ? {
              state: bucket.root.setup.state,
              commands: bucket.root.setup.commands.map((record) => ({
                index: record.index,
                executable: record.executable,
                args: record.args,
                state: record.state,
                exitCode: record.exitCode
              }))
            }
          : null,
      ...(healthy
        ? {}
        : {
            guidance: `This scope’s checkout is unhealthy (${summary.health?.category}). Run ${APP_SCOPE_UTILITY_ID} with action "repair" before working in it.`
          })
    }
  }

  private async readConflicts(
    context: ScopeToolContext,
    projectPath: string,
    bucket: ScopeBucket
  ): Promise<unknown> {
    const summary = await this.summarizeBucket(context, projectPath, bucket)
    if (summary.kind === 'worktree' && summary.health?.category !== 'healthy') {
      throw new Error(
        `The scope “${bucket.name}” is unhealthy (${summary.health?.category}), so its conflicts cannot be read. Run ${APP_SCOPE_UTILITY_ID} with action "repair" first.`
      )
    }
    const status = await this.git.getStatus(summary.path)
    return {
      scope: { id: bucket.id, name: bucket.name, path: summary.path },
      conflictState: status.conflictState,
      conflicted: status.conflicted,
      clean: status.clean,
      ...(status.conflicted.length === 0 ? {} : { next: conflictNextStep(status) })
    }
  }

  // ─── Writes ───────────────────────────────────────────────────────────────

  private async createScope(
    call: ScopeToolCall,
    context: ScopeToolContext,
    projectPath: string
  ): Promise<unknown> {
    if (!call.title) throw new TypeError('title is required for create')
    const defaults = this.scopes.getBoard(context.projectId).worktreeDefaults
    const bucket = this.scopes.createBucket(context.projectId, { name: call.title }).bucket
    const target: ScopeTarget = { projectId: context.projectId, scopeBucketId: bucket.id }
    const runSetup = call.runSetup ?? defaults.runSetupByDefault
    try {
      const descriptor = await this.worktrees.createManagedWorktree(
        target,
        {
          title: call.title,
          runSetup,
          environmentMode: call.environmentMode ?? defaults.environmentMode,
          ...(call.baseBranch === undefined ? {} : { baseBranch: call.baseBranch }),
          ...(call.setupCommands === undefined ? {} : { setupCommands: call.setupCommands })
        },
        this.progressFor(target, call.title)
      )
      // The thread that asked for the scope is the one that should work in it.
      let threadMoved = false
      if (call.attachThread ?? true) {
        const lifecycle = this.options.scopeThreads
        if (lifecycle) {
          await lifecycle.moveThreadIntoScope(context.projectId, context.threadId, bucket.id)
          threadMoved = true
        }
      }
      this.options.onBoardChanged?.({
        projectId: context.projectId,
        scopeBucketId: bucket.id,
        summary: `created the worktree scope ${bucket.name} on ${descriptor.branch}`
      })
      return {
        created: true,
        scope: await this.summarize(context, projectPath, bucket.id),
        branch: descriptor.branch,
        baseBranch: descriptor.baseBranch,
        directoryName: descriptor.directoryName,
        path: getScopeRootPath(context.projectId, descriptor.directoryName),
        setupState: descriptor.setup.state,
        setupRan: runSetup,
        threadMoved,
        guidance: threadMoved
          ? 'This thread now works in the new checkout from its next turn. Commit your work there, then bring it back with action "sync_to_main".'
          : 'The scope is ready. Its branch and threads are on the scope board; move a thread into it there.'
      }
    } catch (cause) {
      // A worktree that never landed must not leave an empty project-rooted
      // bucket behind pretending to be a scope.
      const current = this.scopes
        .getBoard(context.projectId)
        .buckets.find((candidate) => candidate.id === bucket.id)
      if (current && current.root.kind === 'project') {
        this.scopes.deleteBucket(context.projectId, bucket.id)
      }
      throw cause
    }
  }

  private async adoptWorktree(
    call: ScopeToolCall,
    context: ScopeToolContext,
    projectPath: string
  ): Promise<unknown> {
    if (!call.sourcePath) throw new TypeError('sourcePath is required for adopt')
    let bucket: ScopeBucket
    if (call.title) {
      bucket = this.scopes.createBucket(context.projectId, { name: call.title }).bucket
    } else {
      bucket = this.resolveCustomScope(call.scope, context, 'adopted into')
    }
    const target: ScopeTarget = { projectId: context.projectId, scopeBucketId: bucket.id }
    try {
      const descriptor = await this.worktrees.adoptWorktree(
        target,
        { sourcePath: call.sourcePath, runSetup: call.runSetup ?? true },
        this.progressFor(target, bucket.name)
      )
      this.options.onBoardChanged?.({
        projectId: context.projectId,
        scopeBucketId: bucket.id,
        summary: `adopted the worktree ${descriptor.branch} into the scope ${bucket.name}`
      })
      return {
        adopted: true,
        scope: await this.summarize(context, projectPath, bucket.id),
        branch: descriptor.branch,
        directoryName: descriptor.directoryName,
        setupState: descriptor.setup.state
      }
    } catch (cause) {
      if (call.title) {
        const current = this.scopes
          .getBoard(context.projectId)
          .buckets.find((candidate) => candidate.id === bucket.id)
        if (current && current.root.kind === 'project') {
          this.scopes.deleteBucket(context.projectId, bucket.id)
        }
      }
      throw cause
    }
  }

  private async syncWithMain(
    call: ScopeToolCall,
    context: ScopeToolContext,
    projectPath: string
  ): Promise<unknown> {
    const bucket = this.resolveScope(call.scope, context)
    if (bucket.root.kind !== 'worktree') {
      throw new Error(
        `The scope “${bucket.name}” works directly in the project directory, so it has no worktree to sync with main.`
      )
    }
    const scopeRoot = getScopeRootPath(context.projectId, bucket.root.directoryName)
    const health = await this.worktrees.health({
      projectId: context.projectId,
      scopeBucketId: bucket.id
    })
    if (health.category !== 'healthy') {
      throw new Error(
        `The scope “${bucket.name}” is unhealthy (${health.category}), so it cannot be synced. Run ${APP_SCOPE_UTILITY_ID} with action "repair" first.`
      )
    }
    const strategy = call.strategy ?? (await this.options.defaultPullStrategy?.()) ?? 'merge'
    const token = await this.options.resolveGitToken?.(context.projectId)
    const direction: GitMainSyncDirection =
      call.action === 'sync_from_main' ? 'from-main' : 'to-main'
    const result = await this.git.syncMain(scopeRoot, {
      direction,
      mainPath: projectPath,
      strategy,
      ...(token === undefined ? {} : { token })
    })
    const conflicted = result.status.conflicted
    return {
      synced: conflicted.length === 0,
      direction,
      branch: result.branch,
      mainBranch: result.mainBranch,
      ref: result.ref,
      strategy,
      fetched: result.fetched,
      remote: result.remote,
      incoming: result.incoming,
      mainAhead: result.mainAhead,
      conflicted,
      conflictState: result.status.conflictState,
      published: false,
      ...(conflicted.length === 0 ? {} : { next: conflictNextStep(result.status) })
    }
  }

  // ─── Destructive actions ──────────────────────────────────────────────────

  /**
   * Confirmation contract for every destructive action.
   *
   * A call without `confirm` changes nothing: it returns the state-bound
   * snapshot plus the challenge the model must answer. With `confirm`, a
   * `full_access` turn proceeds (the model already confronted the challenge)
   * while an `auto_review` turn still needs the user to approve in the app.
   */
  private async runDestructive(
    call: ScopeToolCall,
    context: ScopeToolContext,
    projectPath: string
  ): Promise<unknown> {
    if (!DESTRUCTIVE_ACTIONS.has(call.action)) {
      throw new TypeError(`Unsupported ${APP_SCOPE_UTILITY_ID} action: ${String(call.action)}`)
    }
    const bucket = this.resolveScope(call.scope, context)
    const project = await this.projects.getProject(context.projectId)
    const managed = bucket.root.kind === 'worktree'
    const target: ScopeTarget = { projectId: context.projectId, scopeBucketId: bucket.id }
    const threadCount =
      (await this.options.scopeThreads?.countThreadsInScope(context.projectId, bucket.id)) ?? 0

    if (call.action === 'delete_scope' && threadCount > 0 && call.threads === undefined) {
      throw new TypeError(
        `${threadCount} thread${threadCount === 1 ? '' : 's'} belong to the scope “${bucket.name}”. Pass threads: "move-to-default" to keep their conversations, or threads: "delete" to delete them with the scope.`
      )
    }
    if (call.action === 'merge_into_project' && !managed) {
      throw new Error(`The scope “${bucket.name}” has no worktree to merge back`)
    }

    const snapshot = managed ? await this.worktrees.lifecycleSnapshot(target) : null
    if (snapshot?.hasActiveProcesses) {
      throw new Error(
        `Threads in the scope “${bucket.name}” still own live processes, so this action would strand them. Stop those processes or threads first, or do it from the scope board.`
      )
    }

    // Resolved before the challenge is composed so the summary the user reads
    // names the real destination. Merging "into the project" means the Default
    // scope: defaulting to the caller's scope would target the very scope being
    // merged (and be rejected as a self-merge).
    const mergeTarget =
      call.action !== 'merge_into_project'
        ? null
        : call.target === undefined
          ? this.requireBucket(DEFAULT_SCOPE_BUCKET_ID, context)
          : this.resolveScope(call.target, context)

    const summary = destructiveSummary(call, bucket, mergeTarget?.name)
    const consequences = destructiveConsequences(call, bucket, snapshot, threadCount)
    // A self-merge is refused here, before the challenge is composed and before
    // an auto_review user is asked to approve something that cannot run.
    if (call.action === 'merge_into_project' && mergeTarget && mergeTarget.id === bucket.id) {
      throw new TypeError(
        `The scope “${bucket.name}” cannot be merged into itself. Pass target with another scope, or omit it to merge into the Default scope.`
      )
    }

    if (call.confirm !== true) {
      return {
        confirmationRequired: true,
        action: call.action,
        scope: {
          id: bucket.id,
          name: bucket.name,
          path:
            bucket.root.kind === 'worktree'
              ? getScopeRootPath(context.projectId, bucket.root.directoryName)
              : projectPath
        },
        challenge: `Are you sure you want to ${summary}? [YES] [NO]`,
        consequences,
        snapshot,
        next: `If you are not certain the user asked for exactly this, ask them in your reply instead of confirming. To proceed, call ${APP_SCOPE_UTILITY_ID} again with confirm true.`
      }
    }

    if (context.permissionLevel === 'auto_review') {
      const approved = await this.requestUserApproval({
        action: call.action,
        summary,
        consequences,
        projectId: context.projectId,
        projectName: project?.name ?? context.projectId,
        scopeBucketId: bucket.id,
        scopeName: bucket.name,
        threadId: context.threadId,
        threadTitle: context.threadTitle,
        dirtyFiles: snapshot?.dirtyFiles ?? [],
        unpushedCommits: snapshot?.unpushedCommits ?? 0,
        hasActiveProcesses: snapshot?.hasActiveProcesses ?? false
      })
      if (!approved) {
        return {
          cancelled: true,
          action: call.action,
          scope: { id: bucket.id, name: bucket.name },
          message: `The user did not approve: ${summary}. Nothing was changed. Do not retry unless the user asks for it.`
        }
      }
    }

    if (call.action === 'merge_into_project') {
      const mode = call.mode ?? 'merge-keep'
      if (!mergeTarget) throw new TypeError('merge_into_project needs a merge target')
      const mergePreflight = await this.worktrees.mergePreflight(
        target,
        { projectId: context.projectId, scopeBucketId: mergeTarget.id },
        mode
      )
      this.requireIdleForDestructive(bucket, mergePreflight.hasActiveProcesses)
      const outcome = await this.worktrees.confirmMerge(
        target,
        { projectId: context.projectId, scopeBucketId: mergeTarget.id },
        mode,
        mergePreflight.confirmationId
      )
      // Only a landed merge is a board change; a conflicted merge is rolled back
      // by the worktree service and must not be announced as a successful one.
      if (outcome.merged) {
        this.options.onBoardChanged?.({
          projectId: context.projectId,
          scopeBucketId: bucket.id,
          summary: `merged the scope ${bucket.name} into ${mergeTarget.name}`
        })
      }
      return {
        merged: outcome.merged,
        conflicted: outcome.conflicted,
        mode,
        target: { id: mergeTarget.id, name: mergeTarget.name },
        ...(outcome.merged
          ? {}
          : {
              next: `The merge conflicted in ${mergeTarget.name}; nothing was deleted. Bring main into ${bucket.name} with action "sync_from_main", resolve the conflicts there, then retry.`
            })
      }
    }

    if (managed) {
      // The token-minting preflight runs before anything irreversible, so a
      // scope that gained live processes since the challenge refuses without
      // having moved or deleted a single thread.
      const preflight = await this.worktrees.preflight(
        call.action === 'detach_worktree' ? 'detach' : 'delete-scope',
        target
      )
      this.requireIdleForDestructive(bucket, preflight.hasActiveProcesses)
      await this.disposeScopeThreads(call, bucket, context, threadCount)
      if (call.action === 'detach_worktree') {
        await this.worktrees.confirmDetach(
          target,
          preflight.confirmationId,
          preflight.dirtyFiles.length > 0 || preflight.unpushedCommits > 0
        )
      } else {
        await this.worktrees.confirmDeleteScope(
          target,
          preflight.confirmationId,
          call.deleteBranch ?? false
        )
      }
    } else if (call.action === 'detach_worktree') {
      // Nothing to detach: the scope works directly in the project directory.
      throw new Error(
        `The scope “${bucket.name}” works in the project directory, so it has no worktree to detach.`
      )
    } else {
      await this.disposeScopeThreads(call, bucket, context, threadCount)
      this.scopes.deleteBucket(context.projectId, bucket.id)
    }

    this.options.onBoardChanged?.({
      projectId: context.projectId,
      scopeBucketId: bucket.id,
      summary: `${call.action === 'detach_worktree' ? 'detached the worktree from' : 'deleted'} the scope ${bucket.name}`
    })
    return {
      done: true,
      action: call.action,
      scope: { id: bucket.id, name: bucket.name },
      deletedBranch:
        call.action === 'delete_scope' && managed ? (call.deleteBranch ?? false) : false
    }
  }

  /**
   * Apply the caller's thread disposition for a scope that is about to be
   * removed. It runs last, immediately before the bucket disappears, so a
   * refusal earlier in the flow can never have destroyed a conversation: a
   * scope that still owns threads must be disposed of before `deleteBucket`, or
   * those threads would keep a bucket id that no longer exists.
   */
  private async disposeScopeThreads(
    call: ScopeToolCall,
    bucket: ScopeBucket,
    context: ScopeToolContext,
    threadCount: number
  ): Promise<void> {
    if (call.action !== 'delete_scope' || threadCount === 0) return
    if (call.threads === 'delete') {
      await this.options.scopeThreads?.deleteThreadsInScope(context.projectId, bucket.id)
    } else if (call.threads === 'move-to-default') {
      await this.options.scopeThreads?.moveThreadsOutOfScope(context.projectId, bucket.id)
    }
  }

  /** A live process that appeared between the challenge and the confirm blocks removal. */
  private requireIdleForDestructive(bucket: ScopeBucket, hasActiveProcesses: boolean): void {
    if (!hasActiveProcesses) return
    throw new Error(
      `The scope “${bucket.name}” gained live processes since it was inspected, so nothing was removed. Stop them and try again.`
    )
  }

  /** Ask the renderer for a decision; no answer (or no window) means no. */
  private async requestUserApproval(input: {
    action: ScopeToolAction
    summary: string
    consequences: string[]
    projectId: string
    projectName: string
    scopeBucketId: string
    scopeName: string
    threadId: string
    threadTitle: string
    dirtyFiles: string[]
    unpushedCommits: number
    hasActiveProcesses: boolean
  }): Promise<boolean> {
    const request = this.options.requestConfirmation
    if (!request) {
      throw new Error(
        'This action needs the user to confirm it, but no confirmation surface is available in this session. Ask the user to do it from the scope board.'
      )
    }
    const timeoutMs = this.options.confirmationTimeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS
    return await request({
      requestId: randomUUID(),
      action: input.action,
      summary: input.summary,
      consequences: input.consequences,
      projectId: input.projectId,
      projectName: input.projectName,
      scopeBucketId: input.scopeBucketId,
      scopeName: input.scopeName,
      threadId: input.threadId,
      threadTitle: input.threadTitle,
      dirtyFiles: input.dirtyFiles,
      unpushedCommits: input.unpushedCommits,
      hasActiveProcesses: input.hasActiveProcesses,
      expiresAt: Date.now() + timeoutMs
    })
  }

  // ─── Resolution helpers ───────────────────────────────────────────────────

  private getBoard(context: ScopeToolContext): ScopeBoard {
    return this.scopes.getBoard(context.projectId)
  }

  private requireBucket(bucketId: string, context: ScopeToolContext): ScopeBucket {
    const bucket = this.getBoard(context).buckets.find((candidate) => candidate.id === bucketId)
    if (!bucket) throw new Error(`Scope no longer exists: ${bucketId}`)
    return bucket
  }

  /** Resolve `scope` by bucket id or display name, defaulting to the caller's scope. */
  private resolveScope(reference: string | undefined, context: ScopeToolContext): ScopeBucket {
    const board = this.getBoard(context)
    if (reference === undefined) {
      const active =
        board.buckets.find((candidate) => candidate.id === context.scopeBucketId) ??
        board.buckets.find((candidate) => candidate.id === DEFAULT_SCOPE_BUCKET_ID)
      if (!active) throw new Error('The project has no scope to act on')
      return active
    }
    const trimmed = reference.trim()
    const byId = board.buckets.find((candidate) => candidate.id === trimmed)
    if (byId) return byId
    const lowered = trimmed.toLowerCase()
    const named = board.buckets.filter(
      (candidate) => candidate.name.trim().toLowerCase() === lowered
    )
    if (named.length === 1) return named[0]
    if (named.length > 1) {
      throw new Error(
        `Multiple scopes are named “${trimmed}”. Pass the scope id instead: ${named
          .map((candidate) => candidate.id)
          .join(', ')}`
      )
    }
    throw new Error(
      `No scope matches “${trimmed}”. Available scopes: ${board.buckets
        .map((candidate) => `${candidate.name} (${candidate.id})`)
        .join(', ')}`
    )
  }

  private resolveCustomScope(
    reference: string | undefined,
    context: ScopeToolContext,
    verb: string
  ): ScopeBucket {
    const bucket = this.resolveScope(reference, context)
    if (bucket.id === DEFAULT_SCOPE_BUCKET_ID) {
      throw new Error(
        `The Default scope cannot be ${verb}: it always uses the project directory and has no worktree.`
      )
    }
    return bucket
  }

  private requireManagedTarget(
    reference: string | undefined,
    context: ScopeToolContext
  ): ScopeTarget {
    const bucket = this.resolveScope(reference, context)
    if (bucket.root.kind !== 'worktree') {
      throw new Error(`The scope “${bucket.name}” has no managed worktree to act on`)
    }
    return { projectId: context.projectId, scopeBucketId: bucket.id }
  }

  private afterBoardChange(context: ScopeToolContext, bucketId: string, summary: string): unknown {
    this.options.onBoardChanged?.({
      projectId: context.projectId,
      scopeBucketId: bucketId,
      summary
    })
    const bucket = this.getBoard(context).buckets.find((candidate) => candidate.id === bucketId)
    return {
      done: true,
      summary,
      scope: bucket
        ? {
            id: bucket.id,
            name: bucket.name,
            archived: bucket.archivedAt !== undefined,
            pinned: bucket.pinned === true
          }
        : null
    }
  }

  private progressFor(target: ScopeTarget, title: string): (event: ScopeWorktreeProgress) => void {
    return (event) => {
      this.options.onProgress?.({
        projectId: target.projectId,
        scopeBucketId: target.scopeBucketId,
        origin: 'agent',
        title,
        ...event
      })
    }
  }
}

/** How to finish an in-progress merge or rebase after resolving files. */
function conflictNextStep(status: GitStatus): string {
  if (status.conflictState === 'rebase') {
    return 'Resolve each file, stage it with `git add`, then run `git rebase --continue`. Run `git rebase --abort` to give up.'
  }
  if (status.conflictState === 'merge') {
    return 'Resolve each file, stage it with `git add`, then run `git commit` to finish the merge. Run `git merge --abort` to give up.'
  }
  return 'Resolve each conflicted file and stage it with `git add`.'
}

function destructiveSummary(
  call: ScopeToolCall,
  bucket: ScopeBucket,
  mergeTargetName?: string
): string {
  const label = bucket.root.kind === 'worktree' ? 'the worktree scope' : 'the scope'
  switch (call.action) {
    case 'detach_worktree':
      return `detach the worktree from ${label} “${bucket.name}” (the scope and its branch stay; only the checkout is removed)`
    case 'delete_scope':
      return `delete ${label} “${bucket.name}”${call.deleteBranch ? ' and its branch' : ''}`
    case 'merge_into_project':
      return `merge the scope “${bucket.name}” into ${mergeTargetName ?? 'the project'}`
    default:
      return `change ${label} “${bucket.name}”`
  }
}

function destructiveConsequences(
  call: ScopeToolCall,
  bucket: ScopeBucket,
  snapshot: ScopeLifecycleSnapshot | null,
  threadCount: number
): string[] {
  const consequences: string[] = []
  if (call.action === 'detach_worktree') {
    consequences.push('The worktree checkout directory is removed.')
    consequences.push('The scope, its threads and its branch are kept.')
  }
  if (call.action === 'delete_scope') {
    consequences.push('The scope is removed from the project board.')
    if (bucket.root.kind === 'worktree') {
      consequences.push('Its worktree checkout is removed.')
      consequences.push(
        call.deleteBranch
          ? 'Its managed branch is deleted permanently.'
          : 'Its managed branch is kept.'
      )
    }
    if (threadCount > 0) {
      consequences.push(
        call.threads === 'delete'
          ? `${threadCount} thread${threadCount === 1 ? '' : 's'} and their conversations are deleted permanently.`
          : `${threadCount} thread${threadCount === 1 ? '' : 's'} move to the Default scope.`
      )
    }
  }
  if (call.action === 'merge_into_project') {
    const mode = call.mode ?? 'merge-keep'
    consequences.push('The scope’s branch is merged into the target scope’s checkout.')
    if (mode === 'merge-delete') {
      consequences.push('Then the source scope, its worktree and its branch are deleted.')
    } else if (mode === 'merge-move-to-default') {
      consequences.push(
        'Then the source scope is deleted and its threads move to the Default scope.'
      )
    } else {
      consequences.push('The source scope, its worktree and its branch are kept.')
    }
    consequences.push('Nothing is pushed to a remote.')
  }
  if (snapshot && snapshot.dirtyFiles.length > 0) {
    consequences.push(
      `${snapshot.dirtyFiles.length} uncommitted file${snapshot.dirtyFiles.length === 1 ? '' : 's'} in the checkout are discarded.`
    )
  }
  if (snapshot && snapshot.unpushedCommits > 0) {
    consequences.push(
      `${snapshot.unpushedCommits} commit${snapshot.unpushedCommits === 1 ? '' : 's'} on the scope branch exist nowhere else.`
    )
  }
  return consequences
}

/**
 * Normalize raw tool input into a validated call. Unknown fields are rejected
 * rather than ignored, so a model's typo can never look like a successful
 * request for something else.
 */
export function parseScopeToolInput(input: Record<string, unknown>): ScopeToolCall {
  for (const key of Object.keys(input)) {
    if (!SCOPE_TOOL_INPUT_KEYS.has(key)) {
      throw new TypeError(`Unsupported ${APP_SCOPE_UTILITY_ID} input field: ${key}`)
    }
  }
  const rawAction = input['action']
  if (typeof rawAction !== 'string' || !rawAction.trim()) {
    throw new TypeError('action is required')
  }
  const action = rawAction.trim()
  if (!(SCOPE_TOOL_ACTIONS as readonly string[]).includes(action)) {
    throw new TypeError(
      `Unsupported action “${action}”. Use one of: ${SCOPE_TOOL_ACTIONS.join(', ')}`
    )
  }
  const call: ScopeToolCall = { action: action as ScopeToolAction }
  const scope = optionalString(input, 'scope', MAX_REFERENCE_LENGTH)
  if (scope !== undefined) call.scope = scope
  const title = optionalString(input, 'title', MAX_TITLE_LENGTH)
  if (title !== undefined) call.title = title
  const name = optionalString(input, 'name', MAX_NAME_LENGTH)
  if (name !== undefined) call.name = name
  const baseBranch = optionalString(input, 'baseBranch', MAX_REFERENCE_LENGTH)
  if (baseBranch !== undefined) call.baseBranch = baseBranch
  const sourcePath = optionalString(input, 'sourcePath', MAX_PATH_LENGTH)
  if (sourcePath !== undefined) call.sourcePath = sourcePath
  const target = optionalString(input, 'target', MAX_REFERENCE_LENGTH)
  if (target !== undefined) call.target = target
  const runSetup = optionalBoolean(input, 'runSetup')
  if (runSetup !== undefined) call.runSetup = runSetup
  const attachThread = optionalBoolean(input, 'attachThread')
  if (attachThread !== undefined) call.attachThread = attachThread
  const deleteBranch = optionalBoolean(input, 'deleteBranch')
  if (deleteBranch !== undefined) call.deleteBranch = deleteBranch
  const confirm = optionalBoolean(input, 'confirm')
  if (confirm !== undefined) call.confirm = confirm
  const environmentMode = optionalEnum(input, 'environmentMode', ENVIRONMENT_MODES)
  if (environmentMode !== undefined) call.environmentMode = environmentMode
  const strategy = optionalEnum(input, 'strategy', STRATEGIES)
  if (strategy !== undefined) call.strategy = strategy
  const mode = optionalEnum(input, 'mode', MERGE_MODES)
  if (mode !== undefined) call.mode = mode
  const threads = optionalEnum(input, 'threads', THREAD_DISPOSITIONS)
  if (threads !== undefined) call.threads = threads
  const setupCommands = parseSetupCommands(input['setupCommands'])
  if (setupCommands !== undefined) call.setupCommands = setupCommands
  return call
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
  maxLength: number
): string | undefined {
  const value = input[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new TypeError(`${key} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.length > maxLength) {
    throw new TypeError(`${key} must be at most ${maxLength} characters`)
  }
  return trimmed
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new TypeError(`${key} must be a boolean`)
  return value
}

function optionalEnum<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: readonly T[]
): T | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${key} must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

function parseSetupCommands(value: unknown): ScopeSetupCommandSpec[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new TypeError('setupCommands must be an array')
  if (value.length > 20) throw new TypeError('setupCommands must contain at most 20 commands')
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new TypeError(`setupCommands entry ${index} must be an object`)
    }
    const record = entry as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (key !== 'executable' && key !== 'args') {
        throw new TypeError(`setupCommands entry ${index} has an unsupported field: ${key}`)
      }
    }
    const executable = optionalString(record, 'executable', MAX_PATH_LENGTH)
    if (!executable) throw new TypeError(`setupCommands entry ${index} needs an executable`)
    const args = record['args']
    if (args !== undefined && !Array.isArray(args)) {
      throw new TypeError(`setupCommands entry ${index} args must be an array`)
    }
    return {
      executable,
      args: ((args as unknown[] | undefined) ?? []).map((arg, argIndex) => {
        if (typeof arg !== 'string') {
          throw new TypeError(`setupCommands entry ${index} argument ${argIndex} must be a string`)
        }
        return arg
      })
    }
  })
}
