import { trustedIpcMain } from '../trusted-ipc-main'
import type { IpcHandlerContext } from './context'
import { registerGitRemoteOperations } from './git-remote-operations'

export function registerGitRemoteHandlers(ctx: IpcHandlerContext): void {
  registerGitRemoteOperations(ctx, trustedIpcMain)
}
