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
  ScopeTarget,
  ScopeToolAction,
  ScopeWorktreeProgress,
  ScopeWorktreeProgressEvent
} from '../../lib/types'
import { SCOPE_TOOL_DESTRUCTIVE_ACTIONS } from '../../lib/types'
import { APP_SCOPE_UTILITY_ID } from '../../lib/utility-ids'
import { getScopeRootPath } from '../../lib/utils'
import { ScopeManager } from '../../lib/engines/scope-manager'
import { ProjectManager } from '../../lib/engines/project-manager'
import type { ScopeThreadLifecycle, ScopeWorktreeService } from '../git/scope-worktree-service'
import { parseScopeToolInput } from './scope-tool/scope-tool-input'
import type { ScopeSummary, ScopeToolCall } from './scope-tool/scope-tool-types'
import {
  conflictNextStep,
  destructiveConsequences,
  destructiveSummary
} from './scope-tool/scope-tool-destructive'
import { describeScope, readConflicts, summarizeBucket } from './scope-tool/scope-tool-reads'
import type { ScopeReadDeps } from './scope-tool/scope-tool-reads'
import {
  requireScopeBucket,
  resolveCustomScopeBucket,
  resolveScopeBucket
} from './scope-tool/scope-tool-resolution'

export { parseScopeToolInput }

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

const DESTRUCTIVE_ACTIONS: ReadonlySet<string> = new Set(SCOPE_TOOL_DESTRUCTIVE_ACTIONS)

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
        return await describeScope(
          this.readDeps,
          context,
          projectPath,
          this.resolveScope(call.scope, context)
        )
      case 'conflicts':
        return await readConflicts(
          this.readDeps,
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

  /** Read-only dependency bundle shared by the scope read projections. */
  private get readDeps(): ScopeReadDeps {
    return { scopes: this.scopes, worktrees: this.worktrees, git: this.git, options: this.options }
  }

  private async listScopes(
    context: ScopeToolContext,
    projectPath: string
  ): Promise<ScopeSummary[]> {
    const board = this.scopes.getBoard(context.projectId)
    const summaries: ScopeSummary[] = []
    // Sequential on purpose: each health probe runs git in the same repository,
    // and the project's worktree service serialises them anyway.
    for (const bucket of board.buckets) {
      summaries.push(await summarizeBucket(this.readDeps, context, projectPath, bucket))
    }
    return summaries
  }

  private async summarize(
    context: ScopeToolContext,
    projectPath: string,
    bucketId: string
  ): Promise<ScopeSummary> {
    return await summarizeBucket(
      this.readDeps,
      context,
      projectPath,
      this.requireBucket(bucketId, context)
    )
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
    return requireScopeBucket(this.getBoard(context), bucketId)
  }

  /** Resolve `scope` by bucket id or display name, defaulting to the caller's scope. */
  private resolveScope(reference: string | undefined, context: ScopeToolContext): ScopeBucket {
    return resolveScopeBucket(this.getBoard(context), reference, context.scopeBucketId)
  }

  private resolveCustomScope(
    reference: string | undefined,
    context: ScopeToolContext,
    verb: string
  ): ScopeBucket {
    return resolveCustomScopeBucket(this.getBoard(context), reference, context.scopeBucketId, verb)
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
