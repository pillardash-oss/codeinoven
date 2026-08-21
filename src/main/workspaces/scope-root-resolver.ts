import { existsSync } from 'fs'
import {
  isManagedScopeRoot,
  type ManagedWorktreeDescriptor,
  type Project,
  type ScopeRootDescriptor,
  type ScopeTarget,
  type ScopeWorktreeHealth
} from '../../lib/types'
import { getScopeRootPath } from '../../lib/utils'

/** One registration reported by `git worktree list --porcelain`. */
export interface WorktreeRegistration {
  path: string
  /** Full HEAD ref (e.g. `refs/heads/cio/feature`) when not detached. */
  head?: string
  locked: boolean
  prunable: boolean
}

/**
 * Port the resolver uses to discover Git's view of a repository's worktrees.
 * Implemented by the managed worktree service; tests inject fakes.
 */
export interface ManagedWorktreeInspector {
  listWorktrees(repoPath: string): Promise<WorktreeRegistration[]>
}

export type ScopeResolution =
  | { ok: true; root: string; rootDescriptor: ScopeRootDescriptor }
  | { ok: false; health: ScopeWorktreeHealth }

/** Thrown instead of falling back when a managed scope root is unhealthy. */
export class ScopeRootUnavailableError extends Error {
  constructor(readonly health: ScopeWorktreeHealth) {
    super(`Managed scope root unavailable (${health.category}): ${health.detail ?? ''}`)
    this.name = 'ScopeRootUnavailableError'
  }
}

interface ProjectLookup {
  getProject(projectId: string): Promise<Project | null>
}

interface ScopeBoardLookup {
  getBoard(projectId: string): import('../../lib/types').ScopeBoard
}

/**
 * The single authority for converting a `{ projectId, scopeBucketId }` target
 * into a filesystem root. Project-rooted scopes resolve to the registered
 * project directory; managed scopes resolve only when Git confirms their
 * expected registration. Unhealthy managed scopes never fall back.
 */
export class ScopeRootResolver {
  constructor(
    private projects: ProjectLookup,
    private scopes: ScopeBoardLookup,
    private inspector?: ManagedWorktreeInspector
  ) {}

  async resolve(target: ScopeTarget): Promise<ScopeResolution> {
    const board = this.scopes.getBoard(target.projectId)
    const bucket = board.buckets.find((candidate) => candidate.id === target.scopeBucketId)
    if (!bucket) {
      return {
        ok: false,
        health: {
          category: 'unregistered',
          detail: `Unknown scope ${target.scopeBucketId} in project ${target.projectId}`
        }
      }
    }

    if (!isManagedScopeRoot(bucket.root)) {
      const project = await this.projects.getProject(target.projectId)
      if (!project || project.source !== 'local' || !project.path) {
        return {
          ok: false,
          health: {
            category: 'repository-unavailable',
            detail: `Project ${target.projectId} has no local directory`
          }
        }
      }
      return { ok: true, root: project.path, rootDescriptor: bucket.root }
    }

    return this.resolveManaged(target.projectId, bucket.root)
  }

  /** Resolve and throw a typed error when unhealthy (fail closed). */
  async requireRoot(target: ScopeTarget): Promise<string> {
    const resolution = await this.resolve(target)
    if (!resolution.ok) throw new ScopeRootUnavailableError(resolution.health)
    return resolution.root
  }

  private async resolveManaged(
    projectId: string,
    descriptor: ManagedWorktreeDescriptor
  ): Promise<ScopeResolution> {
    const expectedPath = getScopeRootPath(projectId, descriptor.directoryName)
    const fail = (health: ScopeWorktreeHealth): ScopeResolution => ({
      ok: false,
      health: { ...health, expectedPath }
    })

    const project = await this.projects.getProject(projectId)
    if (!project || project.source !== 'local' || !project.path) {
      return fail({
        category: 'repository-unavailable',
        detail: `Project ${projectId} has no local repository`
      })
    }

    if (!existsSync(expectedPath)) {
      return fail({
        category: 'missing',
        detail: `The managed checkout directory is missing`
      })
    }

    if (!this.inspector) {
      // Without an inspector we cannot confirm the registration; refuse
      // rather than risk operating on an unverified directory.
      return fail({
        category: 'unregistered',
        detail: 'Git worktree discovery is unavailable'
      })
    }

    let registrations: WorktreeRegistration[]
    try {
      registrations = await this.inspector.listWorktrees(project.path)
    } catch (error) {
      return fail({
        category: 'repository-unavailable',
        detail: error instanceof Error ? error.message : 'Git worktree discovery failed'
      })
    }

    const exact = registrations.find((entry) => entry.path === expectedPath)
    const expectedHead = `refs/heads/${descriptor.branch}`
    if (!exact) {
      // A registration on the expected branch but at another path means the
      // checkout moved; anything else is unregistered or prunable.
      const relocated = registrations.find((entry) => entry.head === expectedHead)
      if (relocated) {
        return fail({
          category: 'path-mismatch',
          detail: 'The worktree registration points at a different directory',
          actualPath: relocated.path
        })
      }
      const stale = registrations.find((entry) => entry.prunable)
      return fail(
        stale
          ? { category: 'prunable', detail: 'A stale worktree registration needs pruning' }
          : {
              category: 'unregistered',
              detail: 'Git does not register this managed checkout as a worktree'
            }
      )
    }
    if (exact.prunable) {
      return fail({ category: 'prunable', detail: 'Git reports this worktree as prunable' })
    }
    if (exact.locked) {
      return fail({ category: 'locked', detail: 'The worktree is locked by Git' })
    }
    if (exact.head !== undefined && exact.head !== expectedHead) {
      return fail({
        category: 'branch-mismatch',
        detail: `Expected ${descriptor.branch}; Git reports ${exact.head.replace('refs/heads/', '')}`,
        actualPath: exact.path
      })
    }

    return { ok: true, root: expectedPath, rootDescriptor: descriptor }
  }
}

/**
 * Adapter exposing the resolver as a `ThreadScopeRootProvider`. Unhealthy
 * managed scopes throw; only targets without a scope return null.
 */
export function scopeRootProvider(
  resolver: ScopeRootResolver
): import('../../lib/engines/thread-manager').ThreadScopeRootProvider {
  return {
    async resolveCompatibilityRoot(projectId: string, scopeBucketId?: string) {
      if (!scopeBucketId) return null
      const resolution = await resolver.resolve({ projectId, scopeBucketId })
      if (!resolution.ok) throw new ScopeRootUnavailableError(resolution.health)
      return resolution.root
    }
  }
}
