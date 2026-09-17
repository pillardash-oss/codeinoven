import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import { gitSyncOutcome } from '../../git/git-refusal'
import {
  validateBranchName,
  validateEntityId,
  validatePullIntegrateOptions,
  validatePushOptions,
  validateRemoteName,
  validateRemoteUrl,
  validateSyncWithOptions
} from '../ipc-validation'
import type { IpcHandlerContext } from './context'

export function registerGitRemoteHandlers(ctx: IpcHandlerContext): void {
  const { gitService, syncPeers, vault, gitCredentialRef, resolveProjectPath } = ctx

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
   * Both directions of a peer sync share one resolution path: the running
   * checkout comes from the active scope, the other end is resolved by the peer
   * service (which is also what the picker listed), and the vaulted PAT is
   * resolved in main only so it never crosses IPC.
   */
  const syncWith = async (projectId: unknown, options: unknown, scopeBucketId?: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    const safeOptions = validateSyncWithOptions(options)
    const safeScopeBucketId =
      scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
    // Resolve the vaulted PAT in main only; the token never crosses IPC.
    const tokenRef = gitCredentialRef(safeProjectId)
    const token = (await vault.exists(tokenRef)) ? await vault.resolve(tokenRef) : undefined
    const peer = await syncPeers.resolve({ projectId: safeProjectId, peer: safeOptions.peer })
    const projectPath = await resolveProjectPath(safeProjectId, safeScopeBucketId)
    // A refusal (uncommitted work, a detached HEAD, an open integration) is a
    // state the renderer resolves in its own dialog, so it returns as data
    // rather than a rejected invoke: Electron logs every rejected
    // `ipcMain.handle` call as a console error, which would broadcast to the
    // log a sentence the panel is already showing.
    return gitSyncOutcome(() =>
      gitService.syncWith(projectPath, {
        direction: safeOptions.direction,
        peer: peer.target,
        strategy: safeOptions.strategy,
        token
      })
    )
  }
  ipcMain.handle(
    'git:syncWith',
    async (_, projectId: unknown, options: unknown, scopeBucketId?: unknown) =>
      syncWith(projectId, options, scopeBucketId)
  )
  ipcMain.handle('git:syncPeers', async (_, projectId: unknown, scopeBucketId?: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    const safeScopeBucketId =
      scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
    return syncPeers.options({
      projectId: safeProjectId,
      runningPath: await resolveProjectPath(safeProjectId, safeScopeBucketId)
    })
  })
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
