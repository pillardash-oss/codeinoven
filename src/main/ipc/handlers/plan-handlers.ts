import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import { validateChecklistItemStatus, validateEntityId } from '../ipc-validation'
import type { IpcHandlerContext } from './context'

export function registerPlanHandlers(ctx: IpcHandlerContext): void {
  const { planEngine } = ctx

  ipcMain.handle('plan:save', (_, projectId: string, threadId: string, content: string) =>
    planEngine.savePlan(projectId, threadId, content)
  )
  ipcMain.handle('plan:get', (_, projectId: string, threadId: string) =>
    planEngine.getPlan(projectId, threadId)
  )
  ipcMain.handle('plan:approve', (_, projectId: string, threadId: string) =>
    planEngine.approvePlan(projectId, threadId)
  )
  ipcMain.handle(
    'checklist:generate',
    (_, projectId: string, threadId: string, planContent: string) =>
      planEngine.generateChecklist(projectId, threadId, planContent)
  )
  ipcMain.handle('checklist:get', (_, projectId: string, threadId: string) =>
    planEngine.getChecklist(projectId, threadId)
  )
  ipcMain.handle(
    'checklist:updateItem',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      itemId: unknown,
      status: unknown,
      evidence?: string
    ) =>
      planEngine.updateChecklistItem(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(itemId, 'Checklist item ID'),
        validateChecklistItemStatus(status),
        evidence
      )
  )
}
