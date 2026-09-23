import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import { gitInvocation } from '../../git/git-refusal'
import {
  validateBoolean,
  validateBoundedInteger,
  validateBoundedString,
  validateBranchName,
  validateCommitMessage,
  validateConflictResolutionContent,
  validateEntityId,
  validateGitConflictSide,
  validateGitIdentity,
  validateGitPathArray,
  validateGitRelativePath,
  validateGitResetMode,
  validateGitRestoreTarget,
  validateGitRevision,
  validateRemoteName
} from '../ipc-validation'
import type { IpcHandlerContext } from './context'

export function registerGitHandlers(ctx: IpcHandlerContext): void {
  const { threadManager, repositoryService, gitService, resolveProjectPath } = ctx

  /**
   * The configured byte cap on a conflicted file, read per call so a settings
   * change applies without a restart. The merge editor refuses to open a file
   * above it, and every conflict payload it hands back is bounded by the same
   * number.
   */
  const conflictFileBytes = async (): Promise<number> =>
    (await ctx.storage.getConfig()).maxConflictFileBytes

  ipcMain.handle('git:status', async (_, projectId: unknown, scopeBucketId?: unknown) =>
    gitService.getStatus(
      await resolveProjectPath(
        validateEntityId(projectId, 'Project ID'),
        scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
      )
    )
  )
  ipcMain.handle(
    'git:diff',
    async (
      _,
      projectId: unknown,
      relativePath: unknown,
      staged: unknown,
      scopeBucketId?: unknown
    ) =>
      gitService.getDiff(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateGitRelativePath(relativePath),
        validateBoolean(staged, 'Staged')
      )
  )
  ipcMain.handle(
    'git:analyzeConflict',
    async (_, projectId: unknown, relativePath: unknown, scopeBucketId?: unknown) =>
      gitService.analyzeConflict(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateGitRelativePath(relativePath)
      )
  )
  ipcMain.handle(
    'git:prepareConflictWorkFile',
    async (_, projectId: unknown, relativePath: unknown, scopeBucketId?: unknown) =>
      gitService.prepareConflictWorkFile(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateGitRelativePath(relativePath)
      )
  )
  ipcMain.handle(
    'git:saveConflictDraft',
    async (
      _,
      projectId: unknown,
      relativePath: unknown,
      content: unknown,
      stateJson: unknown,
      scopeBucketId?: unknown
    ) => {
      const limit = await conflictFileBytes()
      return gitService.saveConflictDraft(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateGitRelativePath(relativePath),
        validateConflictResolutionContent(content, limit),
        validateConflictResolutionContent(stateJson, limit)
      )
    }
  )
  ipcMain.handle(
    'git:saveConflictResolution',
    async (
      _,
      projectId: unknown,
      relativePath: unknown,
      content: unknown,
      scopeBucketId?: unknown
    ) =>
      gitService.saveConflictResolution(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateGitRelativePath(relativePath),
        validateConflictResolutionContent(content, await conflictFileBytes())
      )
  )
  ipcMain.handle(
    'git:stage',
    async (_, projectId: unknown, paths: unknown, scopeBucketId?: unknown) =>
      gitService.stage(
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
    'git:resolveConflicted',
    async (_, projectId: unknown, path: unknown, scopeBucketId?: unknown) =>
      gitService.resolveConflicted(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateGitRelativePath(path)
      )
  )
  ipcMain.handle(
    'git:acceptConflictSide',
    async (_, projectId: unknown, side: unknown, scopeBucketId?: unknown) =>
      gitService.acceptConflictSide(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateGitConflictSide(side)
      )
  )
  ipcMain.handle(
    'git:unstage',
    async (_, projectId: unknown, paths: unknown, scopeBucketId?: unknown) =>
      gitService.unstage(
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
    'git:restoreFiles',
    async (
      _,
      projectId: unknown,
      source: unknown,
      paths: unknown,
      target: unknown,
      scopeBucketId?: unknown
    ) =>
      gitService.restoreFiles(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateGitRevision(source),
        validateGitPathArray(paths),
        validateGitRestoreTarget(target)
      )
  )
  ipcMain.handle(
    'git:commit',
    async (_, projectId: unknown, message: unknown, scopeBucketId?: unknown) =>
      gitService.commit(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateCommitMessage(message)
      )
  )
  ipcMain.handle('git:init', async (_, projectId: unknown, scopeBucketId?: unknown) =>
    gitService.initialize(
      await resolveProjectPath(
        validateEntityId(projectId, 'Project ID'),
        scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
      )
    )
  )
  ipcMain.handle('git:branches', async (_, projectId: unknown, scopeBucketId?: unknown) =>
    gitService.listBranches(
      await resolveProjectPath(
        validateEntityId(projectId, 'Project ID'),
        scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
      )
    )
  )
  ipcMain.handle('git:defaultBranch', async (_, projectId: unknown, scopeBucketId?: unknown) =>
    gitService.getDefaultBranch(
      await resolveProjectPath(
        validateEntityId(projectId, 'Project ID'),
        scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
      )
    )
  )
  ipcMain.handle(
    'git:checkout',
    async (_, projectId: unknown, branch: unknown, scopeBucketId?: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const projectPath = await resolveProjectPath(
        safeProjectId,
        scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
      )
      // A checkout git refuses (local changes it would overwrite) is a state the
      // panel resolves, so it returns as data and the branch bookkeeping below
      // only runs for a checkout that actually happened. The envelope is the
      // contract result, so it is returned whole: invokeGit unwraps the value
      // on the renderer side.
      const outcome = await gitInvocation(() =>
        gitService.checkout(projectPath, validateBranchName(branch))
      )
      if (outcome.ok) {
        // Keep thread.branch coherent when the app drives a checkout (D7): update
        // every owned thread whose working directory is this project.
        const threads = await threadManager.listThreads(safeProjectId)
        for (const thread of threads) {
          if (thread.workingDirectory) {
            const branchName = await repositoryService.getCurrentBranch(thread.workingDirectory)
            if (branchName) await threadManager.setBranch(safeProjectId, thread.id, branchName)
          }
        }
      }
      return outcome
    }
  )
  ipcMain.handle(
    'git:createBranch',
    async (_, projectId: unknown, name: unknown, scopeBucketId?: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const projectPath = await resolveProjectPath(
        safeProjectId,
        scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
      )
      const outcome = await gitInvocation(() =>
        gitService.createBranch(projectPath, validateBranchName(name))
      )
      if (outcome.ok) {
        const threads = await threadManager.listThreads(safeProjectId)
        for (const thread of threads) {
          if (thread.workingDirectory) {
            const branchName = await repositoryService.getCurrentBranch(thread.workingDirectory)
            if (branchName) await threadManager.setBranch(safeProjectId, thread.id, branchName)
          }
        }
      }
      return outcome
    }
  )
  ipcMain.handle(
    'git:createTrackingBranch',
    async (
      _,
      projectId: unknown,
      remote: unknown,
      branch: unknown,
      localName: unknown,
      scopeBucketId?: unknown
    ) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const projectPath = await resolveProjectPath(
        safeProjectId,
        scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
      )
      const outcome = await gitInvocation(() =>
        gitService.createTrackingBranch(
          projectPath,
          validateRemoteName(remote),
          validateBranchName(branch, 'Remote branch'),
          validateBranchName(localName, 'Local branch')
        )
      )
      if (outcome.ok) {
        const threads = await threadManager.listThreads(safeProjectId)
        for (const thread of threads) {
          if (thread.workingDirectory) {
            const branchName = await repositoryService.getCurrentBranch(thread.workingDirectory)
            if (branchName) await threadManager.setBranch(safeProjectId, thread.id, branchName)
          }
        }
      }
      return outcome
    }
  )
  ipcMain.handle(
    'git:deleteBranch',
    async (_, projectId: unknown, name: unknown, force?: unknown, scopeBucketId?: unknown) =>
      gitInvocation(async () =>
        gitService.deleteBranch(
          await resolveProjectPath(
            validateEntityId(projectId, 'Project ID'),
            scopeBucketId === undefined
              ? undefined
              : validateEntityId(scopeBucketId, 'Scope bucket ID')
          ),
          validateBranchName(name),
          force === undefined ? false : validateBoolean(force, 'Force delete')
        )
      )
  )
  ipcMain.handle(
    'git:deleteRemoteBranch',
    async (_, projectId: unknown, remote: unknown, name: unknown, scopeBucketId?: unknown) =>
      gitService.deleteRemoteBranch(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateRemoteName(remote),
        validateBranchName(name)
      )
  )
  ipcMain.handle(
    'git:log',
    async (
      _,
      projectId: unknown,
      limit?: unknown,
      offset?: unknown,
      query?: unknown,
      scopeBucketId?: unknown
    ) => {
      const bounded = validateBoundedInteger(limit ?? 50, 'Log limit', 1, 200)
      const boundedOffset = validateBoundedInteger(offset ?? 0, 'Log offset', 0, 100_000)
      const safeQuery =
        query === undefined
          ? undefined
          : validateBoundedString(query, 'Commit search query', 1, 256)
      return gitService.log(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        bounded,
        boundedOffset,
        safeQuery
      )
    }
  )
  ipcMain.handle('git:remoteUpdates', async (_, projectId: unknown, scopeBucketId?: unknown) =>
    gitService.remoteUpdates(
      await resolveProjectPath(
        validateEntityId(projectId, 'Project ID'),
        scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
      )
    )
  )
  ipcMain.handle(
    'git:commitDiff',
    async (_, projectId: unknown, hash: unknown, scopeBucketId?: unknown) => {
      const safeHash = validateEntityId(hash, 'Commit hash')
      return gitService.commitDiff(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        safeHash
      )
    }
  )
  ipcMain.handle(
    'git:commitFileDiff',
    async (_, projectId: unknown, hash: unknown, relativePath: unknown, scopeBucketId?: unknown) =>
      gitService.commitFileDiff(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateEntityId(hash, 'Commit hash'),
        validateGitRelativePath(relativePath)
      )
  )
  ipcMain.handle(
    'git:amend',
    async (_, projectId: unknown, message: unknown, scopeBucketId?: unknown) =>
      gitService.amend(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateCommitMessage(message)
      )
  )
  ipcMain.handle(
    'git:removeCommitChanges',
    async (_, projectId: unknown, hash: unknown, paths: unknown, scopeBucketId?: unknown) =>
      gitService.removeCommitChanges(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateGitRevision(hash),
        validateGitPathArray(paths)
      )
  )
  ipcMain.handle(
    'git:reset',
    async (_, projectId: unknown, mode: unknown, target?: unknown, scopeBucketId?: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const status = await gitService.reset(
        await resolveProjectPath(
          safeProjectId,
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        validateGitResetMode(mode),
        target === undefined ? undefined : validateEntityId(target, 'Reset target')
      )
      // A reset moves the branch, so keep thread.branch coherent like checkout.
      const threads = await threadManager.listThreads(safeProjectId)
      for (const thread of threads) {
        if (thread.workingDirectory) {
          const branchName = await repositoryService.getCurrentBranch(thread.workingDirectory)
          if (branchName) await threadManager.setBranch(safeProjectId, thread.id, branchName)
        }
      }
      return status
    }
  )
  ipcMain.handle(
    'git:deleteCommit',
    async (_, projectId: unknown, target: unknown, scopeBucketId?: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const projectPath = await resolveProjectPath(
        safeProjectId,
        scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
      )
      const outcome = await gitInvocation(() =>
        gitService.deleteCommit(projectPath, validateEntityId(target, 'Delete commit target'))
      )
      // A refusal leaves the checkout mid-rebase with HEAD detached, which is not
      // a branch change: only a delete that went through moved history.
      if (outcome.ok) {
        const threads = await threadManager.listThreads(safeProjectId)
        for (const thread of threads) {
          if (thread.workingDirectory) {
            const branchName = await repositoryService.getCurrentBranch(thread.workingDirectory)
            if (branchName) await threadManager.setBranch(safeProjectId, thread.id, branchName)
          }
        }
      }
      return outcome
    }
  )
  ipcMain.handle('git:getIdentity', async (_, projectId: unknown, scopeBucketId?: unknown) =>
    gitService.getIdentity(
      await resolveProjectPath(
        validateEntityId(projectId, 'Project ID'),
        scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
      )
    )
  )
  ipcMain.handle(
    'git:setIdentity',
    async (_, projectId: unknown, identity: unknown, scopeBucketId?: unknown) => {
      const safe = validateGitIdentity(identity)
      return gitService.setIdentity(
        await resolveProjectPath(
          validateEntityId(projectId, 'Project ID'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID')
        ),
        safe.name,
        safe.email
      )
    }
  )
}
