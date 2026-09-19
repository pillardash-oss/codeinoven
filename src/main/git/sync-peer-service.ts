import {
  DEFAULT_SCOPE_BUCKET_ID,
  isManagedScopeRoot,
  type GitBranchInfo,
  type GitSyncPeer,
  type GitSyncPeerOption,
  type GitSyncPeerTarget,
  type ScopeBoard,
  type ScopeBucket
} from '../../lib/types'
import { worktreePathKey } from './git/git-service-status'
import { scopeWorktreeUnavailableMessage } from '../../lib/scope-worktree-health'
import type { ScopeResolution } from '../workspaces/scope-root-resolver'

/** Git reads the peer service needs, satisfied by the shared `GitService`. */
export interface SyncPeerGit {
  listBranches(projectPath: string): Promise<GitBranchInfo[]>
  /** The branch a checkout has checked out, or null when its HEAD is detached. */
  statusBranch(projectPath: string): Promise<string | null>
}

/** Adapter so the desktop and the remote RPC contexts share one implementation. */
export function syncPeerGit(git: {
  listBranches(projectPath: string): Promise<GitBranchInfo[]>
  getStatus(projectPath: string): Promise<{ branch: string | null }>
}): SyncPeerGit {
  return {
    listBranches: (projectPath) => git.listBranches(projectPath),
    statusBranch: async (projectPath) => (await git.getStatus(projectPath)).branch
  }
}

export interface SyncPeerServiceDeps {
  /** Scope board lookup, so every managed checkout is offered under its own name. */
  scopes: { getBoard(projectId: string): ScopeBoard }
  /**
   * Resolve one scope's checkout, failing closed with its health. The scope root
   * resolver is the only authority for that, so it is injected rather than
   * re-derived here.
   */
  resolveRoot: (projectId: string, scopeBucketId: string) => Promise<ScopeResolution>
  git: SyncPeerGit
}

/** One end of a sync, resolved into everything the git core and the UI need. */
export interface ResolvedSyncPeer {
  /** Keys the checkout and branch the git core acts on. */
  target: GitSyncPeerTarget
  /** The same end as the picker lists it, so the two names can never diverge. */
  option: GitSyncPeerOption
}

/**
 * The single authority for what a sync's other end is.
 *
 * The renderer never resolves a peer itself: it asks for the options, renders
 * them, and hands the chosen `peer` back verbatim. Both calls go through this
 * service, so the name the picker showed is the name every error and toast uses.
 */
export class SyncPeerService {
  constructor(private readonly deps: SyncPeerServiceDeps) {}

  /**
   * Every end this project can sync with, from the running checkout's point of
   * view: the project root, one entry per scope that owns a checkout, and every
   * local branch no checkout holds. A branch a checkout does hold is offered as
   * that checkout instead, so one end never appears twice under two names.
   */
  async options(input: {
    projectId: string
    /** Checkout the operation runs in, so one option can be marked as itself. */
    runningPath: string
  }): Promise<GitSyncPeerOption[]> {
    const { projectId, runningPath } = input
    const [rootPath, branches] = await Promise.all([
      this.projectRoot(projectId),
      this.deps.git.listBranches(runningPath).catch((): GitBranchInfo[] => [])
    ])
    const branchByCheckout = branchByCheckoutPath(branches, worktreePathKey(runningPath))
    const runningKey = worktreePathKey(runningPath)

    const rootOption: GitSyncPeerOption = {
      peer: { kind: 'root' },
      label: 'Project root',
      branch: branchByCheckout.get(worktreePathKey(rootPath)) ?? null,
      checkout: true,
      self: worktreePathKey(rootPath) === runningKey,
      path: rootPath
    }

    const worktreeOptions: GitSyncPeerOption[] = []
    for (const bucket of this.deps.scopes.getBoard(projectId).buckets) {
      if (bucket.id === DEFAULT_SCOPE_BUCKET_ID) continue
      if (!isManagedScopeRoot(bucket.root)) continue
      if (bucket.archivedAt !== undefined) continue
      worktreeOptions.push(
        await this.worktreeOption(projectId, bucket, branchByCheckout, runningKey)
      )
    }
    worktreeOptions.sort((left, right) => left.label.localeCompare(right.label))

    return [rootOption, ...worktreeOptions, ...branchOptions(branches)]
  }

  /**
   * Resolve the peer the renderer chose. A root or worktree peer is a checkout,
   * so it is both the directory Git mutates and the branch it holds; a branch
   * peer is only a ref, and the git core refuses to send commits to it.
   */
  async resolve(input: { projectId: string; peer: GitSyncPeer }): Promise<ResolvedSyncPeer> {
    const { projectId, peer } = input
    if (peer.kind === 'branch') {
      return {
        target: { branch: peer.branch, label: `the branch “${peer.branch}”` },
        option: {
          peer,
          label: peer.branch,
          branch: peer.branch,
          checkout: false,
          self: false,
          path: null
        }
      }
    }

    const checkout =
      peer.kind === 'root'
        ? { scopeBucketId: DEFAULT_SCOPE_BUCKET_ID, path: await this.projectRoot(projectId) }
        : {
            scopeBucketId: peer.scopeBucketId,
            path: await this.requireRoot(projectId, peer.scopeBucketId)
          }
    const named =
      checkout.scopeBucketId === DEFAULT_SCOPE_BUCKET_ID
        ? null
        : this.bucket(projectId, checkout.scopeBucketId)
    const path = checkout.path
    const branch = await this.deps.git.statusBranch(path).catch(() => null)
    return {
      target: { path, ...(branch ? { branch } : {}), label: sentenceLabel(named) },
      option: {
        peer,
        label: named?.name ?? 'Project root',
        branch,
        checkout: true,
        self: false,
        path
      }
    }
  }

  /** One managed scope as a peer, or the reason it cannot be used right now. */
  private async worktreeOption(
    projectId: string,
    bucket: ScopeBucket,
    branchByCheckout: Map<string, string>,
    runningKey: string
  ): Promise<GitSyncPeerOption> {
    const base = {
      peer: { kind: 'worktree', scopeBucketId: bucket.id } as const,
      label: bucket.name,
      checkout: true
    }
    const resolution = await this.deps.resolveRoot(projectId, bucket.id)
    if (!resolution.ok) {
      return {
        ...base,
        branch: null,
        self: false,
        path: null,
        unavailable: scopeWorktreeUnavailableMessage(resolution.health)
      }
    }
    const path = resolution.root
    return {
      ...base,
      branch: branchByCheckout.get(worktreePathKey(path)) ?? null,
      self: worktreePathKey(path) === runningKey,
      path
    }
  }

  /** The project directory, which is the end every "sync with main" means. */
  private async projectRoot(projectId: string): Promise<string> {
    return await this.requireRoot(projectId, DEFAULT_SCOPE_BUCKET_ID)
  }

  /** A scope's checkout, or the reason it cannot be resolved right now. */
  private async requireRoot(projectId: string, scopeBucketId: string): Promise<string> {
    const resolution = await this.deps.resolveRoot(projectId, scopeBucketId)
    if (!resolution.ok) throw new Error(scopeWorktreeUnavailableMessage(resolution.health))
    return resolution.root
  }

  private bucket(projectId: string, scopeBucketId: string): ScopeBucket | null {
    return (
      this.deps.scopes
        .getBoard(projectId)
        .buckets.find((candidate) => candidate.id === scopeBucketId) ?? null
    )
  }
}

/** Sentence name of a checkout peer, for errors and result toasts. */
function sentenceLabel(bucket: ScopeBucket | null): string {
  return bucket ? `the scope “${bucket.name}”` : 'the project root'
}

/**
 * Every local branch as a peer, minus the branches a checkout holds: those are
 * offered by that checkout instead.
 */
function branchOptions(branches: GitBranchInfo[]): GitSyncPeerOption[] {
  return branches
    .filter(
      (branch) =>
        branch.kind === 'local' &&
        !branch.current &&
        (branch.worktreePath === null || branch.worktreePath.length === 0)
    )
    .map((branch) => ({
      peer: { kind: 'branch', branch: branch.name } as const,
      label: branch.name,
      branch: branch.name,
      checkout: false,
      self: false,
      path: null
    }))
    .sort((left, right) => left.label.localeCompare(right.label))
}

/**
 * Branch name of every checkout Git reports, keyed by that checkout's path.
 * `git branch` marks only the directory it ran in as current, so every other
 * linked worktree - the project root included - is recovered from the worktree
 * path Git attached to its branch.
 */
function branchByCheckoutPath(branches: GitBranchInfo[], runningKey: string): Map<string, string> {
  const byPath = new Map<string, string>()
  for (const branch of branches) {
    if (branch.kind !== 'local') continue
    if (branch.current) {
      byPath.set(runningKey, branch.name)
      continue
    }
    if (branch.worktreePath && branch.worktreePath.length > 0) {
      byPath.set(worktreePathKey(branch.worktreePath), branch.name)
    }
  }
  return byPath
}
