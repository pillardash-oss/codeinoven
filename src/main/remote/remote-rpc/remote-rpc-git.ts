/**
 * Git management channels for the remote RPC bridge.
 *
 * The phone drives the same read/write git surface the desktop sidebar uses.
 * A paired phone already commands an agent with full repository access over
 * this bridge, so git mutations do not widen trust. Only the credential store
 * stays desktop-owned: the PAT lives in the main-process vault and never
 * crosses the bridge (resolved here for push), and GitHub device-flow sign-in
 * plus pull-request creation stay desktop-only.
 */

import { DEFAULT_SCOPE_BUCKET_ID } from '../../../lib/types'
import type {
  GitConflictSide,
  GitMainSyncResult,
  GitRebaseAction,
  GitResetMode
} from '../../../lib/types'
import type { RemoteRpcCallContext } from './remote-rpc-context'
import { REMOTE_RPC_UNHANDLED } from './remote-rpc-context'
import { optionalBoolean, requireString, requireStringArray } from './remote-rpc-args'

export async function callRemoteGitRpc(
  ctx: RemoteRpcCallContext,
  channel: string,
  args: unknown[]
): Promise<unknown | typeof REMOTE_RPC_UNHANDLED> {
  switch (channel) {
    // ─── Git management ─────────────────────────────────────────────────
    // The phone drives the same read/write git surface the desktop sidebar
    // uses. A paired phone already commands an agent with full repository
    // access over this bridge, so git mutations do not widen trust. Only the
    // credential store stays desktop-owned: the PAT lives in the main-process
    // vault and never crosses the bridge (it is resolved here for push), and
    // GitHub device-flow sign-in + pull-request creation are desktop-only.
    case 'git:status':
      return ctx.gitService.getStatus(
        await resolveRemoteProjectPath(
          ctx,
          requireString(args[0]),
          args[1] === undefined ? undefined : requireString(args[1])
        )
      )
    case 'git:diff':
      return ctx.gitService.getDiff(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireString(args[1]),
        Boolean(args[2])
      )
    case 'git:analyzeConflict':
      return ctx.gitService.analyzeConflict(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireString(args[1])
      )
    case 'git:prepareConflictWorkFile':
      return ctx.gitService.prepareConflictWorkFile(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireString(args[1])
      )
    case 'git:saveConflictDraft':
      return ctx.gitService.saveConflictDraft(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireString(args[1]),
        requireString(args[2]),
        requireString(args[3])
      )
    case 'git:saveConflictResolution':
      return ctx.gitService.saveConflictResolution(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireString(args[1]),
        requireString(args[2])
      )
    case 'git:stage':
      return ctx.gitService.stage(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireStringArray(args[1], 'Git paths')
      )
    case 'git:resolveConflicted':
      return ctx.gitService.resolveConflicted(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireString(args[1])
      )
    case 'git:acceptConflictSide':
      return ctx.gitService.acceptConflictSide(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireString(args[1]) as GitConflictSide
      )
    case 'git:unstage':
      return ctx.gitService.unstage(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireStringArray(args[1], 'Git paths')
      )
    case 'git:commit':
      return ctx.gitService.commit(
        await resolveRemoteProjectPath(
          ctx,
          requireString(args[0]),
          args[2] === undefined ? undefined : requireString(args[2])
        ),
        requireString(args[1])
      )
    case 'git:amend':
      return ctx.gitService.amend(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireString(args[1])
      )
    case 'git:init':
      return ctx.gitService.initialize(await resolveRemoteProjectPath(ctx, requireString(args[0])))
    case 'git:branches':
      return ctx.gitService.listBranches(
        await resolveRemoteProjectPath(
          ctx,
          requireString(args[0]),
          args[1] === undefined ? undefined : requireString(args[1])
        )
      )
    case 'git:defaultBranch':
      return ctx.gitService.getDefaultBranch(
        await resolveRemoteProjectPath(
          ctx,
          requireString(args[0]),
          args[1] === undefined ? undefined : requireString(args[1])
        )
      )
    case 'git:checkout':
      return syncBranchAfterCheckout(
        ctx,
        requireString(args[0]),
        await ctx.gitService.checkout(
          await resolveRemoteProjectPath(ctx, requireString(args[0])),
          requireString(args[1])
        )
      )
    case 'git:createBranch':
      return syncBranchAfterCheckout(
        ctx,
        requireString(args[0]),
        await ctx.gitService.createBranch(
          await resolveRemoteProjectPath(ctx, requireString(args[0])),
          requireString(args[1])
        )
      )
    case 'git:createTrackingBranch':
      return syncBranchAfterCheckout(
        ctx,
        requireString(args[0]),
        await ctx.gitService.createTrackingBranch(
          await resolveRemoteProjectPath(ctx, requireString(args[0])),
          requireString(args[1]),
          requireString(args[2]),
          requireString(args[3])
        )
      )
    case 'git:deleteBranch':
      return ctx.gitService.deleteBranch(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireString(args[1]),
        optionalBoolean(args[2]) ?? false
      )
    case 'git:deleteRemoteBranch':
      return ctx.gitService.deleteRemoteBranch(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireString(args[1]),
        requireString(args[2])
      )
    case 'git:log':
      return ctx.gitService.log(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        typeof args[1] === 'number' ? args[1] : undefined,
        typeof args[2] === 'number' ? args[2] : undefined,
        typeof args[3] === 'string' ? requireString(args[3]) : undefined
      )
    case 'git:commitDiff':
      return ctx.gitService.commitDiff(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireString(args[1])
      )
    case 'git:commitFileDiff':
      return ctx.gitService.commitFileDiff(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireString(args[1]),
        requireString(args[2])
      )
    case 'git:stashDiff':
      return ctx.gitService.stashDiff(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireString(args[1])
      )
    case 'git:stashFileDiff':
      return ctx.gitService.stashFileDiff(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireString(args[1]),
        requireString(args[2])
      )
    case 'git:reset':
      return syncBranchAfterCheckout(
        ctx,
        requireString(args[0]),
        await ctx.gitService.reset(
          await resolveRemoteProjectPath(ctx, requireString(args[0])),
          requireString(args[1]) as GitResetMode,
          typeof args[2] === 'string' ? args[2] : undefined
        )
      )
    case 'git:getIdentity':
      return ctx.gitService.getIdentity(await resolveRemoteProjectPath(ctx, requireString(args[0])))
    case 'git:setIdentity': {
      const projectId = requireString(args[0])
      const identity = args[1] as { name?: string; email?: string } | undefined
      return ctx.gitService.setIdentity(
        await resolveRemoteProjectPath(ctx, projectId),
        requireString(identity?.name),
        requireString(identity?.email)
      )
    }
    case 'git:remotes':
      return ctx.gitService.listRemotes(
        await resolveRemoteProjectPath(
          ctx,
          requireString(args[0]),
          args[1] === undefined ? undefined : requireString(args[1])
        )
      )
    case 'git:addRemote':
      return ctx.gitService.addRemote(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireString(args[1]),
        requireString(args[2])
      )
    case 'git:setRemoteUrl':
      return ctx.gitService.setRemoteUrl(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireString(args[1]),
        requireString(args[2])
      )
    case 'git:removeRemote':
      return ctx.gitService.removeRemote(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireString(args[1])
      )
    case 'git:fetch':
      return ctx.gitService.fetch(await resolveRemoteProjectPath(ctx, requireString(args[0])))
    case 'git:fetchBranch':
      return ctx.gitService.fetchBranch(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireString(args[1]),
        requireString(args[2])
      )
    case 'git:pull':
      return ctx.gitService.pull(await resolveRemoteProjectPath(ctx, requireString(args[0])))
    case 'git:pullIntegrate': {
      const projectId = requireString(args[0])
      const options = (args[1] ?? {}) as {
        remote?: string
        branch?: string
        strategy?: string
      }
      const strategy = options.strategy
      if (strategy !== 'merge' && strategy !== 'rebase' && strategy !== 'ff-only') {
        throw new TypeError('Invalid pull strategy')
      }
      const tokenRef = `git_pat_${projectId}`
      const token = (await ctx.vault.exists(tokenRef))
        ? await ctx.vault.resolve(tokenRef)
        : undefined
      return ctx.gitService.pullIntegrate(
        await resolveRemoteProjectPath(
          ctx,
          projectId,
          args[2] === undefined ? undefined : requireString(args[2])
        ),
        {
          remote: typeof options.remote === 'string' ? options.remote : undefined,
          branch: typeof options.branch === 'string' ? options.branch : undefined,
          strategy,
          token
        }
      )
    }
    case 'git:syncFromMain':
      return await syncMain(ctx, 'from-main', args)
    case 'git:syncToMain':
      return await syncMain(ctx, 'to-main', args)
    case 'git:push': {
      const projectId = requireString(args[0])
      const options = (args[1] ?? {}) as {
        setUpstream?: boolean
        remote?: string
        branch?: string
      }
      const tokenRef = `git_pat_${projectId}`
      const token = (await ctx.vault.exists(tokenRef))
        ? await ctx.vault.resolve(tokenRef)
        : undefined
      return ctx.gitService.push(
        await resolveRemoteProjectPath(
          ctx,
          projectId,
          args[2] === undefined ? undefined : requireString(args[2])
        ),
        {
          setUpstream: Boolean(options.setUpstream),
          remote: typeof options.remote === 'string' ? options.remote : undefined,
          branch: typeof options.branch === 'string' ? options.branch : undefined,
          token
        }
      )
    }
    case 'git:getCredentialStatus': {
      const projectId = requireString(args[0])
      return {
        configured: await ctx.vault.exists(`git_pat_${projectId}`),
        secureStorageAvailable: ctx.vault.isAvailable()
      }
    }
    case 'git:merge':
      return ctx.gitService.merge(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireString(args[1])
      )
    case 'git:rebase':
      return ctx.gitService.rebase(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireString(args[1])
      )
    case 'git:stash':
      return ctx.gitService.stash(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        typeof args[1] === 'string' ? args[1] : undefined
      )
    case 'git:stashList':
      return ctx.gitService.listStashes(await resolveRemoteProjectPath(ctx, requireString(args[0])))
    case 'git:stashPop':
      return ctx.gitService.popStash(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        typeof args[1] === 'string' ? args[1] : undefined
      )
    case 'git:stashDrop':
      return ctx.gitService.dropStash(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        typeof args[1] === 'string' ? args[1] : undefined
      )
    case 'git:abortMerge':
      return ctx.gitService.abortMerge(await resolveRemoteProjectPath(ctx, requireString(args[0])))
    case 'git:abortRebase':
      return ctx.gitService.abortRebase(await resolveRemoteProjectPath(ctx, requireString(args[0])))
    case 'git:rebaseAction':
      return ctx.gitService.rebaseAction(
        await resolveRemoteProjectPath(ctx, requireString(args[0])),
        requireString(args[1]) as GitRebaseAction
      )

    // ─── GitHub read-only auth status (device flow stays desktop-only) ──
    case 'github:authStatus':
      return ctx.githubAuthService.status()

    default:
      return REMOTE_RPC_UNHANDLED
  }
}

/** Resolve a project id to its validated absolute path (git operates on paths). */
export async function resolveRemoteProjectPath(
  ctx: RemoteRpcCallContext,
  projectId: string,
  scopeBucketId?: string
): Promise<string> {
  if (scopeBucketId) {
    const scopeRoot = await ctx.scopeRoots.resolveCompatibilityRoot(projectId, scopeBucketId)
    if (!scopeRoot) throw new Error(`Scope root unavailable: ${projectId}:${scopeBucketId}`)
    return scopeRoot
  }
  const project = await ctx.projectManager.getProject(projectId)
  if (!project?.path) throw new Error(`Project not found: ${projectId}`)
  return project.path
}

/**
 * A checkout/create-branch/reset moves the branch, so keep every owned
 * thread whose working directory is this project coherent   mirroring the
 * desktop git IPC handler.
 */
export async function syncBranchAfterCheckout<T>(
  ctx: RemoteRpcCallContext,
  projectId: string,
  result: T
): Promise<T> {
  const threads = await ctx.threadManager.listThreads(projectId)
  for (const thread of threads) {
    if (!thread.workingDirectory) continue
    const branchName = await ctx.repositoryService.getCurrentBranch(thread.workingDirectory)
    if (branchName) await ctx.threadManager.setBranch(projectId, thread.id, branchName)
  }
  return result
}

/**
 * Shared dispatcher for both directions of the worktree/main sync, mirroring
 * the desktop `git:syncFromMain` / `git:syncToMain` handlers: the worktree root
 * comes from the active scope, the main root from the Default scope, and the
 * vaulted PAT is resolved here so it never crosses the wire.
 */
export async function syncMain(
  ctx: RemoteRpcCallContext,
  direction: 'from-main' | 'to-main',
  args: unknown[]
): Promise<GitMainSyncResult> {
  const projectId = requireString(args[0])
  const options = (args[1] ?? {}) as { strategy?: string }
  const strategy = options.strategy
  if (strategy !== 'merge' && strategy !== 'rebase' && strategy !== 'ff-only') {
    throw new TypeError('Invalid sync strategy')
  }
  if (args[2] === undefined) {
    throw new Error(
      `Syncing ${direction === 'from-main' ? 'from' : 'to'} the main branch requires a worktree scope`
    )
  }
  const tokenRef = `git_pat_${projectId}`
  const token = (await ctx.vault.exists(tokenRef)) ? await ctx.vault.resolve(tokenRef) : undefined
  return ctx.gitService.syncMain(
    await resolveRemoteProjectPath(ctx, projectId, requireString(args[2])),
    {
      direction,
      mainPath: await resolveRemoteProjectPath(ctx, projectId, DEFAULT_SCOPE_BUCKET_ID),
      strategy,
      token
    }
  )
}
