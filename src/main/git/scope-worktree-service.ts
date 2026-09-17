import { rm } from 'fs/promises'
import { randomBytes } from 'crypto'
import { DEFAULT_SCOPE_BUCKET_ID } from '../../lib/types'
import type {
  AdoptableWorktreeInfo,
  ManagedWorktreeDescriptor,
  ScopeEnvironmentMode,
  ScopeLifecyclePreflight,
  ScopeLifecycleSnapshot,
  ScopeMergeMode,
  ScopeMergeOutcome,
  ScopeMergePreflight,
  ScopeSetupCommandSpec,
  ScopeTarget,
  ScopeWorktreeCreateInput,
  ScopeWorktreeHealth,
  ScopeWorktreeProgress,
  ScopeWorktreeSourceInfo
} from '../../lib/types'
import { getScopeRootPath } from '../../lib/utils'
import { ScopeManager } from '../../lib/engines/scope-manager'
import { ProjectManager } from '../../lib/engines/project-manager'
import { runGit, runGitChecked } from './scope-worktree-process'
import type {
  ManagedWorktreeInspector,
  WorktreeRegistration
} from '../workspaces/scope-root-resolver'
import { Logger } from '../system/logger'
import { ScopeWorktreeHealthInspector } from './scope-worktree/scope-worktree-health'
import { runEnvironmentAndSetup as runEnvironmentAndSetupCommands } from './scope-worktree/scope-worktree-setup'
import {
  adoptionMetadata,
  branchToCommit,
  currentBranchAndCommit,
  dirtyFiles,
  distinctExistingNames,
  hasTrackedSubmodules,
  isGitRepository,
  managedBranchRegisteredAt,
  runRepairStep,
  unpushedCount
} from './scope-worktree/scope-worktree-git'
import { listWorktreeRegistrations } from './scope-worktree/scope-worktree-git'
import {
  assertDistinctMergeTarget,
  removeManagedWorktree,
  resolveMergeTargetRoot,
  runIntoMerge
} from './scope-worktree/scope-worktree-merge'
import {
  branchNameOf,
  ensureParentDir,
  normalizeAdoptSourcePath,
  propagateEnvironment as propagateEnvironmentFiles,
  resolveRepositoryRoot
} from './scope-worktree/scope-worktree-environment'

export { parseWorktreePorcelain } from './scope-worktree/scope-worktree-porcelain'
export type { ParsedWorktreeList } from './scope-worktree/scope-worktree-porcelain'
export { discoverEnvironmentFiles } from './scope-worktree/scope-worktree-environment'

const WORKTREE_BRANCH_PREFIX = 'cio/'
const SLUG_LIMIT = 48

/** Minimal structural view of agent processes that may hold worktree files. */
export interface ActiveProcessProbe {
  /** Whether threads in the project   optionally one scope   own live processes. */
  hasActiveProcessesFor(projectId: string, scopeBucketId?: string): Promise<boolean> | boolean
}

/**
 * Thread lifecycle operations the merge flow needs after the git merge lands.
 * Injected by the IPC layer after the ThreadManager is constructed.
 */
export interface ScopeThreadLifecycle {
  /** Count non-archived, user-visible threads owned by a scope bucket. */
  countThreadsInScope(projectId: string, bucketId: string): Promise<number>
  /** Delete every thread owned by a scope bucket. Returns how many were deleted. */
  deleteThreadsInScope(projectId: string, bucketId: string): Promise<number>
  /** Move every thread owned by a scope into the Default bucket, evicting older Default threads as needed. */
  moveThreadsOutOfScope(
    projectId: string,
    fromBucketId: string
  ): Promise<{ moved: number; evicted: number }>
  /**
   * Move one thread into a scope bucket. Used when an agent creates a scope for
   * the work it is already doing, so the next turn runs in the new root.
   */
  moveThreadIntoScope(projectId: string, threadId: string, bucketId: string): Promise<void>
}

export interface ScopeWorktreeServiceOptions {
  activeProcesses?: ActiveProcessProbe
  scopeThreads?: ScopeThreadLifecycle
}

interface PreflightSnapshot {
  action:
    'detach' | 'remove-worktree' | 'delete-scope' | 'delete-branch' | 'delete-project-worktrees'
  target: ScopeTarget
  dirtyFiles: string[]
  unpushedCommits: number
  hasActiveProcesses: boolean
  branchOwnedByWorktree: boolean
  token: string
  createdAt: number
}

interface MergePreflightSnapshot {
  target: ScopeTarget
  mergeTarget: ScopeTarget
  mode: ScopeMergeMode
  descriptor: ManagedWorktreeDescriptor
  sourcePath: string
  targetBranch: string
  threadCount: number
  dirtyFiles: string[]
  unpushedCommits: number
  hasActiveProcesses: boolean
  token: string
  createdAt: number
}

/**
 * Owns the managed-worktree lifecycle for scopes: porcelain discovery,
 * collision-safe creation, environment handling, structured setup, health
 * checks, confirmation-bound preflights, and guarded removal.
 *
 * All lifecycle mutations are serialized per project through a promise queue.
 */
export class ScopeWorktreeService implements ManagedWorktreeInspector {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly preflights = new Map<string, PreflightSnapshot>()
  private readonly mergePreflights = new Map<string, MergePreflightSnapshot>()
  private readonly activeProcesses?: ActiveProcessProbe
  private scopeThreads?: ScopeThreadLifecycle
  private readonly healthInspector: ScopeWorktreeHealthInspector

  constructor(
    private scopes: ScopeManager,
    private projects: Pick<ProjectManager, 'getProject'>,
    options: ScopeWorktreeServiceOptions = {}
  ) {
    this.activeProcesses = options.activeProcesses
    this.scopeThreads = options.scopeThreads
    this.healthInspector = new ScopeWorktreeHealthInspector({
      projects: this.projects,
      scopes: this.scopes,
      requireManaged: (target) => this.requireManaged(target),
      listWorktrees: (repoPath) => this.listWorktrees(repoPath),
      propagateEnvironment: (projectId, worktreePath, mode) =>
        propagateEnvironmentFiles(this.projects, projectId, worktreePath, mode)
    })
  }

  /**
   * Inject the thread lifecycle once the ThreadManager is available. The merge
   * service is constructed before the thread manager, so callers wire it in
   * after both exist.
   */
  attachThreadLifecycle(scopeThreads: ScopeThreadLifecycle): void {
    this.scopeThreads = scopeThreads
  }

  private enqueue<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.queues.set(
      projectId,
      next.then(
        () => undefined,
        () => undefined
      )
    )
    return next
  }

  /** Implement `ManagedWorktreeInspector` for the shared scope resolver. */
  async listWorktrees(repoPath: string): Promise<WorktreeRegistration[]> {
    return listWorktreeRegistrations(repoPath)
  }

  /** Slugify a feature title per the documented naming rules. */
  slugify(title: string): string {
    const normalized = title
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
    const slug = normalized
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-+|-+$)/g, '')
      .slice(0, SLUG_LIMIT)
      .replace(/-+$/g, '')
    if (!slug) return `feature-${randomBytes(4).toString('hex')}`
    return slug
  }

  /** Derive a `cio/<slug>` branch plus a config-root worktree path that are all free. */
  private async deriveNames(
    projectId: string,
    repoPath: string,
    title: string,
    progress?: (event: ScopeWorktreeProgress) => void
  ): Promise<{ directoryName: string; branch: string; path: string }> {
    progress?.({ stage: 'naming' })
    const base = this.slugify(title)
    const existing = await distinctExistingNames(repoPath)
    const persisted = this.persistedDirectories(projectId)

    for (let candidate = 0; ; candidate += 1) {
      const suffix = candidate === 0 ? '' : `-${candidate + 1}`
      const directoryName = `${base}${suffix}`
      const branch = `${WORKTREE_BRANCH_PREFIX}${directoryName}`
      const path = getScopeRootPath(projectId, directoryName)
      if (persisted.has(directoryName)) continue
      if (existing.branches.has(`refs/heads/${branch}`)) continue
      if (existing.paths.has(path)) continue
      return { directoryName, branch, path }
    }
  }

  private persistedDirectories(projectId: string): Set<string> {
    const board = this.scopes.getBoard(projectId)
    const names = new Set<string>()
    for (const bucket of board.buckets) {
      if (bucket.root.kind === 'worktree') names.add(bucket.root.directoryName)
    }
    return names
  }

  /**
   * Create a managed worktree and persist the scope association. Safe for
   * concurrent invocation: the per-project queue serializes mutations, and a
   * crash midway preserves the registered worktree for recovery.
   *
   * The worktree branches from `input.baseBranch` when supplied, otherwise
   * from the currently checked-out branch. The environment mode and setup
   * commands travel with the request: they are executed for exactly this
   * worktree even if the project-level defaults change afterwards.
   */
  async createManagedWorktree(
    target: ScopeTarget,
    input: ScopeWorktreeCreateInput,
    progress?: (event: ScopeWorktreeProgress) => void
  ): Promise<ManagedWorktreeDescriptor> {
    return this.enqueue(target.projectId, async () => {
      const project = await this.projects.getProject(target.projectId)
      if (!project || project.source !== 'local' || !project.path) {
        throw new Error('Managed worktrees require a local project repository')
      }
      const repoPath = project.path

      progress?.({ stage: 'discovering-repository' })
      if (!isGitRepository(repoPath)) {
        throw new Error(`${repoPath} is not a Git repository`)
      }
      if (await hasTrackedSubmodules(repoPath)) {
        progress?.({ stage: 'failed', detail: 'submodules' })
        throw new Error(
          'Repositories with tracked submodules are not supported for managed worktrees in this release'
        )
      }

      const baseRef = input.baseBranch?.trim() || undefined
      const base =
        baseRef === undefined
          ? await currentBranchAndCommit(repoPath)
          : await branchToCommit(repoPath, baseRef)

      const {
        directoryName,
        branch: createdBranch,
        path
      } = await this.deriveNames(target.projectId, repoPath, input.title, progress)

      progress?.({ stage: 'creating-worktree', detail: createdBranch })
      await ensureParentDir(path)
      await runGit(['worktree', 'add', '-b', createdBranch, path, base.commit], {
        cwd: repoPath,
        timeoutMs: 120_000
      }).catch(async (error) => {
        await rm(path, { recursive: true, force: true }).catch(() => undefined)
        throw error
      })

      // Ensure the scope bucket exists before persisting the association.
      const board = this.scopes.getBoard(target.projectId)
      let bucketId = target.scopeBucketId
      if (!board.buckets.some((candidate) => candidate.id === bucketId)) {
        // A project-root scope was created eagerly; fall back to the default.
        bucketId = bucketId === 'default' ? 'default' : bucketId
      }

      const descriptor: ManagedWorktreeDescriptor = {
        kind: 'worktree',
        directoryName,
        branch: createdBranch,
        baseBranch: base.branch,
        baseCommit: base.commit,
        createdAt: Date.now(),
        environmentMode: input.environmentMode,
        setup: { state: 'not_run', commands: [] }
      }
      progress?.({ stage: 'persisting-association' })
      this.scopes.attachManagedRoot(target.projectId, bucketId, descriptor)

      if (input.runSetup) {
        const commands = input.setupCommands ?? this.setupCommands(target.projectId)
        await this.runEnvironmentAndSetup(target.projectId, path, descriptor, commands, progress)
      } else {
        await this.propagateEnvironment(target.projectId, path, input.environmentMode, progress)
      }

      progress?.({ stage: 'done' })
      return descriptor
    })
  }

  /**
   * Facts about the source checkout that a new worktree would fork from:
   * current branch, HEAD commit, and the uncommitted changes that will NOT be
   * included. Surfaced to the renderer before creation.
   */
  async sourceInfo(projectId: string): Promise<ScopeWorktreeSourceInfo> {
    const project = await this.projects.getProject(projectId)
    if (!project || project.source !== 'local' || !project.path) {
      throw new Error('Managed worktrees require a local project repository')
    }
    if (!isGitRepository(project.path)) {
      throw new Error(`${project.path} is not a Git repository`)
    }
    const { branch, commit } = await currentBranchAndCommit(project.path)
    return {
      currentBranch: branch,
      headCommit: commit,
      dirtyFiles: await dirtyFiles(project.path, project.path)
    }
  }

  /**
   * Recover or continue work: retry setup from the first failed/interrupted
   * command, or run the remaining commands. Preserves the worktree.
   *
   * The executed snapshot is derived from the persisted per-command records so
   * a retry replays exactly what this worktree was created with, even when the
   * project-level defaults have since changed.
   */
  async runSetupFromFailure(
    target: ScopeTarget,
    options: { runSetup: boolean },
    progress?: (event: ScopeWorktreeProgress) => void
  ): Promise<ManagedWorktreeDescriptor> {
    return this.enqueue(target.projectId, async () => {
      const descriptor = this.requireManaged(target)
      const path = getScopeRootPath(target.projectId, descriptor.directoryName)
      if (!options.runSetup) {
        await this.propagateEnvironment(
          target.projectId,
          path,
          descriptor.environmentMode,
          progress
        )
        return descriptor
      }
      const records = descriptor.setup.commands
      const firstPending = records.findIndex((record) => record.state !== 'succeeded')
      if (records.length > 0 && firstPending === -1) {
        // Everything already succeeded; nothing left to retry.
        await this.propagateEnvironment(
          target.projectId,
          path,
          descriptor.environmentMode,
          progress
        )
        return descriptor
      }
      const startIndex = records.length === 0 ? 0 : Math.max(firstPending, 0)
      const commands: ScopeSetupCommandSpec[] =
        records.length > 0
          ? records.map((record) => ({ executable: record.executable, args: record.args }))
          : this.setupCommands(target.projectId)
      await this.runEnvironmentAndSetup(
        target.projectId,
        path,
        descriptor,
        commands,
        progress,
        records.length > 0 ? { startIndex } : undefined
      )
      return descriptor
    })
  }

  private requireManaged(target: ScopeTarget): ManagedWorktreeDescriptor {
    const board = this.scopes.getBoard(target.projectId)
    const bucket = board.buckets.find((candidate) => candidate.id === target.scopeBucketId)
    if (!bucket || bucket.root.kind !== 'worktree') {
      throw new Error(`Scope ${target.scopeBucketId} has no managed worktree`)
    }
    return bucket.root
  }

  /** Copy or symlink eligible root-level environment files into the worktree. */
  private async propagateEnvironment(
    projectId: string,
    worktreePath: string,
    mode: ScopeEnvironmentMode,
    progress?: (event: ScopeWorktreeProgress) => void
  ): Promise<void> {
    await propagateEnvironmentFiles(this.projects, projectId, worktreePath, mode, progress)
  }

  /**
   * Propagate environment files, then run ordered setup commands sequentially.
   * When resuming, `resume.startIndex` skips already-succeeded commands and
   * their records are carried into the persisted status.
   */
  private async runEnvironmentAndSetup(
    projectId: string,
    worktreePath: string,
    descriptor: ManagedWorktreeDescriptor,
    commands: ScopeSetupCommandSpec[],
    progress?: (event: ScopeWorktreeProgress) => void,
    resume?: { startIndex: number }
  ): Promise<void> {
    await runEnvironmentAndSetupCommands(
      this.scopes,
      this.projects,
      projectId,
      worktreePath,
      descriptor,
      commands,
      progress,
      resume
    )
  }

  private setupCommands(projectId: string): ScopeSetupCommandSpec[] {
    return this.scopes.getBoard(projectId).worktreeDefaults.setupCommands
  }

  /** Compute health for a managed scope's worktree. */
  async health(target: ScopeTarget): Promise<ScopeWorktreeHealth> {
    return this.healthInspector.health(target)
  }

  /**
   * Repair an unhealthy managed scope according to its health category:
   * unlock locked registrations, prune stale ones, restore missing checkouts
   * from their managed branch, move relocated checkouts back under the config
   * root, and re-checkout a switched branch. A re-created checkout is
   * reconciled afterwards (environment files re-propagated, recorded setup
   * marked stale) so the scope is not left claiming a prepared environment it
   * no longer has. Returns the fresh health state.
   */
  async repair(target: ScopeTarget): Promise<ScopeWorktreeHealth> {
    return this.enqueue(target.projectId, async () => this.healthInspector.repair(target))
  }

  /**
   * Preview whether an absolute path can be adopted as a managed scope root:
   * it must be a registered, non-bare worktree of this repository on a named
   * branch, and must not be the main project checkout itself.
   */
  async detectAdoptable(projectId: string, sourcePath: string): Promise<AdoptableWorktreeInfo> {
    const project = await this.requireLocalProject(projectId)
    const normalized = normalizeAdoptSourcePath(sourcePath)
    let registrations: WorktreeRegistration[]
    try {
      registrations = await this.listWorktrees(project.path)
    } catch (cause) {
      throw new Error(
        `Git worktree discovery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause }
      )
    }
    const entry = registrations.find((registration) => registration.path === normalized)
    if (!entry) {
      return {
        registered: false,
        detached: false,
        adoptable: false,
        reason: 'This path is not a Git worktree registered under the project repository'
      }
    }
    // Compare against the resolved repository root so symlinked paths
    // (`/var` vs `/private/var`) still identify the main checkout.
    const repoRoot = resolveRepositoryRoot(project.path)
    if (entry.path === repoRoot) {
      return {
        registered: true,
        detached: entry.head === undefined,
        path: entry.path,
        ...(entry.head ? { branch: branchNameOf(entry.head) } : {}),
        adoptable: false,
        reason: 'The main project checkout cannot be adopted'
      }
    }
    if (!entry.head) {
      return {
        registered: true,
        detached: true,
        path: entry.path,
        adoptable: false,
        reason: 'Detached-HEAD worktrees cannot be adopted; check out a branch first'
      }
    }
    return {
      registered: true,
      detached: false,
      path: entry.path,
      branch: branchNameOf(entry.head),
      adoptable: true
    }
  }

  /**
   * Adopt an existing raw Git worktree as a managed scope root: its checkout
   * is moved beneath the canonical config-root location via `git worktree
   * move`, then attached to the scope with environment propagation and an
   * optional setup run   exactly like a freshly created managed worktree.
   */
  async adoptWorktree(
    target: ScopeTarget,
    input: { sourcePath: string; runSetup: boolean },
    progress?: (event: ScopeWorktreeProgress) => void
  ): Promise<ManagedWorktreeDescriptor> {
    return this.enqueue(target.projectId, async () => {
      progress?.({ stage: 'discovering-repository' })
      const project = await this.requireLocalProject(target.projectId)
      const board = this.scopes.getBoard(target.projectId)
      const bucket = board.buckets.find((candidate) => candidate.id === target.scopeBucketId)
      if (!bucket || bucket.root.kind === 'worktree') {
        throw new Error('Choose a scope that does not already own a worktree')
      }
      const info = await this.detectAdoptable(target.projectId, input.sourcePath)
      if (!info.adoptable || !info.branch || !info.path) {
        throw new Error(info.reason ?? 'This checkout cannot be adopted')
      }
      for (const candidate of board.buckets) {
        if (candidate.root.kind === 'worktree' && candidate.root.branch === info.branch) {
          throw new Error(`Branch ${info.branch} is already managed by scope "${candidate.name}"`)
        }
      }

      progress?.({ stage: 'naming' })
      const directoryName = await this.deriveDirectoryNameForBranch(
        target.projectId,
        project.path,
        info.branch
      )
      const destination = getScopeRootPath(target.projectId, directoryName)

      progress?.({ stage: 'creating-worktree', detail: info.branch })
      await ensureParentDir(destination)
      try {
        await runGit(['worktree', 'move', info.path, destination], {
          cwd: project.path,
          timeoutMs: 120_000
        })
      } catch (error) {
        await rm(destination, { recursive: true, force: true }).catch(() => undefined)
        throw error instanceof Error ? error : new Error(String(error))
      }

      const defaults = this.scopes.getBoard(target.projectId).worktreeDefaults
      const metadata = await adoptionMetadata(project.path, info.branch).catch(() => ({
        baseBranch: '',
        baseCommit: ''
      }))
      const descriptor: ManagedWorktreeDescriptor = {
        kind: 'worktree',
        directoryName,
        branch: info.branch,
        ...metadata,
        createdAt: Date.now(),
        environmentMode: defaults.environmentMode,
        setup: { state: 'not_run', commands: [] }
      }
      progress?.({ stage: 'persisting-association' })
      this.scopes.attachManagedRoot(target.projectId, target.scopeBucketId, descriptor)

      if (input.runSetup && defaults.setupCommands.length > 0) {
        await this.runEnvironmentAndSetup(
          target.projectId,
          destination,
          descriptor,
          defaults.setupCommands.map((command) => ({ ...command })),
          progress
        )
      } else {
        await this.propagateEnvironment(
          target.projectId,
          destination,
          descriptor.environmentMode,
          progress
        )
      }

      progress?.({ stage: 'done' })
      return descriptor
    })
  }

  /** Collision-safe config-root directory name derived from an existing branch. */
  private async deriveDirectoryNameForBranch(
    projectId: string,
    repoPath: string,
    branch: string
  ): Promise<string> {
    const base = this.slugify(branch.replace(/^cio\//u, '')) || 'adopted'
    const existing = await distinctExistingNames(repoPath)
    const persisted = this.persistedDirectories(projectId)
    for (let candidate = 0; ; candidate += 1) {
      const suffix = candidate === 0 ? '' : `-${candidate + 1}`
      const directoryName = `${base}${suffix}`
      if (persisted.has(directoryName)) continue
      if (existing.paths.has(getScopeRootPath(projectId, directoryName))) continue
      return directoryName
    }
  }

  private async requireLocalProject(projectId: string): Promise<{ id: string; path: string }> {
    const project = await this.projects.getProject(projectId)
    if (!project || project.source !== 'local' || !project.path) {
      throw new Error('Managed worktrees require a local project repository')
    }
    if (!isGitRepository(project.path)) {
      throw new Error(`${project.path} is not a Git repository`)
    }
    return { id: project.id, path: project.path }
  }

  /**
   * Compute a state-bound preflight snapshot for a destructive lifecycle
   * action and mint a single-use confirmation token.
   */
  async preflight(
    action: PreflightSnapshot['action'],
    target: ScopeTarget
  ): Promise<ScopeLifecyclePreflight> {
    return this.enqueue(target.projectId, async () => {
      const descriptor = this.requireManaged(target)
      const worktreePath = getScopeRootPath(target.projectId, descriptor.directoryName)
      const project = await this.projects.getProject(target.projectId)
      const repoPath = project?.path

      const snapshot = await this.computeLifecycleSnapshot(
        target,
        worktreePath,
        descriptor.branch,
        repoPath
      )
      const record: PreflightSnapshot = {
        action,
        target,
        ...snapshot,
        token: randomBytes(16).toString('hex'),
        createdAt: Date.now()
      }
      this.preflights.set(record.token, record)
      return {
        action: record.action,
        projectId: target.projectId,
        scopeBucketId: target.scopeBucketId,
        dirtyFiles: [...record.dirtyFiles],
        unpushedCommits: record.unpushedCommits,
        hasActiveProcesses: record.hasActiveProcesses,
        branchOwnedByWorktree: record.branchOwnedByWorktree,
        confirmationId: record.token,
        createdAt: record.createdAt
      }
    })
  }

  /**
   * Read what a destructive action on this scope would discard, without minting
   * a confirmation token. The agent-facing scope tool shows this before the user
   * decides; `preflight` mints the single-use token from the same computation,
   * so the challenge a user sees and the state the token is bound to agree.
   */
  async lifecycleSnapshot(target: ScopeTarget): Promise<ScopeLifecycleSnapshot> {
    return this.enqueue(target.projectId, async () => {
      const descriptor = this.requireManaged(target)
      const worktreePath = getScopeRootPath(target.projectId, descriptor.directoryName)
      const project = await this.projects.getProject(target.projectId)
      return await this.computeLifecycleSnapshot(
        target,
        worktreePath,
        descriptor.branch,
        project?.path
      )
    })
  }

  /** One snapshot computation shared by the token-minting and read-only paths. */
  private async computeLifecycleSnapshot(
    target: ScopeTarget,
    worktreePath: string,
    branch: string,
    repoPath: string | undefined
  ): Promise<ScopeLifecycleSnapshot> {
    const dirtyWorktreeFiles = await dirtyFiles(repoPath, worktreePath)
    const unpushedCommits = await unpushedCount(repoPath, branch, worktreePath)
    const branchOwnedByWorktree = await managedBranchRegisteredAt(
      (repoPath) => this.listWorktrees(repoPath),
      repoPath ?? worktreePath,
      worktreePath,
      branch
    )
    const hasActiveProcesses =
      (await this.activeProcesses?.hasActiveProcessesFor(target.projectId, target.scopeBucketId)) ??
      false
    return {
      dirtyFiles: dirtyWorktreeFiles,
      unpushedCommits,
      branchOwnedByWorktree,
      hasActiveProcesses
    }
  }

  /** Consume a confirmation token bound to its snapshot. Returns null when stale. */
  private consumeConfirmation(token: string): PreflightSnapshot | null {
    const snapshot = this.preflights.get(token)
    if (!snapshot || Date.now() - snapshot.createdAt > 10 * 60 * 1000) {
      this.preflights.delete(token)
      return null
    }
    this.preflights.delete(token)
    return snapshot
  }

  /**
   * Guarded lifecycle mutations that consume a valid, freshly-computed
   * confirmation token. Throws when the token is stale or dirty/pushed state
   * changed since the snapshot was minted.
   */
  /**
   * Consume a detach token: remove the checkout and re-point the scope at the
   * project directory while keeping its branch, threads and appearance. The
   * confirmed force flag is what the renderer's second confirmation unlocks,
   * and it is passed through to Git so a confirmed detach of a checkout with
   * uncommitted work cannot silently leave the directory behind.
   */
  async confirmDetach(target: ScopeTarget, token: string, force = false): Promise<void> {
    await this.enqueue(target.projectId, async () => {
      const snapshot = this.requireFreshSnapshot(token, target, 'detach')
      const descriptor = this.requireManaged(target)
      const worktreePath = getScopeRootPath(target.projectId, descriptor.directoryName)
      const project = await this.projects.getProject(target.projectId)
      const repoPath = project?.path

      if (!force && (snapshot.dirtyFiles.length > 0 || snapshot.unpushedCommits > 0)) {
        throw new Error(
          'Cannot detach a worktree with uncommitted or unpushed work; confirm the forced detach first'
        )
      }
      await runRepairStep(
        force
          ? ['worktree', 'remove', '--force', worktreePath]
          : ['worktree', 'remove', worktreePath],
        repoPath ?? worktreePath,
        'The worktree directory could not be removed, so the scope was left attached to it.',
        120_000
      )
      this.scopes.detachManagedRoot(target.projectId, target.scopeBucketId)
    })
  }

  async confirmRemoveWorktree(target: ScopeTarget, token: string, force: boolean): Promise<void> {
    await this.enqueue(target.projectId, async () => {
      this.requireFreshSnapshot(token, target, 'remove-worktree')
      const descriptor = this.requireManaged(target)
      const worktreePath = getScopeRootPath(target.projectId, descriptor.directoryName)
      const project = await this.projects.getProject(target.projectId)
      const repoPath = project?.path

      const nowDirty = await dirtyFiles(repoPath, worktreePath)
      const nowUnpushed = await unpushedCount(repoPath, descriptor.branch, worktreePath)
      if (nowDirty.length > 0 || nowUnpushed > 0) {
        if (!force) {
          throw new Error(
            'Refusing to remove a worktree with dirty or unpushed work; force removal requires a separate confirmation'
          )
        }
      }

      await runGit(['worktree', 'remove', '--force', worktreePath], {
        cwd: repoPath ?? worktreePath,
        timeoutMs: 120_000
      })
      this.scopes.deleteBucket(target.projectId, target.scopeBucketId)
    })
  }

  /**
   * Consume a delete-scope token and fully remove a managed scope: the
   * worktree checkout, the scope bucket, and   unless `deleteBranch` is false
   *   the `cio/` branch. This is the single destructive entry point for
   * deleting a worktree-backed scope (the renderer handles the thread choice,
   * delete or move to Default, before calling it). Always forceful: the user
   * already confirmed the preflight that reported dirty/unpushed work.
   */
  async confirmDeleteScope(
    target: ScopeTarget,
    token: string,
    deleteBranch: boolean
  ): Promise<void> {
    await this.enqueue(target.projectId, async () => {
      this.requireFreshSnapshot(token, target, 'delete-scope')
      const descriptor = this.requireManaged(target)
      const project = await this.projects.getProject(target.projectId)
      const repoPath = project?.path
      await removeManagedWorktree(
        target,
        descriptor,
        repoPath ?? getScopeRootPath(target.projectId, descriptor.directoryName)
      )
      if (deleteBranch && repoPath) {
        await runGit(['branch', '-D', descriptor.branch], {
          cwd: repoPath,
          timeoutMs: 60_000
        }).catch((cause) => {
          const detail = cause instanceof Error ? cause.message : String(cause)
          Logger.error(`Branch removal during scope deletion failed: ${detail}`)
        })
      }
      this.scopes.deleteBucket(target.projectId, target.scopeBucketId)
    })
  }

  async confirmDeleteBranch(target: ScopeTarget, token: string): Promise<void> {
    await this.enqueue(target.projectId, async () => {
      this.requireFreshSnapshot(token, target, 'delete-branch')
      const descriptor = this.requireManaged(target)
      const project = await this.projects.getProject(target.projectId)
      if (!project) throw new Error('Project not found')

      // Git refuses `branch -D` while the branch is checked out in a worktree,
      // so remove the owning worktree first; deletion is one confirmed action.
      const worktreePath = getScopeRootPath(target.projectId, descriptor.directoryName)
      try {
        await runGitChecked(['worktree', 'remove', worktreePath], {
          cwd: project.path,
          timeoutMs: 120_000
        })
      } catch {
        // The directory is already gone or the registration is stale   prune
        // clears dead metadata; a live dirty worktree keeps blocking below.
        await runGit(['worktree', 'prune'], { cwd: project.path, timeoutMs: 60_000 }).catch(
          () => undefined
        )
      }

      try {
        await runGitChecked(['branch', '-D', descriptor.branch], {
          cwd: project.path,
          timeoutMs: 60_000
        })
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause)
        throw new Error(
          `Branch could not be deleted because it is still checked out in a worktree with uncommitted changes. Remove that worktree first. (${detail})`,
          { cause }
        )
      }
      this.scopes.deleteBucket(target.projectId, target.scopeBucketId)
    })
  }

  async confirmDeleteProjectWorktrees(projectId: string, token: string): Promise<void> {
    await this.enqueue(projectId, async () => {
      this.requireFreshSnapshot(
        token,
        { projectId, scopeBucketId: 'default' },
        'delete-project-worktrees'
      )
      const board = this.scopes.getBoard(projectId)
      const managed = board.buckets.filter((bucket) => bucket.root.kind === 'worktree')
      const project = await this.projects.getProject(projectId)
      for (const bucket of managed) {
        if (bucket.root.kind !== 'worktree') continue
        const worktreePath = getScopeRootPath(projectId, bucket.root.directoryName)
        await runGit(['worktree', 'remove', '--force', worktreePath], {
          cwd: project?.path ?? worktreePath,
          timeoutMs: 120_000
        }).catch((error) => {
          Logger.error(
            `Worktree removal during project deletion failed: ${error instanceof Error ? error.message : String(error)}`
          )
        })
      }
    })
  }

  // ─── Merge a managed scope back into another scope ───────────────────────

  /**
   * Compute a state-bound preflight for merging a managed scope into another
   * scope (Default by default) and mint a single-use confirmation token.
   * Describes the branch being merged, the target branch, the threads that
   * will be deleted or moved, and the work that would be discarded in the
   * delete modes.
   */
  async mergePreflight(
    target: ScopeTarget,
    mergeTarget: ScopeTarget,
    mode: ScopeMergeMode
  ): Promise<ScopeMergePreflight> {
    return this.enqueue(target.projectId, async () => {
      const descriptor = this.requireManaged(target)
      assertDistinctMergeTarget(target, mergeTarget)
      const sourcePath = getScopeRootPath(target.projectId, descriptor.directoryName)
      const project = await this.projects.getProject(target.projectId)
      const repoPath = project?.path
      const targetRoot = await resolveMergeTargetRoot(this.scopes, mergeTarget, repoPath)
      const dirtyWorktreeFiles = await dirtyFiles(repoPath, sourcePath)
      const unpushedCommits = await unpushedCount(repoPath, descriptor.branch, sourcePath)
      const hasActiveProcesses =
        (await this.activeProcesses?.hasActiveProcessesFor(
          target.projectId,
          target.scopeBucketId
        )) ?? false
      const threadCount =
        (await this.scopeThreads?.countThreadsInScope(target.projectId, target.scopeBucketId)) ?? 0
      const snapshot: MergePreflightSnapshot = {
        target,
        mergeTarget,
        mode,
        descriptor,
        sourcePath,
        targetBranch: targetRoot.branch,
        threadCount,
        dirtyFiles: dirtyWorktreeFiles,
        unpushedCommits,
        hasActiveProcesses,
        token: randomBytes(16).toString('hex'),
        createdAt: Date.now()
      }
      this.mergePreflights.set(snapshot.token, snapshot)
      return {
        sourceProjectId: target.projectId,
        sourceScopeBucketId: target.scopeBucketId,
        mergeTargetScopeBucketId: mergeTarget.scopeBucketId,
        sourceBranch: descriptor.branch,
        targetBranch: snapshot.targetBranch,
        threadCount: snapshot.threadCount,
        dirtyFiles: [...snapshot.dirtyFiles],
        unpushedCommits: snapshot.unpushedCommits,
        hasActiveProcesses: snapshot.hasActiveProcesses,
        mode,
        confirmationId: snapshot.token,
        createdAt: snapshot.createdAt
      }
    })
  }

  /**
   * Consume the merge confirmation token and apply the merge plus the selected
   * post-merge disposition. The git merge runs inside the merge target scope's
   * root. A conflict aborts nothing and deletes nothing: the merge is left
   * in-progress in the target (standard Git-panel conflict handling) and the
   * renderer hands off to the conflict UI. A clean merge then applies the mode:
   *
   *  - `merge-keep`: leave the scope and its threads untouched.
   *  - `merge-delete`: delete the scope's threads, remove the worktree, delete
   *    the scope bucket and the `cio/` branch.
   *  - `merge-move-to-default`: move the scope's threads into the Default bucket
   *    (evicting older Default threads), then remove the worktree, bucket and
   *    branch.
   */
  async confirmMerge(
    target: ScopeTarget,
    mergeTarget: ScopeTarget,
    mode: ScopeMergeMode,
    token: string
  ): Promise<ScopeMergeOutcome> {
    return this.enqueue(target.projectId, async () => {
      const snapshot = this.requireFreshMergeSnapshot(token, target, mergeTarget, mode)
      const descriptor = snapshot.descriptor
      const project = await this.projects.getProject(target.projectId)
      const repoPath = project?.path ?? snapshot.sourcePath
      const targetRoot = await resolveMergeTargetRoot(this.scopes, mergeTarget, repoPath)

      // Re-check the destination is not mid-mutation before running the merge so
      // a stale token cannot collide with a worktree the user since touched.
      if (mergeTarget.scopeBucketId !== DEFAULT_SCOPE_BUCKET_ID) {
        const health = await this.health(mergeTarget)
        if (health.category !== 'healthy') {
          throw new Error(
            `The merge target worktree is not healthy (${health.category}); fix it before merging`
          )
        }
      }

      const outcome = await runIntoMerge(targetRoot.root, descriptor.branch)
      if (!outcome.merged) return outcome

      if (mode === 'merge-keep') {
        return { merged: true, conflicted: [] }
      }

      if (mode === 'merge-delete') {
        await this.scopeThreads?.deleteThreadsInScope(target.projectId, target.scopeBucketId)
      } else {
        await this.scopeThreads?.moveThreadsOutOfScope(target.projectId, target.scopeBucketId)
      }

      await removeManagedWorktree(target, descriptor, repoPath)
      await runGit(['branch', '-D', descriptor.branch], {
        cwd: repoPath,
        timeoutMs: 60_000
      }).catch((cause) => {
        const detail = cause instanceof Error ? cause.message : String(cause)
        throw new Error(`${descriptor.branch} could not be deleted after the merge: ${detail}`, {
          cause
        })
      })
      this.scopes.deleteBucket(target.projectId, target.scopeBucketId)
      return { merged: true, conflicted: [] }
    })
  }

  private requireFreshMergeSnapshot(
    token: string,
    target: ScopeTarget,
    mergeTarget: ScopeTarget,
    mode: ScopeMergeMode
  ): MergePreflightSnapshot {
    const snapshot = this.mergePreflights.get(token)
    if (!snapshot || Date.now() - snapshot.createdAt > 10 * 60 * 1000) {
      this.mergePreflights.delete(token)
      throw new Error('Confirmation token is stale; run preflight again')
    }
    this.mergePreflights.delete(token)
    if (
      snapshot.target.projectId !== target.projectId ||
      snapshot.target.scopeBucketId !== target.scopeBucketId ||
      snapshot.mergeTarget.projectId !== mergeTarget.projectId ||
      snapshot.mergeTarget.scopeBucketId !== mergeTarget.scopeBucketId ||
      snapshot.mode !== mode
    ) {
      throw new Error('Confirmation token does not match the requested merge')
    }
    return snapshot
  }

  private requireFreshSnapshot(
    token: string,
    target: ScopeTarget,
    action: PreflightSnapshot['action']
  ): PreflightSnapshot {
    const snapshot = this.consumeConfirmation(token)
    if (!snapshot) throw new Error('Confirmation token is stale; run preflight again')
    if (snapshot.action !== action) {
      throw new Error(`Confirmation token was for ${snapshot.action}, not ${action}`)
    }
    if (
      snapshot.target.projectId !== target.projectId ||
      snapshot.target.scopeBucketId !== target.scopeBucketId
    ) {
      throw new Error('Confirmation token does not match the target scope')
    }
    return snapshot
  }
}
