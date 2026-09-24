import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import { validateEntityId } from '../ipc-validation'
import { requireString } from './shared'
import { ROUTINE_NEXT_STEPS_PROMPT } from '../../../lib/assistant-next-steps'
import { routinePrimaryModel, settingsWithRoutineModel } from '../../../lib/routine-agents'
import {
  ROUTINE_DELIVERY_CHANNEL_IDS,
  ROUTINE_IMPACT_IDS,
  ROUTINE_TIMELINESS_IDS
} from '../../../lib/routine-reporting'
import {
  broadcastMissedRunsChanged,
  broadcastRoutinesChanged
} from '../../scheduler/assistant-events'
import { broadcastThreadUpdate } from '../../chat/thread-events'
import type { IpcHandlerContext } from './context'
import type {
  CreateRoutineInput,
  RoutineAgents,
  RoutineConnection,
  RoutineDelivery,
  RoutineDeliveryChannel,
  RoutineImpact,
  RoutinePriority,
  RoutineSchedule,
  RoutineTimeliness,
  UpdateRoutineInput
} from '../../../lib/types'

const CADENCES = new Set(['once', 'hourly', 'daily', 'weekdays', 'weekly'])
const DELIVERY_CHANNELS = new Set<string>(ROUTINE_DELIVERY_CHANNEL_IDS)
const TIMELINESS_BRACKETS = new Set<string>(ROUTINE_TIMELINESS_IDS)
const IMPACT_BRACKETS = new Set<string>(ROUTINE_IMPACT_IDS)
const MAX_ROUTINE_NAME = 200
const MAX_ROUTINE_DESCRIPTION = 2000
const MAX_HOW_TO = 100_000
const MAX_CONNECTIONS = 64
const MAX_CONNECTION_SETUP = 4_000
const MAX_TIMES = 24
const MAX_FALLBACKS = 12
const MAX_DELIVERY_TARGET = 300
const MAX_DELIVERY_NOTE = 1_000

/** Parse one `HH:mm` value, returning null when malformed. */
function parseTime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/** Validate an untrusted schedule value into a RoutineSchedule, or null to clear. */
function sanitizeSchedule(value: unknown): RoutineSchedule | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') throw new TypeError('Schedule must be an object or null')
  const record = value as Record<string, unknown>
  const cadence = typeof record.cadence === 'string' ? record.cadence : ''
  if (!CADENCES.has(cadence)) throw new TypeError('Schedule cadence is invalid')
  const times: string[] = []
  if (Array.isArray(record.times)) {
    for (const entry of record.times.slice(0, MAX_TIMES)) {
      const parsed = parseTime(entry)
      if (parsed && !times.includes(parsed)) times.push(parsed)
    }
  }
  const weekdays = Array.isArray(record.weekdays)
    ? record.weekdays.filter(
        (day): day is number => typeof day === 'number' && day >= 0 && day <= 6
      )
    : undefined
  const onceAt =
    typeof record.onceAt === 'number' && Number.isFinite(record.onceAt) ? record.onceAt : undefined
  return {
    cadence: cadence as RoutineSchedule['cadence'],
    times: times.sort(),
    ...(weekdays ? { weekdays } : {}),
    ...(onceAt !== undefined ? { onceAt } : {})
  }
}

function sanitizeConnections(value: unknown): RoutineConnection[] {
  if (!Array.isArray(value)) return []
  const result: RoutineConnection[] = []
  for (const entry of value.slice(0, MAX_CONNECTIONS)) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.utilityId !== 'string' || typeof record.label !== 'string') continue
    result.push({
      utilityId: record.utilityId.slice(0, 200),
      label: record.label.slice(0, 200),
      ...(typeof record.kind === 'string' ? { kind: record.kind.slice(0, 64) } : {}),
      ...(record.required === true ? { required: true } : {}),
      ...(typeof record.setup === 'string'
        ? { setup: record.setup.slice(0, MAX_CONNECTION_SETUP) }
        : {})
    })
  }
  return result
}

/** One model selection: harness, provider, and model are required. */
function sanitizeModelSelection(value: unknown): RoutineAgents['fallbacks'][number] | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (
    typeof record.harnessId !== 'string' ||
    typeof record.providerId !== 'string' ||
    typeof record.modelId !== 'string'
  ) {
    return null
  }
  return {
    harnessId: record.harnessId.slice(0, 64),
    providerId: record.providerId.slice(0, 128),
    modelId: record.modelId.slice(0, 200),
    ...(typeof record.accountId === 'string' ? { accountId: record.accountId.slice(0, 200) } : {}),
    ...(typeof record.thinkingLevel === 'string'
      ? {
          thinkingLevel: record.thinkingLevel.slice(
            0,
            16
          ) as RoutineAgents['fallbacks'][number]['thinkingLevel']
        }
      : {})
  }
}

/** Validate an untrusted model set, or null to clear it. */
function sanitizeAgents(value: unknown): RoutineAgents | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') throw new TypeError('Routine agents must be an object or null')
  const record = value as Record<string, unknown>
  const primary = record.primary === undefined ? null : sanitizeModelSelection(record.primary)
  const fallbacks = Array.isArray(record.fallbacks)
    ? record.fallbacks
        .slice(0, MAX_FALLBACKS)
        .map(sanitizeModelSelection)
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    : []
  return { ...(primary ? { primary } : {}), fallbacks }
}

/**
 * Validate an untrusted delivery value into a RoutineDelivery, or null to clear
 * it. The channel must be one the app knows, so a routine is never handed a
 * delivery nothing can honour. A target is capped, and dropped for the in-app
 * channel, which has no destination to name.
 */
function sanitizeDelivery(value: unknown): RoutineDelivery | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') throw new TypeError('Routine delivery must be an object or null')
  const record = value as Record<string, unknown>
  const channel = typeof record.channel === 'string' ? record.channel.trim() : ''
  if (!DELIVERY_CHANNELS.has(channel)) {
    throw new TypeError('Routine delivery channel is invalid')
  }
  const typed = channel as RoutineDeliveryChannel
  const target =
    typeof record.target === 'string' ? record.target.trim().slice(0, MAX_DELIVERY_TARGET) : ''
  const note = typeof record.note === 'string' ? record.note.trim().slice(0, MAX_DELIVERY_NOTE) : ''
  return {
    channel: typed,
    ...(target && typed !== 'in-app' ? { target } : {}),
    ...(note ? { note } : {})
  }
}

/**
 * Validate an untrusted priority value into a RoutinePriority, or null to clear
 * it. Both brackets must resolve, so a routine never carries half an urgency.
 */
function sanitizePriority(value: unknown): RoutinePriority | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') throw new TypeError('Routine priority must be an object or null')
  const record = value as Record<string, unknown>
  const timeliness = typeof record.timeliness === 'string' ? record.timeliness.trim() : ''
  const impact = typeof record.impact === 'string' ? record.impact.trim() : ''
  if (!TIMELINESS_BRACKETS.has(timeliness)) {
    throw new TypeError('Routine timeliness bracket is invalid')
  }
  if (!IMPACT_BRACKETS.has(impact)) {
    throw new TypeError('Routine impact bracket is invalid')
  }
  return {
    timeliness: timeliness as RoutineTimeliness,
    impact: impact as RoutineImpact
  }
}

function validateCreateInput(value: unknown): CreateRoutineInput {
  if (typeof value !== 'object' || value === null) throw new TypeError('Invalid routine input')
  const record = value as Record<string, unknown>
  return {
    name: requireString(record.name, 'Routine name').slice(0, MAX_ROUTINE_NAME),
    ...(typeof record.description === 'string'
      ? { description: record.description.slice(0, MAX_ROUTINE_DESCRIPTION) }
      : {}),
    ...(typeof record.color === 'string' ? { color: record.color.slice(0, 32) } : {}),
    ...(typeof record.iconType === 'string' ? { iconType: record.iconType.slice(0, 64) } : {}),
    schedule: sanitizeSchedule(record.schedule),
    ...(typeof record.howTo === 'string' ? { howTo: record.howTo.slice(0, MAX_HOW_TO) } : {}),
    ...(record.connections !== undefined
      ? { connections: sanitizeConnections(record.connections) }
      : {}),
    ...(record.agents !== undefined ? { agents: sanitizeAgents(record.agents) ?? undefined } : {}),
    ...(record.delivery !== undefined
      ? { delivery: sanitizeDelivery(record.delivery) ?? undefined }
      : {}),
    ...(record.priority !== undefined
      ? { priority: sanitizePriority(record.priority) ?? undefined }
      : {}),
    ...(typeof record.paused === 'boolean' ? { paused: record.paused } : {})
  }
}

function validateUpdateInput(value: unknown): UpdateRoutineInput {
  if (typeof value !== 'object' || value === null) throw new TypeError('Invalid routine patch')
  const record = value as Record<string, unknown>
  const patch: UpdateRoutineInput = {}
  if (record.name !== undefined) {
    patch.name = requireString(record.name, 'Routine name').slice(0, MAX_ROUTINE_NAME)
  }
  if (record.description !== undefined) {
    patch.description =
      record.description === null
        ? null
        : requireString(record.description, 'Routine description', true).slice(
            0,
            MAX_ROUTINE_DESCRIPTION
          )
  }
  if (record.color !== undefined) {
    patch.color =
      record.color === null ? null : requireString(record.color, 'Routine colour').slice(0, 32)
  }
  if (record.icon !== undefined) {
    patch.icon =
      record.icon === null ? null : requireString(record.icon, 'Routine icon').slice(0, 200)
  }
  if (record.iconType !== undefined) {
    patch.iconType =
      record.iconType === null
        ? null
        : requireString(record.iconType, 'Routine icon type').slice(0, 64)
  }
  if (record.schedule !== undefined) patch.schedule = sanitizeSchedule(record.schedule)
  if (record.howTo !== undefined) {
    if (typeof record.howTo !== 'string') throw new TypeError('Routine how-to must be a string')
    patch.howTo = record.howTo.slice(0, MAX_HOW_TO)
  }
  if (record.connections !== undefined) patch.connections = sanitizeConnections(record.connections)
  if (record.agents !== undefined) {
    const agents = sanitizeAgents(record.agents)
    if (agents) patch.agents = agents
  }
  if (record.delivery !== undefined) patch.delivery = sanitizeDelivery(record.delivery)
  if (record.priority !== undefined) patch.priority = sanitizePriority(record.priority)
  if (typeof record.paused === 'boolean') patch.paused = record.paused
  return patch
}

/**
 * Assistant View IPC   routine CRUD, task grouping, and missed-run actions.
 *
 * Task creation/listing/forking live on the existing thread channels; these
 * cover only the routine layer and the scheduler's missed-run surface.
 */
export function registerAssistantHandlers(ctx: IpcHandlerContext): void {
  const { projectManager, routineManager, routineScheduler } = ctx

  const requireScheduler = () => {
    if (!routineScheduler) throw new Error('The assistant scheduler is not available')
    return routineScheduler
  }

  const broadcastRoutines = () => broadcastRoutinesChanged(routineManager.listRoutines())

  // Registered on the hydration surface when the bootstrap already owns it, so
  // Assistant View's first hydration pass never awaits the post-paint graph just
  // to guarantee the hidden assistant container exists.
  if (!ctx.options.hydrationHandlersRegistered) {
    ipcMain.handle('routine:ensureSpace', () => projectManager.ensureAssistantSpace())
  }
  ipcMain.handle('routine:list', () => routineManager.listRoutines())

  ipcMain.handle('routine:create', (_, input: unknown) => {
    const routine = routineManager.createRoutine(validateCreateInput(input))
    broadcastRoutines()
    return routine
  })

  ipcMain.handle('routine:update', (_, routineId: unknown, input: unknown) => {
    const safeId = validateEntityId(routineId, 'Routine ID')
    const routine = routineManager.updateRoutine(safeId, validateUpdateInput(input))
    broadcastRoutines()
    return routine
  })

  ipcMain.handle('routine:delete', async (_, routineId: unknown) => {
    // The routine's threads   its hidden how-to thread included   are deleted
    // with it; the thread:deleted broadcasts prune every open surface.
    await routineManager.deleteRoutine(validateEntityId(routineId, 'Routine ID'))
    broadcastRoutines()
  })

  ipcMain.handle('routine:reorder', (_, orderedIds: unknown) => {
    if (!Array.isArray(orderedIds)) throw new TypeError('Routine order must be an array')
    const ids = orderedIds.map((id) => validateEntityId(id, 'Routine ID'))
    const routines = routineManager.reorderRoutines(ids)
    broadcastRoutines()
    return routines
  })

  ipcMain.handle('routine:setPinned', (_, routineId: unknown, pinned: unknown) => {
    if (typeof pinned !== 'boolean') throw new TypeError('Routine pin state must be a boolean')
    const routine = routineManager.setPinned(validateEntityId(routineId, 'Routine ID'), pinned)
    broadcastRoutines()
    return routine
  })

  ipcMain.handle('routine:setIcon', async (_, routineId: unknown, sourcePath: unknown) => {
    const routine = await routineManager.setIcon(
      validateEntityId(routineId, 'Routine ID'),
      requireString(sourcePath, 'Routine icon path')
    )
    broadcastRoutines()
    return routine
  })

  ipcMain.handle('routine:clearIcon', async (_, routineId: unknown) => {
    const routine = await routineManager.clearIcon(validateEntityId(routineId, 'Routine ID'))
    broadcastRoutines()
    return routine
  })

  ipcMain.handle('routine:getIcon', (_, routineId: unknown) =>
    routineManager.getIconDataUrl(validateEntityId(routineId, 'Routine ID'))
  )

  ipcMain.handle('assistant:setTaskRoutine', (_, threadId: unknown, routineId: unknown) => {
    const safeThreadId = validateEntityId(threadId, 'Thread ID')
    const safeRoutineId = routineId === null ? null : validateEntityId(routineId, 'Routine ID')
    return routineManager.setTaskRoutine(safeThreadId, safeRoutineId)
  })

  ipcMain.handle('assistant:howToThread', (_, routineId: unknown) =>
    routineManager.howToThread(validateEntityId(routineId, 'Routine ID'))
  )

  /**
   * The getting-started checkpoint the authoring agent keeps current, for the
   * how-to panel. Read-only: the interview's own turn owns the write.
   */
  ipcMain.handle('routine:gettingStartedCheckpoint', (_, routineId: unknown) => {
    const chatEngine = ctx.chatEngine
    if (!chatEngine) return null
    return chatEngine.readRoutineCheckpoint(validateEntityId(routineId, 'Routine ID'))
  })

  ipcMain.handle('assistant:setHowToHidden', (_, routineId: unknown, hidden: unknown) => {
    if (typeof hidden !== 'boolean') throw new TypeError('How-to hidden state must be a boolean')
    const thread = routineManager.setHowToHidden(validateEntityId(routineId, 'Routine ID'), hidden)
    // The row moved in or out of the archived set, so every renderer needs the
    // fresh thread to drop or restore the row without a reload.
    broadcastThreadUpdate(thread)
    return thread
  })

  ipcMain.handle('assistant:setTaskSchedule', (_, threadId: unknown, schedule: unknown) => {
    const safeThreadId = validateEntityId(threadId, 'Thread ID')
    return routineManager.setTaskScheduleOverride(safeThreadId, sanitizeSchedule(schedule))
  })

  ipcMain.handle('assistant:listMissedRuns', () => requireScheduler().listMissedRuns())

  /**
   * Post the saved-how-to next-steps turn into the routine's Getting started
   * thread. Hidden internal turn: the user sees the agent's prose list, never a
   * user bubble. A routine with no Getting started thread, a hidden one, or a
   * thread with no bound settings makes this a no-op.
   */
  ipcMain.handle('assistant:postSetup', async (_, routineId: unknown) => {
    const id = validateEntityId(routineId, 'Routine ID')
    const routine = routineManager.getRoutine(id)
    const thread = routineManager.howToThread(id)
    const chatEngine = ctx.chatEngine
    if (!routine || !thread || thread.archived || !thread.settings || !chatEngine) return
    const primary = routinePrimaryModel(routine.agents)
    const settings = primary ? settingsWithRoutineModel(thread.settings, primary) : thread.settings
    await chatEngine.sendPrompt(
      thread.projectId,
      thread.id,
      settings,
      ROUTINE_NEXT_STEPS_PROMPT,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'internal'
    )
  })

  ipcMain.handle('assistant:dismissMissedRun', (_, id: unknown) => {
    const scheduler = requireScheduler()
    scheduler.dismissMissedRun(requireString(id, 'Missed run ID').slice(0, 300))
    broadcastMissedRunsChanged(scheduler.listMissedRuns())
  })

  ipcMain.handle('assistant:runMissedRunNow', async (_, id: unknown) => {
    const scheduler = requireScheduler()
    const run = await scheduler.runMissedRunNow(requireString(id, 'Missed run ID').slice(0, 300))
    broadcastMissedRunsChanged(scheduler.listMissedRuns())
    return run
  })

  ipcMain.handle('assistant:runRoutineNow', async (_, routineId: unknown) => {
    const scheduler = requireScheduler()
    return scheduler.runRoutineNow(validateEntityId(routineId, 'Routine ID'))
  })
}
