import { copyFile, mkdir, readdir, realpath, rename, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type {
  ManagedWorktreeDescriptor,
  ScopeEnvironmentMode,
  ScopeLifecyclePreflight,
  ScopeSetupCommandRecord,
  ScopeSetupCommandSpec,
  ScopeTarget,
  ScopeWorktreeHealth
} from '../../lib/types'
import { getScopeRootPath } from '../../lib/utils'
import { ScopeManager } from '../../lib/engines/scope-manager'
import { ProjectManager } from '../../lib/engines/project-manager'
import { runGit, runSetupCommand } from './scope-worktree-process'
import type {
  ManagedWorktreeInspector,
  WorktreeRegistration
} from '../workspaces/scope-root-resolver'
import { Logger } from '../system/logger'

const WORKTREE_BRANCH_PREFIX = 'cio/'
const SLUG_LIMIT = 48

/** Minimal structural view of an agent process that may hold worktree files. */
export interface ActiveProcessProbe {
  hasActiveProcessesFor(projectId: string): Promise<boolean> | boolean
}

export interface ScopeWorktreeServiceOptions {
  activeProcesses?: ActiveProcessProbe
}

/** Negotiable progress events emitted to the initiating renderer. */
export interface ScopeWorktreeProgress {
  stage:
    | 'discovering-repository'
    | 'naming'
    | 'creating-worktree'
    | 'persisting-association'
    | 'environment'
    | 'setup'
    | 'done'
    | 'failed'
    | 'interrupted'
  detail?: string
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

interface ParsedPorcelainEntry {
  path: string
  head?: string
  bare: boolean
  detached: boolean
  locked: boolean
  prunable: boolean
}

export interface ParsedWorktreeList {
  entries: ParsedPorcelainEntry[]
}

/**
 * Parse `git worktree list --porcelain -z`. With `-z` every field is
 * NUL-terminated and records are separated by an extra NUL, so we split on NUL
 * and group tokens, closing each record at every empty separator.
 *
 * Field forms:
 *   `worktree <path>`      absolute path
 *   `HEAD <sha>`           commit hash (or `detached`)
 *   `branch <ref>`         e.g. `refs/heads/cio/feature` (absent when detached)
 *   `bare` / `detached` / `prunable`
 *   `locked`               optionally followed by a NUL-terminated reason
 */
export function parseWorktreePorcelain(output: string): ParsedWorktreeList {
  const entries: ParsedPorcelainEntry[] = []
  let current: ParsedPorcelainEntry | null = null

  const flush = (): void => {
    if (current) entries.push(current)
    current = null
  }

  for (const token of output.split('\0')) {
    if (!token) {
      flush()
      continue
    }
    if (!current)
      current = { path: '', bare: false, detached: false, locked: false, prunable: false }
    if (token === 'bare') {
      current.bare = true
      continue
    }
    if (token === 'detached') {
      current.detached = true
      continue
    }
    if (token === 'prunable') {
      current.prunable = true
      continue
    }
    if (token.startsWith('locked')) {
      current.locked = true
      continue
    }
    if (token.startsWith('worktree ')) {
      current.path = token.slice('worktree '.length)
      continue
    }
    if (token.startsWith('branch ')) {
      // Resolution needs the checked-out branch, not the HEAD commit.
      current.head = token.slice('branch '.length)
      continue
    }
    // `HEAD <sha>` and `reason <text>` tokens carry no branch identity.
  }
  flush()
  return { entries }
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
  private readonly activeProcesses?: ActiveProcessProbe

  constructor(
    private scopes: ScopeManager,
    private projects: Pick<ProjectManager, 'getProject'>,
    options: ScopeWorktreeServiceOptions = {}
  ) {
    this.activeProcesses = options.activeProcesses
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
    const output = await runGit(['worktree', 'list', '--porcelain', '-z'], { cwd: repoPath })
    return parseWorktreePorcelain(output).entries.map((entry) => ({
      path: entry.path,
      head: entry.head,
      locked: entry.locked,
      prunable: entry.prunable
    }))
  }

  /**
   * Detect tracked submodules: the index stores submodules as gitlink entries
   * with mode 160000. `.gitmodules` alone is not authoritative (a stale file
   * can outlive its gitlinks), so we read the staged index instead.
   */
  private async hasTrackedSubmodules(repoPath: string): Promise<boolean> {
    try {
      const output = await runGit(['ls-files', '--stage', '-z'], { cwd: repoPath })
      return output
        .split('\0')
        .some(
          (record) => record.startsWith('160000 ') || record.split(':')[1]?.startsWith('160000 ')
        )
    } catch {
      return false
    }
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

  private async currentBranchAndCommit(repoPath: string): Promise<{
    branch: string
    commit: string
  }> {
    const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath })).trim()
    if (branch === 'HEAD') {
      throw new Error('Managed worktrees require a named current branch (detached HEAD)')
    }
    const commit = (await runGit(['rev-parse', 'HEAD'], { cwd: repoPath })).trim()
    return { branch, commit }
  }

  private async distinctExistingNames(
    repoPath: string
  ): Promise<{ branches: Set<string>; paths: Set<string> }> {
    const branches = new Set<string>()
    const paths = new Set<string>()
    const output = await runGit(['worktree', 'list', '--porcelain', '-z'], { cwd: repoPath })
    for (const entry of parseWorktreePorcelain(output).entries) {
      paths.add(entry.path)
      if (entry.head) branches.add(entry.head)
    }
    return { branches, paths }
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
    const existing = await this.distinctExistingNames(repoPath)
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
   */
  async createManagedWorktree(
    target: ScopeTarget,
    input: { title: string; runSetup: boolean; environmentMode: ScopeEnvironmentMode },
    progress?: (event: ScopeWorktreeProgress) => void
  ): Promise<ManagedWorktreeDescriptor> {
    return this.enqueue(target.projectId, async () => {
      const project = await this.projects.getProject(target.projectId)
      if (!project || project.source !== 'local' || !project.path) {
        throw new Error('Managed worktrees require a local project repository')
      }
      const repoPath = project.path

      progress?.({ stage: 'discovering-repository' })
      if (!this.ensureRepo(repoPath)) {
        throw new Error(`${repoPath} is not a Git repository`)
      }
      if (await this.hasTrackedSubmodules(repoPath)) {
        progress?.({ stage: 'failed', detail: 'submodules' })
        throw new Error(
          'Repositories with tracked submodules are not supported for managed worktrees in this release'
        )
      }

      const { branch: baseBranch, commit: baseCommit } = await this.currentBranchAndCommit(repoPath)
      const {
        directoryName,
        branch: createdBranch,
        path
      } = await this.deriveNames(target.projectId, repoPath, input.title, progress)

      progress?.({ stage: 'creating-worktree', detail: createdBranch })
      await ensureParentDir(path)
      await runGit(['worktree', 'add', '-b', createdBranch, path, baseCommit], {
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
        baseBranch,
        baseCommit,
        createdAt: Date.now(),
        environmentMode: input.environmentMode,
        setup: { state: 'not_run', commands: [] }
      }
      progress?.({ stage: 'persisting-association' })
      this.scopes.attachManagedRoot(target.projectId, bucketId, descriptor)

      if (input.runSetup) {
        await this.runEnvironmentAndSetup(target.projectId, path, descriptor, progress)
      } else {
        await this.propagateEnvironment(target.projectId, path, input.environmentMode, progress)
      }

      progress?.({ stage: 'done' })
      return descriptor
    })
  }

  /**
   * Recover or continue work: retry setup from the first failed/interrupted
   * command, or run the remaining commands. Preserves the worktree.
   */
  async runSetupFromFailure(
    target: ScopeTarget,
    options: { runSetup: boolean },
    progress?: (event: ScopeWorktreeProgress) => void
  ): Promise<ManagedWorktreeDescriptor> {
    return this.enqueue(target.projectId, async () => {
      const descriptor = this.requireManaged(target)
      const path = getScopeRootPath(target.projectId, descriptor.directoryName)
      const updated = {
        ...descriptor,
        environmentMode: descriptor.environmentMode
      }
      if (options.runSetup) {
        await this.runEnvironmentAndSetup(target.projectId, path, updated, progress)
      } else {
        await this.propagateEnvironment(
          target.projectId,
          path,
          descriptor.environmentMode,
          progress
        )
      }
      return updated
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
    const project = await this.projects.getProject(projectId)
    if (!project || project.source !== 'local') return
    progress?.({ stage: 'environment' })
    const files = await discoverEnvironmentFiles(project.path)
    for (const filename of files) {
      const source = join(project.path, filename)
      const target = join(worktreePath, filename)
      if (existsSync(target)) continue
      if (mode === 'symlink') {
        await symlinkFile(source, target)
      } else {
        await copyFileAtomic(source, target)
      }
    }
  }

  /** Propagate environment files, then run ordered setup commands sequentially. */
  private async runEnvironmentAndSetup(
    projectId: string,
    worktreePath: string,
    descriptor: ManagedWorktreeDescriptor,
    progress?: (event: ScopeWorktreeProgress) => void
  ): Promise<void> {
    await this.propagateEnvironment(projectId, worktreePath, descriptor.environmentMode, progress)

    const commands = this.setupCommands(projectId)
    progress?.({ stage: 'setup', detail: '0' })

    const records: ScopeSetupCommandRecord[] = []
    const startedAt = Date.now()
    this.scopes.attachManagedRoot(projectId, this.bucketIdFor(projectId, descriptor), {
      ...descriptor,
      setup: { state: 'running', commands: [], startedAt }
    })

    for (let index = 0; index < commands.length; index += 1) {
      const spec = commands[index]!
      const record: ScopeSetupCommandRecord = {
        index,
        executable: spec.executable,
        args: spec.args,
        state: 'running',
        startedAt: Date.now()
      }
      records.push(record)
      progress?.({ stage: 'setup', detail: String(index + 1) })
      let result
      try {
        result = await runSetupCommand(spec, { cwd: worktreePath })
      } catch (error) {
        // Missing executable or spawn failure: mark interrupted/preserve.
        records[index] = { ...record, state: 'interrupted', finishedAt: Date.now() }
        this.scopes.attachManagedRoot(projectId, this.bucketIdFor(projectId, descriptor), {
          ...descriptor,
          setup: { state: 'interrupted', commands: records, startedAt, finishedAt: Date.now() }
        })
        throw error
      }
      records[index] = {
        ...record,
        state: result.exitCode === 0 ? 'succeeded' : 'failed',
        exitCode: result.exitCode,
        finishedAt: Date.now()
      }
      if (result.exitCode !== 0) {
        this.scopes.attachManagedRoot(projectId, this.bucketIdFor(projectId, descriptor), {
          ...descriptor,
          setup: {
            state: 'failed',
            commands: records.map((entry) => ({ ...entry })),
            startedAt,
            finishedAt: Date.now()
          }
        })
        progress?.({ stage: 'failed', detail: spec.executable })
        throw new Error(`Setup command ${index + 1} failed (${spec.executable})`)
      }
    }

    this.scopes.attachManagedRoot(projectId, this.bucketIdFor(projectId, descriptor), {
      ...descriptor,
      setup: {
        state: 'succeeded',
        commands: records.map((entry) => ({ ...entry })),
        startedAt,
        finishedAt: Date.now()
      }
    })
    progress?.({ stage: 'done' })
  }

  private bucketIdFor(projectId: string, descriptor: ManagedWorktreeDescriptor): string {
    const board = this.scopes.getBoard(projectId)
    const bucket = board.buckets.find(
      (candidate) =>
        candidate.root.kind === 'worktree' &&
        candidate.root.directoryName === descriptor.directoryName
    )
    if (!bucket) throw new Error(`No bucket owns ${descriptor.directoryName}`)
    return bucket.id
  }

  private setupCommands(projectId: string): ScopeSetupCommandSpec[] {
    return this.scopes.getBoard(projectId).worktreeDefaults.setupCommands
  }

  private ensureRepo(path: string): boolean {
    return existsSync(join(path, '.git')) || existsSync(join(path, '.git', 'HEAD'))
  }

  /** Compute health for a managed scope's worktree. */
  async health(target: ScopeTarget): Promise<ScopeWorktreeHealth> {
    const descriptor = this.requireManaged(target)
    const project = await this.projects.getProject(target.projectId)
    if (!project || project.source !== 'local' || !project.path) {
      return { category: 'repository-unavailable', detail: 'Project repository is unavailable' }
    }
    const expectedPath = getScopeRootPath(target.projectId, descriptor.directoryName)
    if (!existsSync(expectedPath)) {
      return {
        category: 'missing',
        detail: 'The managed checkout directory is missing',
        expectedPath
      }
    }
    let registrations: WorktreeRegistration[]
    try {
      registrations = await this.listWorktrees(project.path)
    } catch (error) {
      return {
        category: 'repository-unavailable',
        detail: error instanceof Error ? error.message : 'Discovery failed',
        expectedPath
      }
    }
    const entry = registrations.find((registration) => registration.path === expectedPath)
    if (!entry) {
      const relocated = registrations.find(
        (registration) => registration.head === `refs/heads/${descriptor.branch}`
      )
      return {
        category: relocated ? 'path-mismatch' : 'unregistered',
        expectedPath,
        ...(relocated ? { actualPath: relocated.path } : {})
      }
    }
    if (entry.prunable) return { category: 'prunable', expectedPath }
    if (entry.locked) return { category: 'locked', expectedPath }
    if (entry.head !== undefined && entry.head !== `refs/heads/${descriptor.branch}`) {
      return { category: 'branch-mismatch', expectedPath, actualPath: entry.path }
    }
    return { category: 'healthy', expectedPath }
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

      const dirtyFiles = await this.dirtyFiles(repoPath, worktreePath)
      const unpushedCommits = await this.unpushedCount(repoPath)
      const hasActiveProcesses =
        (await this.activeProcesses?.hasActiveProcessesFor(target.projectId)) ?? false

      const snapshot: PreflightSnapshot = {
        action,
        target,
        dirtyFiles,
        unpushedCommits,
        hasActiveProcesses,
        branchOwnedByWorktree: dirtyFiles.length > 0 || unpushedCommits > 0,
        token: randomBytes(16).toString('hex'),
        createdAt: Date.now()
      }
      this.preflights.set(snapshot.token, snapshot)
      return {
        action: snapshot.action,
        projectId: target.projectId,
        scopeBucketId: target.scopeBucketId,
        dirtyFiles: [...snapshot.dirtyFiles],
        unpushedCommits: snapshot.unpushedCommits,
        hasActiveProcesses: snapshot.hasActiveProcesses,
        branchOwnedByWorktree: snapshot.branchOwnedByWorktree,
        confirmationId: snapshot.token,
        createdAt: snapshot.createdAt
      }
    })
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

  private async dirtyFiles(repoPath: string | undefined, worktreePath: string): Promise<string[]> {
    if (!repoPath) return []
    try {
      const output = await runGit(['status', '--porcelain', '-z'], { cwd: worktreePath })
      const files: string[] = []
      const records = output.split('\0')
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index]
        if (!record) continue
        const code = record.slice(0, 2)
        const rest = record.slice(3)
        if (code === '??') files.push(`untracked: ${rest}`)
        else files.push(rest)
      }
      return files.slice(0, 200)
    } catch {
      return []
    }
  }

  private async unpushedCount(repoPath: string | undefined): Promise<number> {
    if (!repoPath) return 0
    try {
      const output = await runGit(['log', '--oneline', '--branches', '--not', '--remotes'], {
        cwd: repoPath,
        timeoutMs: 60_000
      })
      return output.trim() ? output.split('\n').length : 0
    } catch {
      return 0
    }
  }

  /**
   * Guarded lifecycle mutations that consume a valid, freshly-computed
   * confirmation token. Throws when the token is stale or dirty/pushed state
   * changed since the snapshot was minted.
   */
  async confirmDetach(target: ScopeTarget, token: string): Promise<void> {
    await this.enqueue(target.projectId, async () => {
      const snapshot = this.requireFreshSnapshot(token, target, 'detach')
      const descriptor = this.requireManaged(target)
      const worktreePath = getScopeRootPath(target.projectId, descriptor.directoryName)
      const project = await this.projects.getProject(target.projectId)
      const repoPath = project?.path

      if (snapshot.dirtyFiles.length > 0 || snapshot.unpushedCommits > 0) {
        throw new Error('Cannot detach a worktree with dirty or unpushed work; force required')
      }
      await runGit(['worktree', 'remove', worktreePath], {
        cwd: repoPath ?? worktreePath,
        timeoutMs: 120_000
      })
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

      const nowDirty = await this.dirtyFiles(repoPath, worktreePath)
      const nowUnpushed = await this.unpushedCount(repoPath)
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

  async confirmDeleteBranch(target: ScopeTarget, token: string): Promise<void> {
    await this.enqueue(target.projectId, async () => {
      this.requireFreshSnapshot(token, target, 'delete-branch')
      const descriptor = this.requireManaged(target)
      const project = await this.projects.getProject(target.projectId)
      if (!project) throw new Error('Project not found')
      await runGit(['branch', '-D', descriptor.branch], { cwd: project.path, timeoutMs: 60_000 })
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

function ensureParentDir(path: string): Promise<void> {
  return mkdir(join(path, '..'), { recursive: true }).then(() => undefined)
}

/** Discover untracked, regular, root-level `.env` and `.env.*` files. */
async function discoverEnvironmentFiles(repoPath: string): Promise<string[]> {
  const entries = await readdir(repoPath, { withFileTypes: true })
  const excluded = new Set(['.env.example', '.env.sample', '.env.template'])
  const files: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const name = entry.name
    if (excluded.has(name)) continue
    if (name === '.env' || name.startsWith('.env.')) files.push(name)
  }
  return files.sort()
}

/** Copy through a temporary file then rename (atomic, never overwrite). */
async function copyFileAtomic(source: string, target: string): Promise<void> {
  const tmpPath = `${target}.cio-${process.pid}-${randomBytes(6).toString('hex')}.tmp`
  await copyFile(source, tmpPath)
  await rename(tmpPath, target).catch(async (error) => {
    await rm(tmpPath, { force: true }).catch(() => undefined)
    throw error
  })
}

async function symlinkFile(source: string, target: string): Promise<void> {
  if (process.platform === 'win32') {
    throw new Error('Environment symlinks are not supported on Windows')
  }
  const realSource = await realpath(source)
  const { symlink } = await import('fs/promises')
  await symlink(realSource, target)
}
