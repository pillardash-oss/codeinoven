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
  validateLocalProfileAnalyticsRange
} from './config-helpers'
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import type { AgentRole, AppConfig } from '../../../lib/types'
import type { IpcHandlerContext } from './context'

const AGENT_ROLES = new Set<AgentRole>(['seniorEngineer', 'worker', 'auditor'])

export function registerConfigHandlers(ctx: IpcHandlerContext): void {
  const { storage, options, harnessUsageRepo, modelRankingRepo } = ctx

  // ─── Application config ────────────────────────────────────────────────
  ipcMain.handle('account:getLocalUsage', async (_, input: unknown) => {
    const range = validateLocalProfileAnalyticsRange(input)
    const analytics = await harnessUsageRepo.profileAnalytics(range)
    analytics.modelRankings = modelRankingRepo.analytics()
    analytics.gradingSpend = modelRankingRepo.gradingSpend()
    return analytics
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
    options.powerWakeService?.setRemoteEnabled(config.keepAwakeWhileRemoteConnected)
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
