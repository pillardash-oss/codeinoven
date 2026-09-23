import { parseTimeOfDay, type RoutineSchedule, type ScheduleCadence } from './types'

/**
 * The machine-readable routine plan the authoring agent emits, and the JSON
 * schemas that make its schedule and its connections reliable.
 *
 * The how-to itself is free prose (a `how-to` fence). Everything the app has to
 * act on deterministically   when the routine runs and which utilities it needs
 *   travels as one JSON object in a `routine` fence, validated here. Prose
 * parsing ("cadence: weekdays", "every day at 8:05am") stays as a tolerant
 * fallback so an older draft still commits, but the schema is the contract: a
 * schedule or a connection the schema rejects contributes nothing instead of
 * silently becoming something the user did not ask for.
 *
 * Pure and dependency-free, so the renderer, the main process, and tests all
 * read the exact same rules.
 */

/** One service the routine needs, as the plan names it. */
export interface RoutinePlanConnection {
  /** Display name the plan used, matched against the utility library. */
  name: string
  /** Exact utility id when the plan knows it, preferred over name matching. */
  utilityId?: string
}

/** The validated plan: the schedule to apply and the connections to link. */
export interface RoutinePlan {
  schedule: RoutineSchedule | null
  connections: RoutinePlanConnection[]
}

const SCHEDULE_CADENCES: readonly ScheduleCadence[] = [
  'once',
  'hourly',
  'daily',
  'weekdays',
  'weekly'
]

const CADENCE_SET = new Set<string>(SCHEDULE_CADENCES)

const TIME_PATTERN = '^([01]?\\d|2[0-3]):[0-5]\\d$'

/**
 * JSON schema for one routine schedule. Conditional branches enforce what the
 * scheduler actually needs: a one-shot schedule carries `onceAt`, and every
 * timed cadence carries at least one `HH:mm` value.
 */
export const ROUTINE_SCHEDULE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  description:
    'When the routine runs. Use local wall-clock times; the app fires against the machine clock.',
  properties: {
    cadence: {
      type: 'string',
      enum: [...SCHEDULE_CADENCES],
      description:
        'once = one fire at onceAt; hourly = every hour on the hour; daily = every day; weekdays = Monday to Friday; weekly = the listed weekdays.'
    },
    times: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', pattern: TIME_PATTERN },
      description:
        'Times of day as 24-hour HH:mm, e.g. "08:30". Required for daily, weekdays, and weekly; omit for hourly.'
    },
    weekdays: {
      type: 'array',
      items: { type: 'integer', minimum: 0, maximum: 6 },
      description: 'Weekly only: 0 (Sunday) through 6 (Saturday). Omit to mean every day.'
    },
    onceAt: {
      type: 'integer',
      description: 'Once only: epoch milliseconds of the single fire.'
    }
  },
  required: ['cadence'],
  allOf: [
    {
      if: { properties: { cadence: { const: 'once' } }, required: ['cadence'] },
      then: { required: ['onceAt'] }
    },
    {
      if: {
        properties: { cadence: { enum: ['daily', 'weekdays', 'weekly'] } },
        required: ['cadence']
      },
      then: { required: ['times'] }
    }
  ]
}

/** JSON schema for one routine connection. */
export const ROUTINE_CONNECTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  description: 'One utility the routine needs, e.g. an MCP server or a skill.',
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      description:
        'The service name as a human writes it ("Slack", "Gmail"). The app links it to the matching utility library entry.'
    },
    utilityId: {
      type: 'string',
      minLength: 1,
      description:
        'Exact utility id from the library when it is known (e.g. "slack-mcp"). Takes precedence over name matching.'
    }
  },
  required: ['name']
}

/** JSON schema for the whole `routine` plan block. */
export const ROUTINE_PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  description: 'The machine-readable half of a routine: when it runs and what it needs.',
  properties: {
    schedule: ROUTINE_SCHEDULE_JSON_SCHEMA,
    connections: {
      type: 'array',
      items: ROUTINE_CONNECTION_JSON_SCHEMA,
      description: 'Every service the routine needs. An empty array means it needs none.'
    }
  },
  required: ['schedule', 'connections']
}

/** The plan schema as compact text, ready to paste into an authoring contract. */
export const ROUTINE_PLAN_SCHEMA_TEXT = JSON.stringify(ROUTINE_PLAN_JSON_SCHEMA)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalise one time value to `HH:mm`, or null when it is not a valid time. */
function normalizeTime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parsed = parseTimeOfDay(value)
  if (!parsed) return null
  return `${String(parsed.hours).padStart(2, '0')}:${String(parsed.minutes).padStart(2, '0')}`
}

/**
 * Validate one schedule value against the schedule schema. Returns the
 * normalised schedule, or null when it cannot fire as written (unknown cadence,
 * a timed cadence with no usable time, a one-shot with no fire time). The app
 * treats null as "no schedule" rather than inventing one.
 */
export function normalizePlanSchedule(value: unknown): RoutineSchedule | null {
  if (!isRecord(value)) return null
  const cadence = typeof value.cadence === 'string' ? value.cadence : ''
  if (!CADENCE_SET.has(cadence)) return null
  const typed = cadence as ScheduleCadence

  if (typed === 'once') {
    const onceAt = value.onceAt
    if (typeof onceAt !== 'number' || !Number.isFinite(onceAt)) return null
    return { cadence: 'once', times: [], onceAt }
  }

  if (typed === 'hourly') return { cadence: 'hourly', times: [] }

  const times: string[] = []
  if (Array.isArray(value.times)) {
    for (const entry of value.times) {
      const time = normalizeTime(entry)
      if (time && !times.includes(time)) times.push(time)
    }
  }
  if (times.length === 0) return null
  times.sort()

  if (typed === 'weekly') {
    const weekdays: number[] = []
    if (Array.isArray(value.weekdays)) {
      for (const entry of value.weekdays) {
        if (typeof entry !== 'number' || !Number.isInteger(entry)) continue
        if (entry < 0 || entry > 6 || weekdays.includes(entry)) continue
        weekdays.push(entry)
      }
    }
    weekdays.sort((a, b) => a - b)
    return { cadence: 'weekly', times, ...(weekdays.length > 0 ? { weekdays } : {}) }
  }

  return { cadence: typed, times }
}

/**
 * Validate the plan's connections against the connections schema. A plain
 * string is accepted as shorthand for `{ name }`, so a terse plan still links.
 */
export function normalizePlanConnections(value: unknown): RoutinePlanConnection[] {
  if (!Array.isArray(value)) return []
  const result: RoutinePlanConnection[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      const name = entry.trim()
      if (name) result.push({ name })
      continue
    }
    if (!isRecord(entry)) continue
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (!name) continue
    const utilityId = typeof entry.utilityId === 'string' ? entry.utilityId.trim() : ''
    result.push({ name, ...(utilityId ? { utilityId } : {}) })
  }
  return result
}

/**
 * Validate one decoded plan value against the plan schema. Returns the plan, or
 * null when it carries neither a usable schedule nor a connection, so a stray
 * JSON object never reads as a routine plan.
 */
export function parseRoutinePlanValue(value: unknown): RoutinePlan | null {
  if (!isRecord(value)) return null
  const schedule = normalizePlanSchedule(value.schedule)
  const connections = normalizePlanConnections(value.connections)
  if (!schedule && connections.length === 0) return null
  return { schedule, connections }
}

/** Parse a JSON plan body (the `routine` fence) against the plan schema. */
export function parseRoutinePlanJson(body: string): RoutinePlan | null {
  const text = body.trim()
  if (!text.startsWith('{')) return null
  try {
    return parseRoutinePlanValue(JSON.parse(text))
  } catch {
    return null
  }
}
