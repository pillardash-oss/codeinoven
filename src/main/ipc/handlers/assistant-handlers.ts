import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import { validateEntityId } from '../ipc-validation'
import { requireString } from './shared'
import { broadcastMissedRunsChanged, broadcastRoutinesChanged } from '../../scheduler/assistant-events'
import type { IpcHandlerContext } from './context'
import type {
  CreateRoutineInput,
  RoutineConnection,
  RoutineSchedule,
  UpdateRoutineInput
} from '../../../lib/types'

const CADENCES = new Set(['once', 'hourly', 'daily', 'weekdays', 'weekly'])
const MAX_ROUTINE_NAME = 200
const MAX_HOW_TO = 100_000
const MAX_CONNECTIONS = 64
const MAX_TIMES = 24

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
    typeof record.onceAt === 'number' && Number.isFinite(record.onceAt)
      ? record.onceAt
      : undefined
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
      ...(typeof record.kind === 'string' ? { kind: record.kind.slice(0, 64) } : {})
    })
  }
  return result
}

function validateCreateInput(value: unknown): CreateRoutineInput {
  if (typeof value !== 'object' || value === null) throw new TypeError('Invalid routine input')
  const record = value as Record<string, unknown>
  return {
    name: requireString(record.name, 'Routine name').slice(0, MAX_ROUTINE_NAME),
    ...(typeof record.color === 'string' ? { color: record.color.slice(0, 32) } : {}),
    ...(typeof record.iconType === 'string' ? { iconType: record.iconType.slice(0, 64) } : {}),
    schedule: sanitizeSchedule(record.schedule),
    ...(typeof record.howTo === 'string' ? { howTo: record.howTo.slice(0, MAX_HOW_TO) } : {}),
    ...(record.connections !== undefined ? { connections: sanitizeConnections(record.connections) } : {})
  }
}

function validateUpdateInput(value: unknown): UpdateRoutineInput {
  if (typeof value !== 'object' || value === null) throw new TypeError('Invalid routine patch')
  const record = value as Record<string, unknown>
  const patch: UpdateRoutineInput = {}
  if (record.name !== undefined) {
    patch.name = requireString(record.name, 'Routine name').slice(0, MAX_ROUTINE_NAME)
  }
  if (record.color !== undefined) patch.color = requireString(record.color, 'Routine colour').slice(0, 32)
  if (record.icon !== undefined) {
    patch.icon = record.icon === null ? null : requireString(record.icon, 'Routine icon').slice(0, 200)
  }
  if (record.iconType !== undefined) {
    patch.iconType = requireString(record.iconType, 'Routine icon type').slice(0, 64)
  }
  if (record.schedule !== undefined) patch.schedule = sanitizeSchedule(record.schedule)
  if (record.howTo !== undefined) {
    if (typeof record.howTo !== 'string') throw new TypeError('Routine how-to must be a string')
    patch.howTo = record.howTo.slice(0, MAX_HOW_TO)
  }
  if (record.connections !== undefined) patch.connections = sanitizeConnections(record.connections)
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

  ipcMain.handle('routine:ensureSpace', () => projectManager.ensureAssistantSpace())
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

  ipcMain.handle('routine:delete', (_, routineId: unknown) => {
    routineManager.deleteRoutine(validateEntityId(routineId, 'Routine ID'))
    broadcastRoutines()
  })

  ipcMain.handle('routine:reorder', (_, orderedIds: unknown) => {
    if (!Array.isArray(orderedIds)) throw new TypeError('Routine order must be an array')
    const ids = orderedIds.map((id) => validateEntityId(id, 'Routine ID'))
    const routines = routineManager.reorderRoutines(ids)
    broadcastRoutines()
    return routines
  })

  ipcMain.handle('assistant:setTaskRoutine', (_, threadId: unknown, routineId: unknown) => {
    const safeThreadId = validateEntityId(threadId, 'Thread ID')
    const safeRoutineId = routineId === null ? null : validateEntityId(routineId, 'Routine ID')
    return routineManager.setTaskRoutine(safeThreadId, safeRoutineId)
  })

  ipcMain.handle('assistant:setTaskSchedule', (_, threadId: unknown, schedule: unknown) => {
    const safeThreadId = validateEntityId(threadId, 'Thread ID')
    return routineManager.setTaskScheduleOverride(safeThreadId, sanitizeSchedule(schedule))
  })

  ipcMain.handle('assistant:listMissedRuns', () => requireScheduler().listMissedRuns())

  ipcMain.handle('assistant:dismissMissedRun', (_, id: unknown) => {
    const scheduler = requireScheduler()
    scheduler.dismissMissedRun(requireString(id, 'Missed run ID').slice(0, 300))
    broadcastMissedRunsChanged(scheduler.listMissedRuns())
  })

  ipcMain.handle('assistant:runMissedRunNow', async (_, id: unknown) => {
    const scheduler = requireScheduler()
    await scheduler.runMissedRunNow(requireString(id, 'Missed run ID').slice(0, 300))
    broadcastMissedRunsChanged(scheduler.listMissedRuns())
  })
}
