import { trustedIpcMain } from '../trusted-ipc-main'
import { registerMergeOperations } from './merge-operations'
import type { IpcHandlerContext } from './context'
export function registerMergeHandlers(ctx: IpcHandlerContext): void {
  registerMergeOperations(ctx, trustedIpcMain)
}
