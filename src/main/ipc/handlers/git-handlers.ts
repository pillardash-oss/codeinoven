import { trustedIpcMain } from '../trusted-ipc-main'
import type { IpcHandlerContext } from './context'
import { registerGitOperations } from './git-operations'

export function registerGitHandlers(ctx: IpcHandlerContext): void {
  registerGitOperations(ctx, trustedIpcMain)
}
