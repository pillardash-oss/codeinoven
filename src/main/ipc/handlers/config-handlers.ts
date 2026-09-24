import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { CIO_PROMPT_MAX_LENGTH, isCioPromptId } from '../../../lib/cio-prompts'
import { normalizeWorkerNames } from '../../../lib/assignment/worker-names'
import type {
  ProjectAction,
  ProjectActionInput,
  ProjectActionVariable
} from '../../../lib/project-actions'
import { validateBoolean, validateBoundedString, validateEntityId } from '../ipc-validation'
import {
  validateAgentModelSelection,
  validateAppConfigPatch,
  validateHeartbeatCreateInput,
  validateHeartbeatPatchInput,
  validateLocalProfileAnalyticsRange,
  validateLocalUsageClearInput,
  validateRankingGradeScope
} from './config-helpers'
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import { Logger } from '../../system/logger'
import { sendToRenderer } from '../renderer-delivery'
import type {
  AgentRole,
  AppConfig,
  LocalRankingGradeProgress,
  LocalRankingJudgeView,
  LocalRankingQueueStatus,
  LocalUsageClearInput,
  LocalUsageRecordCounts
} from '../../../lib/types'
import type { IpcHandlerContext } from './context'

const AGENT_ROLES = new Set<AgentRole>(['seniorEngineer', 'worker', 'auditor'])

/** Human label for each clearable store, used only in the purge log line. */
const RECORD_STORE_LABELS: Record<LocalUsageClearInput['store'], string> = {
  all: 'all usage records',
  agentResponses: 'agent response records',
  utilities: 'utility records',
  modelRankings: 'model ranking records'
}

/** Push ranking-grade progress to every window, the way other status streams do. */
function broadcastRankingGradeProgress(progress: LocalRankingGradeProgress | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    sendToRenderer(win.webContents, 'account:rankingGradeProgress', progress)
  }
}

/**
 * The judge a manual run would use, described for the panel that offers it.
 *
 * A `model` pin that is missing any of its parts is reported as "No model
 * chosen" rather than quietly presented as the automatic chain, because a
 * settings page that claims a judge the engine cannot use is worse than one
 * that says the choice needs finishing. Only a hand-edited config can reach that
 * state: the write boundary rejects an incomplete pin.
 */
function rankingJudgeView(config: AppConfig): LocalRankingJudgeView {
  const judge = config.rankingJudge ?? { kind: 'automatic' }
  if (judge.kind === 'typesafe') return { kind: 'typesafe', label: 'TypeSafe (Jev)' }
  if (judge.kind === 'model') {
    const named = judge.harnessId && judge.providerId && judge.modelId
    return {
      kind: 'model',
      label: named ? `${judge.harnessId} · ${judge.modelId}` : 'No model chosen'
    }
  }
  return { kind: 'automatic', label: 'Automatic' }
}

export function registerConfigHandlers(ctx: IpcHandlerContext): void {
  const { storage, options, harnessUsageRepo, modelRankingRepo, rankingSnapshotRepo, chatEngine } =
    ctx

  /**
   * One read of everything the grading panel shows: the queue, the judge, and
   * the run in flight. Assembled in one place so the panel, the progress event
   * and the run's return value can never describe the same queue differently.
   */
  async function rankingQueueStatus(): Promise<LocalRankingQueueStatus> {
    const [counts, config] = await Promise.all([
      Promise.resolve(rankingSnapshotRepo.queueCounts(Date.now())),
      storage.getConfig()
    ])
    return {
      awaiting: counts.awaiting,
      due: counts.due,
      failed: counts.failed,
      judge: rankingJudgeView(config),
      run: chatEngine?.rankingGradeRunStatus?.() ?? null
    }
  }

  // ─── Application config ────────────────────────────────────────────────
  ipcMain.handle('account:getLocalUsage', async (_, input: unknown) => {
    const range = validateLocalProfileAnalyticsRange(input)
    const [analytics, pendingGrades] = await Promise.all([
      harnessUsageRepo.profileAnalytics(range),
      rankingSnapshotRepo.totalCount()
    ])
    analytics.modelRankings = modelRankingRepo.analytics()
    analytics.gradingSpend = modelRankingRepo.gradingSpend()
    // The stores the Usage page can clear are reported alongside the analytics,
    // so the counts a clear dialog promises always match the rows on screen.
    analytics.records.modelRankings = modelRankingRepo.recordCount()
    analytics.records.pendingGrades = pendingGrades
    return analytics
  })

  /**
   * Start one Usage page record store from a clean slate.
   *
   * Ledger stores are scoped to the supplied range. The ranking store carries
   * no per-range timestamp, so it is cleared all-time together with the grading
   * queue that would otherwise repopulate it. Every purge is logged, because a
   * destructive action that empties visible history must never be silent.
   */
  ipcMain.handle('account:clearLocalUsage', async (_, input: unknown) => {
    const request = validateLocalUsageClearInput(input)
    const cleared: LocalUsageRecordCounts = {
      agentResponses: 0,
      utilities: 0,
      modelRankings: 0,
      pendingGrades: 0
    }
    if (request.store === 'all' || request.store === 'agentResponses') {
      const result = await harnessUsageRepo.clearLedgerRecords('agentResponses', request.range)
      if (!result.ok) {
        throw new Error(result.error ?? 'Agent response records could not be cleared')
      }
      cleared.agentResponses = result.deleted
    }
    if (request.store === 'all' || request.store === 'utilities') {
      const result = await harnessUsageRepo.clearLedgerRecords('utilities', request.range)
      if (!result.ok) {
        throw new Error(result.error ?? 'Utility records could not be cleared')
      }
      cleared.utilities = result.deleted
    }
    if (request.store === 'all' || request.store === 'modelRankings') {
      cleared.modelRankings = modelRankingRepo.clearAll()
      const queue = await rankingSnapshotRepo.clearAllViaWorker()
      if (!queue.ok) {
        throw new Error(queue.error ?? 'The ranking grading queue could not be cleared')
      }
      cleared.pendingGrades = queue.deleted
    }
    Logger.info('Local usage records cleared', {
      store: RECORD_STORE_LABELS[request.store],
      rangeStartAt: request.range.startAt,
      rangeEndAt: request.range.endAt,
      cleared
    })
    return cleared
  })

  ipcMain.handle('account:getRankingQueue', () => rankingQueueStatus())

  /**
   * Grade the ranking queue on request.
   *
   * The run is bounded and paced by the engine; every pass pushes its counters
   * so a queue graded three conversations at a time shows real progress instead
   * of a spinner, and the call itself resolves with the run's own result. A run
   * already in flight is joined rather than duplicated, so a double click cannot
   * grade the same conversation twice.
   */
  ipcMain.handle('account:gradeRankingQueue', async (_, input: unknown) => {
    const scope = validateRankingGradeScope(input)
    if (!chatEngine?.gradeRankingQueueNow) {
      throw new Error('Ranking grading is unavailable in this build')
    }
    Logger.info('Ranking queue grading requested', { scope })
    const progress = await chatEngine.gradeRankingQueueNow(scope, broadcastRankingGradeProgress)
    broadcastRankingGradeProgress(null)
    Logger.info('Ranking queue grading finished', {
      scope,
      graded: progress.graded,
      remaining: progress.remaining,
      cancelled: progress.cancelled
    })
    return progress
  })

  ipcMain.handle('account:cancelRankingGrade', () => {
    chatEngine?.cancelRankingGrade?.()
  })
  if (!options.hydrationHandlersRegistered) {
    ipcMain.handle('config:get', () => storage.getConfig())
  }
  ipcMain.handle('visionModels:list', () => storage.getVisionModels())
  const projectActionsPath = (projectId: string): string =>
    `projects/${validateEntityId(projectId, 'Project ID')}/actions.json`
  const readProjectActions = async (projectId: string): Promise<ProjectAction[]> => {
    const stored = await storage.read<{ actions?: unknown }>(projectActionsPath(projectId))
    return Array.isArray(stored?.actions) ? (stored.actions as ProjectAction[]) : []
  }
  const validateProjectActionInput = (value: unknown): ProjectActionInput => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new TypeError('Action is invalid')
    const record = value as Record<string, unknown>
    const name = validateBoundedString(record['name'], 'Action name', 0, 120).trim()
    const script = validateBoundedString(record['script'], 'Action script', 1, 100_000).trim()
    if (!script) throw new TypeError('Action script is required')
    const rawVariables = record['variables']
    if (!Array.isArray(rawVariables) || rawVariables.length > 30)
      throw new TypeError('Action variables are invalid')
    const variables: ProjectActionVariable[] = rawVariables.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new TypeError('Action variable is invalid')
      const variable = entry as Record<string, unknown>
      const variableName = validateBoundedString(variable['name'], 'Variable name', 1, 64).trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(variableName))
        throw new TypeError('Variable names must be valid shell environment names')
      return {
        name: variableName,
        label:
          validateBoundedString(variable['label'], 'Variable label', 0, 120).trim() || variableName,
        required: validateBoolean(variable['required'], 'Variable required')
      }
    })
    if (new Set(variables.map((variable) => variable.name)).size !== variables.length)
      throw new TypeError('Variable names must be unique')
    let color: string | null = null
    const rawColor = record['color']
    if (rawColor !== undefined && rawColor !== null && rawColor !== '') {
      if (typeof rawColor !== 'string' || !/^#[0-9a-fA-F]{6}$/u.test(rawColor))
        throw new TypeError('Action color is invalid')
      color = rawColor.toLowerCase()
    }
    return { name, script, variables, color }
  }
  ipcMain.handle('projectActions:list', (_, projectId: string) => readProjectActions(projectId))
  ipcMain.handle(
    'projectActions:save',
    async (
      _,
      projectId: string,
      actionId: string | null,
      value: unknown,
      insertAfterId?: string | null
    ) => {
      const input = validateProjectActionInput(value)
      const actions = await readProjectActions(projectId)
      const now = Date.now()
      const existing = actionId ? actions.find((action) => action.id === actionId) : undefined
      const action: ProjectAction = {
        id: existing?.id ?? randomUUID(),
        ...input,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
      let next: ProjectAction[]
      if (existing) {
        next = actions.map((item) => (item.id === action.id ? action : item))
      } else if (insertAfterId) {
        // Duplicates land directly beneath the source action, not at the end.
        const anchorIndex = actions.findIndex((item) => item.id === insertAfterId)
        next = [...actions]
        if (anchorIndex === -1) next.push(action)
        else next.splice(anchorIndex + 1, 0, action)
      } else {
        next = [...actions, action]
      }
      await storage.write(projectActionsPath(projectId), { actions: next })
      return action
    }
  )
  ipcMain.handle('projectActions:delete', async (_, projectId: string, actionId: string) => {
    const actions = await readProjectActions(projectId)
    const next = actions.filter((action) => action.id !== validateEntityId(actionId, 'Action ID'))
    if (next.length === actions.length) return false
    await storage.write(projectActionsPath(projectId), { actions: next })
    return true
  })
  ipcMain.handle('projectActions:reorder', async (_, projectId: string, orderedIds: unknown) => {
    if (!Array.isArray(orderedIds)) throw new TypeError('Action order is invalid')
    const ids = orderedIds.map((id) => validateEntityId(id, 'Action ID'))
    const actions = await readProjectActions(projectId)
    if (ids.length !== actions.length || new Set(ids).size !== ids.length)
      throw new TypeError('Action order is invalid')
    const byId = new Map(actions.map((action) => [action.id, action]))
    const next: ProjectAction[] = []
    for (const id of ids) {
      const action = byId.get(id)
      if (!action) throw new TypeError('Action order is invalid')
      next.push(action)
    }
    await storage.write(projectActionsPath(projectId), { actions: next })
    return next
  })
  ipcMain.handle('config:update', async (_, input: unknown) => {
    const patch = validateAppConfigPatch(input)
    if (patch.agentBehaviorPrompt) {
      await storage.saveCioPrompt('work-ethics', patch.agentBehaviorPrompt)
    }
    const config = { ...(await storage.getConfig()), ...patch }
    await storage.saveConfig(config)
    if (patch.zoomLevel !== undefined) {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      if (win && !win.isDestroyed()) win.webContents.setZoomFactor(config.zoomLevel)
    }
    options.powerWakeService?.setEnabled(config.keepAwakeWhileWorking)
    options.retryScheduler?.setEnabled(config.autoRetryAfterReset)
    if (patch.sound && options.speechService) {
      options.speechService.updateUnloadOptions({
        asr: patch.sound.asrUnload,
        cleanup: patch.sound.cleanupUnload,
        tts: patch.sound.ttsUnload
      } as Record<string, unknown>)
    }
    return config
  })
  ipcMain.handle('config:syncAgentRole', async (_, role: unknown, selection: unknown) => {
    if (typeof role !== 'string' || !AGENT_ROLES.has(role as AgentRole)) {
      throw new TypeError('Invalid agent role')
    }
    const safeRole = role as AgentRole
    const safeSelection = validateAgentModelSelection(selection, `${safeRole} thread model`)
    const config = await storage.getConfig()
    if (!config.agentDefaults.syncFromThreadChanges) return config
    const updated: AppConfig = {
      ...config,
      agentDefaults: {
        ...config.agentDefaults,
        [safeRole]: safeSelection
      }
    }
    await storage.saveConfig(updated)
    return updated
  })
  ipcMain.handle('cioPrompts:list', () => storage.getCioPromptSettings())
  ipcMain.handle('cioPrompts:save', async (_, id: unknown, template: unknown) => {
    if (typeof id !== 'string' || !isCioPromptId(id)) throw new TypeError('Invalid CIO prompt ID')
    const safeTemplate = validateBoundedString(template, 'CIO prompt', 1, CIO_PROMPT_MAX_LENGTH)
    await storage.saveCioPrompt(id, safeTemplate)
    return storage.getCioPromptSettings()
  })
  ipcMain.handle('cioPrompts:reset', async (_, id: unknown) => {
    if (typeof id !== 'string' || !isCioPromptId(id)) throw new TypeError('Invalid CIO prompt ID')
    await storage.resetCioPrompt(id)
    return storage.getCioPromptSettings()
  })
  ipcMain.handle(
    'heartbeat:list',
    () => options.heartbeatScheduler?.list() ?? storage.getHeartbeats()
  )
  ipcMain.handle('heartbeat:create', async (_, input: unknown) => {
    const scheduler = options.heartbeatScheduler
    if (!scheduler) throw new Error('Heartbeat scheduler is not available')
    return scheduler.create(validateHeartbeatCreateInput(input))
  })
  ipcMain.handle('heartbeat:update', async (_, id: unknown, patch: unknown) => {
    const scheduler = options.heartbeatScheduler
    if (!scheduler) throw new Error('Heartbeat scheduler is not available')
    const safeId = validateBoundedString(id, 'Heartbeat ID', 1, 200)
    return scheduler.update(safeId, validateHeartbeatPatchInput(patch))
  })
  ipcMain.handle('heartbeat:trigger', async (_, id: unknown) => {
    const scheduler = options.heartbeatScheduler
    if (!scheduler) throw new Error('Heartbeat scheduler is not available')
    const safeId = validateBoundedString(id, 'Heartbeat ID', 1, 200)
    await scheduler.trigger(safeId)
  })
  ipcMain.handle('heartbeat:delete', async (_, id: unknown) => {
    const scheduler = options.heartbeatScheduler
    if (!scheduler) throw new Error('Heartbeat scheduler is not available')
    const safeId = validateBoundedString(id, 'Heartbeat ID', 1, 200)
    return scheduler.remove(safeId)
  })
  ipcMain.handle('heartbeat:toggle', async (_, id: unknown, enabled: unknown) => {
    const scheduler = options.heartbeatScheduler
    if (!scheduler) throw new Error('Heartbeat scheduler is not available')
    const safeId = validateBoundedString(id, 'Heartbeat ID', 1, 200)
    if (typeof enabled !== 'boolean')
      throw new TypeError('Heartbeat enabled flag must be a boolean')
    return scheduler.update(safeId, { enabled })
  })
  ipcMain.handle('workerNames:getSettings', () => storage.getWorkerNameSettings())
  ipcMain.handle('workerNames:saveCustom', async (_, input: unknown) => {
    if (!Array.isArray(input) || input.some((name) => typeof name !== 'string')) {
      throw new TypeError('Worker names must be a JSON array of strings')
    }
    const names = normalizeWorkerNames(input)
    if (!names || names.length === 0) {
      throw new TypeError('Worker names must include at least one name')
    }
    await storage.saveCustomWorkerNames(names)
  })
}
