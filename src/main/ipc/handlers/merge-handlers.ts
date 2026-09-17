import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import {
  validateEntityId,
  validateGitPathArray,
  validateGitRebaseAction,
  validateGitRelativePath,
  validateMergeTarget,
  validatePrResolveOptions,
  validateStashId,
  validateStashMessage
} from '../ipc-validation'
import type { IpcHandlerContext } from './context'

export function registerMergeHandlers(ctx: IpcHandlerContext): void {
  const { gitService, vault, gitCredentialRef, resolveProjectPath } = ctx

  // ─── Merge / rebase / stash (Phase 4) ───────────────────────────────────
  ipcMain.handle(
    'git:merge',
    async (_, projectId: unknown, target: unknown, scopeBucketId?: unknown) =>
      gitService.merge(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateMergeTarget(target)
      )
  )
  ipcMain.handle(
    'git:rebase',
    async (_, projectId: unknown, target: unknown, scopeBucketId?: unknown) =>
      gitService.rebase(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateMergeTarget(target)
      )
  )
  ipcMain.handle(
    'git:preparePrResolve',
    async (_, projectId: unknown, options: unknown, scopeBucketId?: unknown) =>
      gitService.preparePrResolve(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validatePrResolveOptions(options)
      )
  )
  ipcMain.handle(
    'git:finishPrResolve',
    async (_, projectId: unknown, options: unknown, scopeBucketId?: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeOptions = validatePrResolveOptions(options)
      // Resolve the vaulted PAT in main only; the token never crosses IPC. The
      // finish step pushes the resolution back to the PR, so it needs the same
      // credential the panel's own push uses.
      const tokenRef = gitCredentialRef(safeProjectId)
      const token = (await vault.exists(tokenRef)) ? await vault.resolve(tokenRef) : undefined
      return gitService.finishPrResolve(
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
  ipcMain.handle(
    'git:stash',
    async (_, projectId: unknown, message?: unknown, paths?: unknown, scopeBucketId?: unknown) =>
      gitService.stash(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateStashMessage(message),
        paths === undefined ? undefined : validateGitPathArray(paths)
      )
  )
  ipcMain.handle(
    'git:ignore',
    async (_, projectId: unknown, paths: unknown, scopeBucketId?: unknown) =>
      gitService.ignore(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateGitPathArray(paths)
      )
  )
  ipcMain.handle(
    'git:discard',
    async (_, projectId: unknown, paths: unknown, scopeBucketId?: unknown) =>
      gitService.discard(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateGitPathArray(paths)
      )
  )
  ipcMain.handle('git:stashList', async (_, projectId: unknown, scopeBucketId?: unknown) =>
    gitService.listStashes(
      await resolveProjectPath(
        validateEntityId(projectId, 'Project ID'),
        scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
      )
    )
  )
  ipcMain.handle(
    'git:stashPop',
    async (_, projectId: unknown, id?: unknown, scopeBucketId?: unknown) =>
      gitService.popStash(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateStashId(id)
      )
  )
  ipcMain.handle(
    'git:stashDrop',
    async (_, projectId: unknown, id?: unknown, scopeBucketId?: unknown) =>
      gitService.dropStash(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateStashId(id)
      )
  )
  ipcMain.handle(
    'git:stashDiff',
    async (_, projectId: unknown, id: unknown, scopeBucketId?: unknown) =>
      gitService.stashDiff(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateStashId(id) ?? ''
      )
  )
  ipcMain.handle(
    'git:stashFileDiff',
    async (_, projectId: unknown, id: unknown, relativePath: unknown, scopeBucketId?: unknown) =>
      gitService.stashFileDiff(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateStashId(id) ?? '',
        validateGitRelativePath(relativePath)
      )
  )
  ipcMain.handle('git:abortMerge', async (_, projectId: unknown, scopeBucketId?: unknown) =>
    gitService.abortMerge(
      await resolveProjectPath(
        validateEntityId(projectId, 'Project ID'),
        scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
      )
    )
  )
  ipcMain.handle('git:abortRebase', async (_, projectId: unknown, scopeBucketId?: unknown) =>
    gitService.abortRebase(
      await resolveProjectPath(
        validateEntityId(projectId, 'Project ID'),
        scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
      )
    )
  )
  ipcMain.handle(
    'git:rebaseAction',
    async (_, projectId: unknown, action: unknown, scopeBucketId?: unknown) =>
      gitService.rebaseAction(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateGitRebaseAction(action)
      )
  )
}
