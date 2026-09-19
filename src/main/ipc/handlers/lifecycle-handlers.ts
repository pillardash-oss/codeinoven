import {
  validateEngineeringLifecycleDecision,
  validateEngineeringLifecycleResumeToken,
  validateEngineeringLifecycleSelectionInput,
  validateEngineeringLifecycleStage
} from '../ipc-validation'
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import type { IpcHandlerContext } from './context'

export function registerEngineeringLifecycleHandlers(ctx: IpcHandlerContext): void {
  const { chatEngine, storage, threadManager, engineeringLifecycleEngine, waitForThreadReady } = ctx

  ipcMain.handle('engineeringLifecycle:get', async (_, projectId: unknown, threadId: unknown) => {
    const ids = await waitForThreadReady(projectId, threadId)
    return engineeringLifecycleEngine.get(ids.projectId, ids.threadId)
  })
  ipcMain.handle(
    'engineeringLifecycle:select',
    async (_, projectId: unknown, threadId: unknown, input: unknown) => {
      const ids = await waitForThreadReady(projectId, threadId)
      const selectionInput = validateEngineeringLifecycleSelectionInput(input)
      // The independent audit owns the workflow: engineering modes stay locked
      // out of a thread for its lifetime once the audit switch was turned on.
      if (selectionInput.autopilot === true || selectionInput.stages.length > 0) {
        const auditThread = await threadManager.getThread(ids.projectId, ids.threadId)
        if (auditThread?.independentAudit === true) {
          throw new Error(
            'Engineering modes are locked while the independent audit is enabled. Fork the thread to use them.'
          )
        }
      }
      const previous = engineeringLifecycleEngine.get(ids.projectId, ids.threadId)
      const next = engineeringLifecycleEngine.select(ids.projectId, ids.threadId, selectionInput)
      // Engineering is now expressed purely through the lifecycle selection, so
      // the senior-engineer/auditor defaults attach the moment a thread first
      // gains an active selection (previously tied to the creation-time flag).
      if ((previous?.selection ?? 'none') === 'none' && next.selection !== 'none') {
        const thread = await threadManager.getThread(ids.projectId, ids.threadId)
        if (thread?.settings) {
          const defaults = (await storage.getConfig()).agentDefaults
          const baseSettings = { ...thread.settings }
          delete baseSettings.loopAuditor
          await threadManager.updateSettings(ids.projectId, ids.threadId, {
            ...baseSettings,
            ...(defaults.seniorEngineer ?? {}),
            ...(defaults.auditor ? { loopAuditor: defaults.auditor } : {})
          })
        }
      }
      return next
    }
  )
  ipcMain.handle(
    'engineeringLifecycle:start',
    async (_, projectId: unknown, threadId: unknown, stage: unknown) => {
      const ids = await waitForThreadReady(projectId, threadId)
      return engineeringLifecycleEngine.start(
        ids.projectId,
        ids.threadId,
        stage === undefined || stage === null ? undefined : validateEngineeringLifecycleStage(stage)
      )
    }
  )
  ipcMain.handle(
    'engineeringLifecycle:complete',
    async (_, projectId: unknown, threadId: unknown, stage: unknown) => {
      const ids = await waitForThreadReady(projectId, threadId)
      return engineeringLifecycleEngine.completeStage(
        ids.projectId,
        ids.threadId,
        validateEngineeringLifecycleStage(stage)
      )
    }
  )
  ipcMain.handle(
    'engineeringLifecycle:resume',
    async (_, projectId: unknown, threadId: unknown, resumeToken: unknown, decision: unknown) => {
      const ids = await waitForThreadReady(projectId, threadId)
      return engineeringLifecycleEngine.resume(
        ids.projectId,
        ids.threadId,
        validateEngineeringLifecycleResumeToken(resumeToken),
        validateEngineeringLifecycleDecision(decision)
      )
    }
  )
  ipcMain.handle(
    'engineeringLifecycle:retry',
    async (_, projectId: unknown, threadId: unknown, resumeToken: unknown) => {
      const ids = await waitForThreadReady(projectId, threadId)
      return engineeringLifecycleEngine.retry(
        ids.projectId,
        ids.threadId,
        validateEngineeringLifecycleResumeToken(resumeToken)
      )
    }
  )
  ipcMain.handle(
    'engineeringLifecycle:cancel',
    async (_, projectId: unknown, threadId: unknown, confirmed: unknown) => {
      if (confirmed !== true)
        throw new TypeError('Engineering lifecycle cancellation requires confirmation')
      const ids = await waitForThreadReady(projectId, threadId)
      const before = engineeringLifecycleEngine.get(ids.projectId, ids.threadId)
      const result = engineeringLifecycleEngine.cancel(ids.projectId, ids.threadId)
      // A user-initiated stop must halt the in-flight generation turn too,
      // otherwise the thread stays planning/executing and is re-surfaced on
      // view switch or resumed by restart recovery. abort() tears down the
      // active harness session and marks the thread `interrupted`
      // (non-recoverable), so an explicitly stopped run stays stopped.
      if (
        before &&
        (before.activeStage !== undefined ||
          before.humanGate !== undefined ||
          before.selection !== 'none') &&
        chatEngine?.abort
      ) {
        await chatEngine.abort(ids.projectId, ids.threadId)
      }
      return result
    }
  )
}
