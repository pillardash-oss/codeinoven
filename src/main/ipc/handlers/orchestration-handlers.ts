import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import { validateEntityId } from '../validation/primitives'
import type { IpcHandlerContext } from './context'

/**
 * The orchestrator board's read channel.
 *
 * The board lists the runs one thread dispatched, wherever those runs live, so
 * the only input is the pair of ids the open thread already has. Nothing is
 * written from here: the app records a dispatch itself when the tool accepts a
 * run, which is what keeps the board and the sidebar from disagreeing.
 */
export function registerOrchestrationHandlers(ctx: IpcHandlerContext): void {
  ipcMain.handle('orchestration:dispatches', async (_, projectId: unknown, threadId: unknown) => {
    return ctx.orchestrationDispatchRepo.listByInitiator(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID')
    )
  })
}
