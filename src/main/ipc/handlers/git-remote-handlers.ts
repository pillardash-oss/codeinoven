import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import {
  validateBranchName,
  validateEntityId,
  validateMainSyncOptions,
  validatePullIntegrateOptions,
  validatePushOptions,
  validateRemoteName,
  validateRemoteUrl
} from '../ipc-validation'
import { DEFAULT_SCOPE_BUCKET_ID } from '../../../lib/types'
import type { IpcHandlerContext } from './context'

export function registerGitRemoteHandlers(ctx: IpcHandlerContext): void {
  const { gitService, vault, gitCredentialRef, resolveProjectPath } = ctx

  // ─── Git remotes, sync & credentials ────────────────────────────────────
  const gitCredentialStatus = async (projectId: string) => ({
    configured: await vault.exists(gitCredentialRef(projectId)),
    secureStorageAvailable: vault.isAvailable()
  })
  ipcMain.handle('git:remotes', async (_, projectId: unknown, scopeBucketId?: unknown) =>
    gitService.listRemotes(
      await resolveProjectPath(
        validateEntityId(projectId, 'Project ID'),
        scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
      )
    )
  )
  ipcMain.handle(
    'git:addRemote',
    async (_, projectId: unknown, name: unknown, url: unknown, scopeBucketId?: unknown) =>
      gitService.addRemote(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateRemoteName(name),
        validateRemoteUrl(url)
      )
  )
  ipcMain.handle(
    'git:setRemoteUrl',
    async (_, projectId: unknown, name: unknown, url: unknown, scopeBucketId?: unknown) =>
      gitService.setRemoteUrl(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateRemoteName(name),
        validateRemoteUrl(url)
      )
  )
  ipcMain.handle(
    'git:removeRemote',
    async (_, projectId: unknown, name: unknown, scopeBucketId?: unknown) =>
      gitService.removeRemote(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateRemoteName(name)
      )
  )
  ipcMain.handle('git:fetch', async (_, projectId: unknown, scopeBucketId?: unknown) =>
    gitService.fetch(
      await resolveProjectPath(
        validateEntityId(projectId, 'Project ID'),
        scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
      )
    )
  )
  ipcMain.handle(
    'git:fetchBranch',
    async (_, projectId: unknown, remote: unknown, branch: unknown, scopeBucketId?: unknown) =>
      gitService.fetchBranch(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateRemoteName(remote),
        validateBranchName(branch)
      )
  )
  ipcMain.handle('git:pull', async (_, projectId: unknown, scopeBucketId?: unknown) =>
    gitService.pull(
      await resolveProjectPath(
        validateEntityId(projectId, 'Project ID'),
        scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
      )
    )
  )
  ipcMain.handle(
    'git:pullIntegrate',
    async (_, projectId: unknown, options: unknown, scopeBucketId?: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeOptions = validatePullIntegrateOptions(options)
      // Resolve the vaulted PAT in main only; the token never crosses IPC.
      const tokenRef = gitCredentialRef(safeProjectId)
      const token = (await vault.exists(tokenRef)) ? await vault.resolve(tokenRef) : undefined
      return gitService.pullIntegrate(
        await resolveProjectPath(
          safeProjectId,
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        {
          ...safeOptions,
          token
        }
      )
    }
  )
  /**
   * Both directions of the worktree/main sync share one resolution path: the
   * worktree root comes from the active scope, the main root from the Default
   * scope, and the vaulted PAT is resolved in main only so it never crosses IPC.
   */
  const syncMain = async (
    direction: 'from-main' | 'to-main',
    projectId: unknown,
    options: unknown,
    scopeBucketId?: unknown
  ) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    const safeOptions = validateMainSyncOptions(options)
    // Both directions need a worktree checkout: without a scope the active root
    // is the project root, which is the other end of the sync.
    if (scopeBucketId === undefined) {
      throw new Error(
        `Syncing ${direction === 'from-main' ? 'from' : 'to'} the main branch requires a worktree scope`
      )
    }
    const safeScopeBucketId = validateEntityId(scopeBucketId, 'Scope bucket ID')
    // Resolve the vaulted PAT in main only; the token never crosses IPC.
    const tokenRef = gitCredentialRef(safeProjectId)
    const token = (await vault.exists(tokenRef)) ? await vault.resolve(tokenRef) : undefined
    return gitService.syncMain(await resolveProjectPath(safeProjectId, safeScopeBucketId), {
      direction,
      mainPath: await resolveProjectPath(safeProjectId, DEFAULT_SCOPE_BUCKET_ID),
      strategy: safeOptions.strategy,
      token
    })
  }
  ipcMain.handle(
    'git:syncFromMain',
    async (_, projectId: unknown, options: unknown, scopeBucketId?: unknown) =>
      syncMain('from-main', projectId, options, scopeBucketId)
  )
  ipcMain.handle(
    'git:syncToMain',
    async (_, projectId: unknown, options: unknown, scopeBucketId?: unknown) =>
      syncMain('to-main', projectId, options, scopeBucketId)
  )
  ipcMain.handle(
    'git:push',
    async (_, projectId: unknown, options: unknown, scopeBucketId?: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeOptions = validatePushOptions(options)
      // Resolve the vaulted PAT in main only; the token never crosses IPC.
      const tokenRef = gitCredentialRef(safeProjectId)
      const token = (await vault.exists(tokenRef)) ? await vault.resolve(tokenRef) : undefined
      return gitService.push(
        await resolveProjectPath(
          safeProjectId,
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        { ...safeOptions, token }
      )
    }
  )
  ipcMain.handle('git:getCredentialStatus', async (_, projectId: unknown) =>
    gitCredentialStatus(validateEntityId(projectId, 'Project ID'))
  )
  ipcMain.handle('git:setCredential', async (_, projectId: unknown, token: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > 16_384 ||
      token.includes('\0')
    ) {
      throw new TypeError('Provider token must be a string of at most 16384 characters')
    }
    await vault.save(token, gitCredentialRef(safeProjectId))
    return gitCredentialStatus(safeProjectId)
  })
  ipcMain.handle('git:removeCredential', async (_, projectId: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    await vault.remove(gitCredentialRef(safeProjectId))
    return gitCredentialStatus(safeProjectId)
  })
}
