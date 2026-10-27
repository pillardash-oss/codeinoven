import { unarchivedEntitySql } from '../../../lib/archives'
import type { Database } from '../database'
import type {
  Assistant,
  AssistantAgents,
  AssistantConnection,
  AssistantDelivery,
  AssistantExecution,
  AssistantPriority,
  AssistantSchedule
} from '../../../lib/types'
import { normalizePlanDelivery, normalizePlanPriority } from '../../../lib/assistant-reporting'

interface AssistantRow {
  id: string
  name: string
  description: string | null
  scheduled: number
  schedule_name: string | null
  color: string | null
  icon: string | null
  icon_type: string | null
  custom_svg: string | null
  schedule: string | null
  schedule_updated_at: number | null
  knowledge: string
  knowledge_updated_at: number | null
  connections: string
  delivery: string | null
  priority: string | null
  agents: string | null
  execution: string | null
  paused: number
  pinned: number
  pinned_at: number | null
  sort_order: number | null
  created_at: number
  updated_at: number
}

function parseSchedule(raw: string | null): AssistantSchedule | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as AssistantSchedule
    return parsed && typeof parsed === 'object' && typeof parsed.cadence === 'string'
      ? parsed
      : null
  } catch {
    return null
  }
}

function parseConnections(raw: string): AssistantConnection[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (entry): entry is AssistantConnection =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as AssistantConnection).utilityId === 'string' &&
          typeof (entry as AssistantConnection).label === 'string'
      )
      .map((entry) => (entry.required ? { ...entry, required: true } : { ...entry }))
  } catch {
    return []
  }
}

function parseAgents(raw: string | null): AssistantAgents | undefined {
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
function parseDelivery(raw: string | null): AssistantDelivery | undefined {
  if (!raw) return undefined
  try {
    return normalizePlanDelivery(JSON.parse(raw)) ?? undefined
  } catch {
    return undefined
  }
}

/** Read the stored priority, validated through the shared normaliser. */
function parsePriority(raw: string | null): AssistantPriority | undefined {
  if (!raw) return undefined
  try {
    return normalizePlanPriority(JSON.parse(raw)) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Read the stored execution target. A missing or malformed value means this
 * computer, so an older row and a corrupt one both fall back to local instead
 * of failing the whole assistant read.
 */
function parseExecution(raw: string | null): AssistantExecution | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    if (typeof record.ovenId !== 'string' || !record.ovenId) return undefined
    return {
      ovenId: record.ovenId,
      ...(typeof record.ovenPath === 'string' && record.ovenPath
        ? { ovenPath: record.ovenPath }
        : {})
    }
  } catch {
    return undefined
  }
}

/** Whether a persisted value is a usable model selection. */
function isModelSelection(value: unknown): value is AssistantAgents['fallbacks'][number] {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.harnessId === 'string' &&
    typeof record.providerId === 'string' &&
    typeof record.modelId === 'string'
  )
}

function rowToAssistant(row: AssistantRow): Assistant {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    scheduled: row.scheduled !== 0,
    scheduleName: row.schedule_name ?? undefined,
    color: row.color ?? undefined,
    icon: row.icon ?? undefined,
    iconType: row.icon_type ?? undefined,
    customSvg: row.custom_svg ?? undefined,
    schedule: parseSchedule(row.schedule),
    scheduleUpdatedAt: row.schedule_updated_at ?? undefined,
    knowledge: row.knowledge ?? '',
    knowledgeUpdatedAt: row.knowledge_updated_at ?? undefined,
    connections: parseConnections(row.connections),
    delivery: parseDelivery(row.delivery ?? null),
    priority: parsePriority(row.priority ?? null),
    agents: parseAgents(row.agents ?? null),
    execution: parseExecution(row.execution ?? null),
    paused: row.paused === 1,
    pinned: row.pinned === 1,
    pinnedAt: row.pinned_at ?? undefined,
    sortOrder: row.sort_order ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class AssistantRepo {
  constructor(private db: Database) {}

  upsert(assistant: Assistant): void {
    this.db.run(
      `INSERT INTO assistants(
        id, name, description, scheduled, schedule_name, color, icon, icon_type, custom_svg, schedule, schedule_updated_at, knowledge,
        knowledge_updated_at, connections, delivery, priority, agents, execution, paused, pinned,
        pinned_at, sort_order, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        scheduled = excluded.scheduled,
        schedule_name = excluded.schedule_name,
        color = excluded.color,
        icon = excluded.icon,
        icon_type = excluded.icon_type,
        custom_svg = excluded.custom_svg,
        schedule = excluded.schedule,
        schedule_updated_at = excluded.schedule_updated_at,
        knowledge = excluded.knowledge,
        knowledge_updated_at = excluded.knowledge_updated_at,
        connections = excluded.connections,
        delivery = excluded.delivery,
        priority = excluded.priority,
        agents = excluded.agents,
        execution = excluded.execution,
        paused = excluded.paused,
        pinned = excluded.pinned,
        pinned_at = excluded.pinned_at,
        sort_order = excluded.sort_order,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
      assistant.id,
      assistant.name,
      assistant.description ?? null,
      assistant.scheduled === false ? 0 : 1,
      assistant.scheduleName ?? null,
      assistant.color ?? null,
      assistant.icon ?? null,
      assistant.iconType ?? null,
      assistant.customSvg ?? null,
      assistant.schedule ? JSON.stringify(assistant.schedule) : null,
      assistant.scheduleUpdatedAt ?? null,
      assistant.knowledge ?? '',
      assistant.knowledgeUpdatedAt ?? null,
      JSON.stringify(assistant.connections ?? []),
      assistant.delivery ? JSON.stringify(assistant.delivery) : null,
      assistant.priority ? JSON.stringify(assistant.priority) : null,
      assistant.agents ? JSON.stringify(assistant.agents) : null,
      assistant.execution ? JSON.stringify(assistant.execution) : null,
      assistant.paused ? 1 : 0,
      assistant.pinned ? 1 : 0,
      assistant.pinnedAt ?? null,
      assistant.sortOrder ?? null,
      assistant.createdAt,
      assistant.updatedAt
    )
  }

  get(id: string): Assistant | null {
    const row = this.db.get<AssistantRow>('SELECT * FROM assistants WHERE id = ?', id)
    return row ? rowToAssistant(row) : null
  }

  /** Patch the clock choice without overwriting concurrent icon or identity edits. */
  updateScheduled(id: string, scheduled: boolean, updatedAt: number): void {
    this.db.run(
      scheduled
        ? 'UPDATE assistants SET scheduled = 1, updated_at = ? WHERE id = ?'
        : 'UPDATE assistants SET scheduled = 0, schedule = NULL, schedule_name = NULL, schedule_updated_at = NULL, updated_at = ? WHERE id = ?',
      [updatedAt, id]
    )
  }

  /** Patch only settled reporting columns, preserving concurrent panel edits. */
  updateReporting(
    id: string,
    reporting: Partial<Pick<Assistant, 'delivery' | 'priority'>>,
    updatedAt: number
  ): void {
    const fields: string[] = []
    const values: (string | number)[] = []
    if (reporting.delivery !== undefined) {
      fields.push('delivery = ?')
      values.push(JSON.stringify(reporting.delivery))
    }
    if (reporting.priority !== undefined) {
      fields.push('priority = ?')
      values.push(JSON.stringify(reporting.priority))
    }
    if (fields.length === 0) return
    fields.push('updated_at = ?')
    this.db.run(`UPDATE assistants SET ${fields.join(', ')} WHERE id = ?`, [
      ...values,
      updatedAt,
      id
    ])
  }

  /**
   * Rename an assistant from the setup conversation, the moment the user names it.
   *
   * Narrower than `upsert` on purpose. The capability that calls this may only
   * rename the assistant, so it can never clobber a schedule, a connection set or a
   * knowledge that the panel is editing in the same window. Only the field the
   * caller passes is touched.
   */
  updateIdentity(id: string, identity: { name?: string }, updatedAt: number): Assistant | null {
    const existing = this.get(id)
    if (!existing) return null
    const next: Assistant = {
      ...existing,
      ...(identity.name !== undefined ? { name: identity.name } : {}),
      updatedAt
    }
    this.upsert(next)
    return next
  }

  /**
   * One assistant, read on the worker's connection. Interaction paths (a settled
   * run's notification naming its assistant, say) use this instead of `get`, so a
   * synchronous read never holds the Electron main thread.
   */
  async getViaWorker(id: string): Promise<Assistant | null> {
    const result = await this.db.queryViaWorker('SELECT * FROM assistants WHERE id = ?', [id], 1)
    if (!result.ok) return null
    const row = (result.rows as unknown as AssistantRow[])[0]
    return row ? rowToAssistant(row) : null
  }

  /**
   * Every assistant, in a stable storage order. Sidebar order is applied on top
   * of this by `AssistantManager.listAssistants` through the shared comparator, so
   * this one never has to agree with the sidebar about anything but being
   * deterministic.
   */
  list(): Assistant[] {
    return this.db
      .all<AssistantRow>(
        `SELECT * FROM assistants WHERE ${unarchivedEntitySql('assistant', 'assistants')} ORDER BY created_at DESC, id ASC`
      )
      .map(rowToAssistant)
  }

  /**
   * Every assistant, read on the database worker.
   *
   * For a background service that must not touch SQLite on the main thread
   * (see `docs/APP-BIBLE.md`): the same rows as `list()`, read where a page
   * fault or a WAL wait cannot stall a frame.
   */
  async listViaWorker(): Promise<Assistant[]> {
    const result = await this.db.queryViaWorker(
      `SELECT * FROM assistants WHERE ${unarchivedEntitySql('assistant', 'assistants')} ORDER BY created_at DESC, id ASC`,
      [],
      0
    )
    if (!result.ok) return []
    return (result.rows as unknown as AssistantRow[]).map(rowToAssistant)
  }

  delete(id: string): void {
    this.db.run('DELETE FROM assistants WHERE id = ?', id)
  }
}
