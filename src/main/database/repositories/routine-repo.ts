import type { Database } from '../database'
import type {
  Routine,
  RoutineAgents,
  RoutineConnection,
  RoutineDelivery,
  RoutinePriority,
  RoutineSchedule
} from '../../../lib/types'
import { normalizePlanDelivery, normalizePlanPriority } from '../../../lib/routine-reporting'

interface RoutineRow {
  id: string
  name: string
  description: string | null
  color: string | null
  icon: string | null
  icon_type: string | null
  custom_svg: string | null
  schedule: string | null
  schedule_updated_at: number | null
  how_to: string
  how_to_updated_at: number | null
  connections: string
  delivery: string | null
  priority: string | null
  agents: string | null
  paused: number
  pinned: number
  pinned_at: number | null
  sort_order: number | null
  created_at: number
  updated_at: number
}

function parseSchedule(raw: string | null): RoutineSchedule | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as RoutineSchedule
    return parsed && typeof parsed === 'object' && typeof parsed.cadence === 'string'
      ? parsed
      : null
  } catch {
    return null
  }
}

function parseConnections(raw: string): RoutineConnection[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (entry): entry is RoutineConnection =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as RoutineConnection).utilityId === 'string' &&
          typeof (entry as RoutineConnection).label === 'string'
      )
      .map((entry) => (entry.required ? { ...entry, required: true } : { ...entry }))
  } catch {
    return []
  }
}

function parseAgents(raw: string | null): RoutineAgents | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as { primary?: unknown; fallbacks?: unknown }
    const fallbacks = Array.isArray(record.fallbacks)
      ? record.fallbacks.filter(isModelSelection)
      : []
    const primary = isModelSelection(record.primary) ? record.primary : undefined
    if (!primary && fallbacks.length === 0) return undefined
    return { ...(primary ? { primary } : {}), fallbacks }
  } catch {
    return undefined
  }
}

/**
 * Read the stored delivery, validated through the shared normaliser so a row
 * written by an older build cannot surface a channel the app no longer knows.
 */
function parseDelivery(raw: string | null): RoutineDelivery | undefined {
  if (!raw) return undefined
  try {
    return normalizePlanDelivery(JSON.parse(raw)) ?? undefined
  } catch {
    return undefined
  }
}

/** Read the stored priority, validated through the shared normaliser. */
function parsePriority(raw: string | null): RoutinePriority | undefined {
  if (!raw) return undefined
  try {
    return normalizePlanPriority(JSON.parse(raw)) ?? undefined
  } catch {
    return undefined
  }
}

/** Whether a persisted value is a usable model selection. */
function isModelSelection(value: unknown): value is RoutineAgents['fallbacks'][number] {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.harnessId === 'string' &&
    typeof record.providerId === 'string' &&
    typeof record.modelId === 'string'
  )
}

function rowToRoutine(row: RoutineRow): Routine {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    color: row.color ?? undefined,
    icon: row.icon ?? undefined,
    iconType: row.icon_type ?? undefined,
    customSvg: row.custom_svg ?? undefined,
    schedule: parseSchedule(row.schedule),
    scheduleUpdatedAt: row.schedule_updated_at ?? undefined,
    howTo: row.how_to ?? '',
    howToUpdatedAt: row.how_to_updated_at ?? undefined,
    connections: parseConnections(row.connections),
    delivery: parseDelivery(row.delivery ?? null),
    priority: parsePriority(row.priority ?? null),
    agents: parseAgents(row.agents ?? null),
    paused: row.paused === 1,
    pinned: row.pinned === 1,
    pinnedAt: row.pinned_at ?? undefined,
    sortOrder: row.sort_order ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class RoutineRepo {
  constructor(private db: Database) {}

  upsert(routine: Routine): void {
    this.db.run(
      `INSERT INTO routines(
        id, name, description, color, icon, icon_type, custom_svg, schedule, schedule_updated_at, how_to,
        how_to_updated_at, connections, delivery, priority, agents, paused, pinned, pinned_at,
        sort_order, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        color = excluded.color,
        icon = excluded.icon,
        icon_type = excluded.icon_type,
        custom_svg = excluded.custom_svg,
        schedule = excluded.schedule,
        schedule_updated_at = excluded.schedule_updated_at,
        how_to = excluded.how_to,
        how_to_updated_at = excluded.how_to_updated_at,
        connections = excluded.connections,
        delivery = excluded.delivery,
        priority = excluded.priority,
        agents = excluded.agents,
        paused = excluded.paused,
        pinned = excluded.pinned,
        pinned_at = excluded.pinned_at,
        sort_order = excluded.sort_order,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
      routine.id,
      routine.name,
      routine.description ?? null,
      routine.color ?? null,
      routine.icon ?? null,
      routine.iconType ?? null,
      routine.customSvg ?? null,
      routine.schedule ? JSON.stringify(routine.schedule) : null,
      routine.scheduleUpdatedAt ?? null,
      routine.howTo ?? '',
      routine.howToUpdatedAt ?? null,
      JSON.stringify(routine.connections ?? []),
      routine.delivery ? JSON.stringify(routine.delivery) : null,
      routine.priority ? JSON.stringify(routine.priority) : null,
      routine.agents ? JSON.stringify(routine.agents) : null,
      routine.paused ? 1 : 0,
      routine.pinned ? 1 : 0,
      routine.pinnedAt ?? null,
      routine.sortOrder ?? null,
      routine.createdAt,
      routine.updatedAt
    )
  }

  get(id: string): Routine | null {
    const row = this.db.get<RoutineRow>('SELECT * FROM routines WHERE id = ?', id)
    return row ? rowToRoutine(row) : null
  }

  list(): Routine[] {
    return this.db
      .all<RoutineRow>(
        'SELECT * FROM routines ORDER BY pinned DESC, pinned_at DESC, sort_order ASC, updated_at DESC'
      )
      .map(rowToRoutine)
  }

  delete(id: string): void {
    this.db.run('DELETE FROM routines WHERE id = ?', id)
  }
}
