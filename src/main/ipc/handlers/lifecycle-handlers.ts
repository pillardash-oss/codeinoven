import type { EngineeringLifecycleSelectionInput } from '../../../lib/types'
import { isOrchestrationChildThread } from '../../../lib/types'
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

  /**
   * Attach the senior-engineer/auditor defaults the moment a thread first
   * gains an active Engineering selection. Engineering is expressed purely
   * through the lifecycle selection, so the role defaults ride the first
   * selection (previously tied to a creation-time flag).
   */
  async function applyEngineeringDefaults(projectId: string, threadId: string): Promise<void> {
    const thread = await threadManager.getThread(projectId, threadId)
    if (!thread?.settings) return
    const defaults = (await storage.getConfig()).agentDefaults
    const baseSettings = { ...thread.settings }
    delete baseSettings.loopAuditor
    await threadManager.updateSettings(projectId, threadId, {
      ...baseSettings,
      ...(defaults.seniorEngineer ?? {}),
      ...(defaults.auditor ? { loopAuditor: defaults.auditor } : {})
    })
  }

  /**
   * Apply a selection and its attached side effects: the durable Engineering
   * marker (so the sidebar and Toolbox read Engineering without a lifecycle
   * round trip) and the senior-engineer/auditor defaults the first selection
   * attaches.
   */
  async function applySelection(
    projectId: string,
    threadId: string,
    selectionInput: EngineeringLifecycleSelectionInput
  ): Promise<ReturnType<typeof engineeringLifecycleEngine.select>> {
    const previous = engineeringLifecycleEngine.get(projectId, threadId)
    const next = engineeringLifecycleEngine.select(projectId, threadId, selectionInput)
    if (next.autopilot || next.selectedStages.length > 0) {
      await threadManager.updateThread(projectId, threadId, { engineering: true })
    }
    if ((previous?.selection ?? 'none') === 'none' && next.selection !== 'none') {
      await applyEngineeringDefaults(projectId, threadId)
    }
    return next
  }

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
      return applySelection(ids.projectId, ids.threadId, selectionInput)
    }
  )
  ipcMain.handle(
    'engineeringLifecycle:inherit',
    async (
      _,
      projectId: unknown,
      sourceThreadId: unknown,
      destinationThreadId: unknown,
      selection: unknown
    ) => {
      const source = await waitForThreadReady(
        projectId,
        sourceThreadId,
        'Project ID',
        'Source thread ID'
      )
      const destination = await waitForThreadReady(
        source.projectId,
        destinationThreadId,
        'Project ID',
        'Destination thread ID'
      )
      const sourceThread = await threadManager.getThread(source.projectId, source.threadId)
      if (!sourceThread) return null
      // The independent audit owns its thread's workflow and is never an
      // Engineering thread, and an orchestration child (auditor, Assignment
      // worker) is an internal that must never gain Engineering modes.
      if (sourceThread.independentAudit === true || isOrchestrationChildThread(sourceThread)) {
        return null
      }
      // The staged (not-yet-sent) Toolbox intent is what the user actually sees,
      // so it wins over the persisted row when one was sent. `null` means "no
      // override", an empty selection means "the user turned every switch off".
      const hasOverride = selection !== undefined && selection !== null
      const staged = hasOverride ? validateEngineeringLifecycleSelectionInput(selection) : null
      const stagedActive = staged !== null && (staged.autopilot || staged.stages.length > 0)
      const sourceLifecycle = engineeringLifecycleEngine.get(source.projectId, source.threadId)
      const persistedSelection: EngineeringLifecycleSelectionInput | null =
        sourceLifecycle && sourceLifecycle.selection !== 'none'
          ? {
              stages: sourceLifecycle.selectedStages ?? [],
              autopilot: sourceLifecycle.autopilot === true
            }
          : null
      const sourceIsEngineering =
        sourceThread.engineering === true ||
        sourceLifecycle?.startedAt !== undefined ||
        persistedSelection !== null ||
        stagedActive
      if (!sourceIsEngineering) return null
      const effective = staged ?? persistedSelection
      const hasActiveSelection =
        effective !== null && (effective.autopilot || effective.stages.length > 0)
      // The switches travel as a fresh run; a parked source (every switch off)
      // also hands over its permanent started marker so the sibling's Toolbox
      // stays filled exactly as the source's does.
      engineeringLifecycleEngine.inherit(destination.projectId, destination.threadId, {
        stages: effective?.stages ?? [],
        autopilot: effective?.autopilot === true,
        startedAt: hasActiveSelection ? undefined : sourceLifecycle?.startedAt
      })
      // The durable Engineering marker rides the thread row, so the sidebar
      // indicator and Toolbox read Engineering without a lifecycle round trip.
      await threadManager.updateThread(destination.projectId, destination.threadId, {
        engineering: true
      })
      if (hasActiveSelection) {
        await applyEngineeringDefaults(destination.projectId, destination.threadId)
      }
      // Return the destination as persisted (marker and any attached defaults),
      // so a caller that opens the thread afterwards never adopts a stale
      // pre-inheritance snapshot its Toolbox would read as neutral.
      return threadManager.getThread(destination.projectId, destination.threadId)
    }
  )
  ipcMain.handle(
    'engineeringLifecycle:start',
    async (_, projectId: unknown, threadId: unknown, stage: unknown) => {
      const ids = await waitForThreadReady(projectId, threadId)
      const started = engineeringLifecycleEngine.start(
        ids.projectId,
        ids.threadId,
        stage === undefined || stage === null ? undefined : validateEngineeringLifecycleStage(stage)
      )
      // Starting a stage engages Engineering even on the paths that never route
      // through `select` (send-time auto-start, a retry, a resumed gate).
      await threadManager.updateThread(ids.projectId, ids.threadId, { engineering: true })
      return started
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
