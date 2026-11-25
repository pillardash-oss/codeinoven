import { trustedIpcMain } from '../trusted-ipc-main'
import { broadcastGitPushProgress } from '../../git/git-push-progress'
import type { IpcHandlerContext } from './context'
import { registerGitRemoteOperations } from './git-remote-operations'

export function registerGitRemoteHandlers(ctx: IpcHandlerContext): void {
  registerGitRemoteOperations({ ...ctx, onPushProgress: broadcastGitPushProgress }, trustedIpcMain)
}
