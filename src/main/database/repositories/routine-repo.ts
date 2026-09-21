import type { Database } from '../database'
import type { Routine, RoutineConnection, RoutineSchedule } from '../../../lib/types'

interface RoutineRow {
  id: string
  name: string
  color: string | null
  icon: string | null
  icon_type: string | null
  schedule: string | null
  how_to: string
  how_to_updated_at: number | null
  connections: string
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
    return parsed && typeof parsed === 'object' && typeof parsed.cadence === 'string' ? parsed : null
  } catch {
    return null
  }
}

function parseConnections(raw: string): RoutineConnection[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is RoutineConnection =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as RoutineConnection).utilityId === 'string' &&
        typeof (entry as RoutineConnection).label === 'string'
    )
  } catch {
    return []
  }
}

function rowToRoutine(row: RoutineRow): Routine {
  return {
    id: row.id,
    name: row.name,
    color: row.color ?? undefined,
    icon: row.icon ?? undefined,
    iconType: row.icon_type ?? undefined,
    schedule: parseSchedule(row.schedule),
    howTo: row.how_to ?? '',
    howToUpdatedAt: row.how_to_updated_at ?? undefined,
    connections: parseConnections(row.connections),
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
        id, name, color, icon, icon_type, schedule, how_to, how_to_updated_at,
        connections, pinned, pinned_at, sort_order, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        color = excluded.color,
        icon = excluded.icon,
        icon_type = excluded.icon_type,
        schedule = excluded.schedule,
        how_to = excluded.how_to,
        how_to_updated_at = excluded.how_to_updated_at,
        connections = excluded.connections,
        pinned = excluded.pinned,
        pinned_at = excluded.pinned_at,
        sort_order = excluded.sort_order,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
      routine.id,
      routine.name,
      routine.color ?? null,
      routine.icon ?? null,
      routine.iconType ?? null,
      routine.schedule ? JSON.stringify(routine.schedule) : null,
      routine.howTo ?? '',
      routine.howToUpdatedAt ?? null,
      JSON.stringify(routine.connections ?? []),
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
