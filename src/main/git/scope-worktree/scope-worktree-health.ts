import { existsSync } from 'fs'
import type {
  ManagedWorktreeDescriptor,
  ScopeEnvironmentMode,
  ScopeSetupStatus,
  ScopeTarget,
  ScopeWorktreeHealth
} from '../../../lib/types'
import { getScopeRootPath } from '../../../lib/utils'
import type { ScopeManager } from '../../../lib/engines/scope-manager'
import type { ProjectManager } from '../../../lib/engines/project-manager'
import type { WorktreeRegistration } from '../../workspaces/scope-root-resolver'
import { Logger } from '../../system/logger'
import { runGitChecked } from '../scope-worktree-process'
import { ensureParentDir } from './scope-worktree-environment'
import { restoreCheckout, runRepairStep } from './scope-worktree-git'

export interface ScopeWorktreeHealthDeps {
  projects: Pick<ProjectManager, 'getProject'>
  scopes: ScopeManager
  requireManaged(target: ScopeTarget): ManagedWorktreeDescriptor
  listWorktrees(repoPath: string): Promise<WorktreeRegistration[]>
  propagateEnvironment(
    projectId: string,
    worktreePath: string,
    mode: ScopeEnvironmentMode
  ): Promise<void>
}

/**
 * Owns the health probe and repair flow for managed scope worktrees: unlock
 * locked registrations, prune stale ones, restore missing checkouts from their
 * managed branch, move relocated checkouts back under the config root, and
 * re-checkout a switched branch.
 */
export class ScopeWorktreeHealthInspector {
  constructor(private readonly deps: ScopeWorktreeHealthDeps) {}

  /** Compute health for a managed scope's worktree. */
  async health(target: ScopeTarget): Promise<ScopeWorktreeHealth> {
    const descriptor = this.deps.requireManaged(target)
    const project = await this.deps.projects.getProject(target.projectId)
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
      registrations = await this.deps.listWorktrees(project.path)
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
   * Repair an unhealthy managed scope according to its health category:
   * unlock locked registrations, prune stale ones, restore missing checkouts
   * from their managed branch, move relocated checkouts back under the config
   * root, and re-checkout a switched branch. A re-created checkout is
   * reconciled afterwards (environment files re-propagated, recorded setup
   * marked stale) so the scope is not left claiming a prepared environment it
   * no longer has. Returns the fresh health state.
   */
  async repair(target: ScopeTarget): Promise<ScopeWorktreeHealth> {
    const descriptor = this.deps.requireManaged(target)
    const expectedPath = getScopeRootPath(target.projectId, descriptor.directoryName)
    const project = await this.deps.projects.getProject(target.projectId)
    const repoPath = project?.source === 'local' && project.path ? project.path : undefined
    const gitCwd = repoPath ?? expectedPath
    const before = await this.health(target)
    let restoredCheckout = false
    switch (before.category) {
      case 'healthy':
        return before
      case 'repository-unavailable':
        throw new Error(before.detail ?? 'The project repository is unavailable')
      case 'locked':
        await runRepairStep(
          ['worktree', 'unlock', expectedPath],
          gitCwd,
          'The Git lock on this worktree could not be released.'
        )
        break
      case 'prunable': {
        await runGitChecked(['worktree', 'prune'], { cwd: gitCwd, timeoutMs: 120_000 }).catch(
          () => undefined
        )
        if (!existsSync(expectedPath)) {
          await restoreCheckout(gitCwd, expectedPath, descriptor.branch)
          restoredCheckout = true
        }
        break
      }
      case 'missing':
        await restoreCheckout(gitCwd, expectedPath, descriptor.branch)
        restoredCheckout = true
        break
      case 'path-mismatch':
        if (!before.actualPath) {
          throw new Error('Git did not report the relocated worktree path')
        }
        await ensureParentDir(expectedPath)
        await runRepairStep(
          ['worktree', 'move', before.actualPath, expectedPath],
          gitCwd,
          `The checkout at ${before.actualPath} could not be moved back under the app's project directory.`,
          120_000
        )
        break
      case 'branch-mismatch':
        await runRepairStep(
          ['checkout', descriptor.branch],
          expectedPath,
          `The checkout could not be switched back to ${descriptor.branch}. Commit or discard its changes, then repair it again.`,
          60_000
        )
        break
      case 'unregistered':
        // Relink registrations for directories that were moved manually.
        await runRepairStep(
          ['worktree', 'repair'],
          gitCwd,
          'Git could not relink this directory as a worktree.',
          120_000
        )
        break
    }
    if (restoredCheckout) await this.reconcileRestoredCheckout(target, expectedPath)
    return this.health(target)
  }

  /**
   * Reconcile a re-created checkout with what the app owes the scope. Git only
   * restores committed content, so propagated environment files and every
   * gitignored build artifact are gone: re-propagate the environment files and
   * mark the recorded setup as stale so the scope offers an explicit
   * "Re-run setup" instead of claiming a prepared environment it no longer has.
   */
  private async reconcileRestoredCheckout(
    target: ScopeTarget,
    worktreePath: string
  ): Promise<void> {
    const descriptor = this.deps.requireManaged(target)
    const project = await this.deps.projects.getProject(target.projectId)
    if (project?.source === 'local' && project.path) {
      try {
        await this.deps.propagateEnvironment(
          target.projectId,
          worktreePath,
          descriptor.environmentMode
        )
      } catch (cause) {
        // Re-running setup propagates the environment again, so a failed copy
        // here is logged and never fatal to the restore itself.
        const detail = cause instanceof Error ? cause.message : String(cause)
        Logger.error(`Environment propagation after a checkout restore failed: ${detail}`)
      }
    }
    // A scope whose setup never ran has nothing recorded to invalidate.
    if (descriptor.setup.commands.length === 0) return
    const setup: ScopeSetupStatus = {
      state: 'stale',
      commands: descriptor.setup.commands.map((record) => ({
        index: record.index,
        executable: record.executable,
        args: record.args,
        state: 'pending'
      })),
      ...(descriptor.setup.startedAt === undefined
        ? {}
        : { startedAt: descriptor.setup.startedAt }),
      ...(descriptor.setup.finishedAt === undefined
        ? {}
        : { finishedAt: descriptor.setup.finishedAt })
    }
    this.deps.scopes.attachManagedRoot(target.projectId, target.scopeBucketId, {
      ...descriptor,
      setup
    })
  }
}
