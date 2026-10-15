import { parseTimeOfDay, type AssistantSchedule, type ScheduleCadence } from './types'
import {
  normalizePlanDelivery,
  normalizePlanPriority,
  ASSISTANT_DELIVERY_JSON_SCHEMA,
  ASSISTANT_PRIORITY_JSON_SCHEMA
} from './assistant-reporting'
import type { AssistantDelivery, AssistantPriority } from './types'

/**
 * The machine-readable assistant plan the authoring agent emits, and the JSON
 * schemas that make its schedule and its connections reliable.
 *
 * The knowledge itself is free prose (a `knowledge` fence). Everything the app has to
 * act on deterministically   when the assistant runs and which utilities it needs
 *   travels as one JSON object in a `assistant` fence, validated here. Prose
 * parsing ("cadence: weekdays", "every day at 8:05am") stays as a tolerant
 * fallback so an older draft still commits, but the schema is the contract: a
 * schedule or a connection the schema rejects contributes nothing instead of
 * silently becoming something the user did not ask for.
 *
 * Pure and dependency-free, so the renderer, the main process, and tests all
 * read the exact same rules.
 */

/** One service the assistant needs, as the plan names it. */
export interface AssistantPlanConnection {
  /** Display name the plan used, matched against the utility library. */
  name: string
  /** Exact utility id when the plan knows it, preferred over name matching. */
  utilityId?: string
  /**
   * How to set this connection up when the agent could not install it itself:
   * what the capability is, where it comes from, and what the user has to
   * provide. It becomes the request an assisted setup thread opens with.
   */
  setup?: string
}

/** The validated plan: the schedule to apply, the connections to link, and how
 *  the assistant reports back to the user. */
export interface AssistantPlan {
  /**
   * The name the user gave the assistant in the conversation, when they gave one
   * there. The app renames the assistant from this on the same save, so an
   * assistant built by talking is named by the person who built it rather than
   * left as the placeholder the create flow had to use.
   */
  name: string | null
  /**
   * How the user asked the assistant to behave, in their own words. It becomes
   * the assistant's personality, which rides every turn of its threads.
   */
  personality: string | null
  /**
   * Whether the assistant keeps a clock at all. A conversation can settle either
   * way, so the answer travels with the plan: `false` makes the assistant
   * on-demand, `true` keeps it on the clock, and absent leaves the flag alone.
   */
  scheduled: boolean | null
  schedule: AssistantSchedule | null
  /** What the user calls that clock ("Daily account check"), when they named it. */
  scheduleName: string | null
  connections: AssistantPlanConnection[]
  /** Where the assistant's output goes; absent for an action-only assistant. */
  delivery: AssistantDelivery | null
  /** The assistant's default urgency; absent to let each run decide. */
  priority: AssistantPriority | null
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
 * JSON schema for one assistant schedule. Conditional branches enforce what the
 * scheduler actually needs: a one-shot schedule carries `onceAt`, and every
 * timed cadence carries at least one `HH:mm` value.
 */
export const ASSISTANT_SCHEDULE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  description:
    'When the assistant runs. Use local wall-clock times; the app fires against the machine clock.',
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

/** JSON schema for one assistant connection. */
export const ASSISTANT_CONNECTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  description: 'One utility the assistant needs, e.g. an MCP server or a skill.',
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
    },
    setup: {
      type: 'string',
      minLength: 1,
      description:
        'Include ONLY when you could not install this connection yourself. A run of the assistant also attempts setup itself, so this is the fallback for what a run still cannot supply. A ready-to-run prompt for the utility setup agent: what the capability is, its source (official MCP URL, npm package, or skill), and what the user must supply. The user sends it verbatim.'
    }
  },
  required: ['name']
}

/** JSON schema for the whole `assistant` plan block. */
export const ASSISTANT_PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  description: 'The machine-readable half of an assistant: who it is, when it runs, what it needs.',
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      description:
        'The name the user gave the assistant in the conversation, verbatim and nothing more ("Jenny"). Omit when they did not name it.'
    },
    personality: {
      type: 'string',
      minLength: 1,
      description:
        'How the user asked the assistant to behave, in their own words, as a short paragraph. Omit when they left it to you.'
    },
    scheduled: {
      type: 'boolean',
      description:
        'True when the assistant runs on its own clock, false when it runs only when the user asks. Omit when the user did not say.'
    },
    scheduleName: {
      type: 'string',
      minLength: 1,
      description:
        'What the user calls the clock they asked for ("Daily account check"). Only when `scheduled` is true and they named it.'
    },
    schedule: {
      anyOf: [ASSISTANT_SCHEDULE_JSON_SCHEMA, { type: 'null' }],
      description:
        'When the assistant runs, or null for an assistant that has no schedule and runs only on demand. Use local wall-clock times; the app fires against the machine clock.'
    },
    connections: {
      type: 'array',
      items: ASSISTANT_CONNECTION_JSON_SCHEMA,
      description: 'Every service the assistant needs. An empty array means it needs none.'
    },
    delivery: ASSISTANT_DELIVERY_JSON_SCHEMA,
    priority: ASSISTANT_PRIORITY_JSON_SCHEMA
  },
  required: ['schedule', 'connections']
}

/** The plan schema as compact text, ready to paste into an authoring contract. */
export const ASSISTANT_PLAN_SCHEMA_TEXT = JSON.stringify(ASSISTANT_PLAN_JSON_SCHEMA)

/** Ceiling for the name a plan may carry, matching the store's own limit. */
const MAX_PLAN_TEXT = 200
/** Ceiling for the personality a plan may carry, matching the IPC validator. */
const MAX_PLAN_PERSONALITY = 4_000
/** Ceiling for the schedule name a plan may carry, matching the IPC validator. */
const MAX_PLAN_SCHEDULE_NAME = 120

/**
 * One free-text field of a plan, trimmed and capped, or null when it carries
 * nothing usable. A value the model did not mean to send (an object, an array, a
 * blank string) contributes nothing rather than becoming the assistant's name.
 */
function normalizeReadableText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length > 0 ? text.slice(0, maxLength) : null
}

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
export function normalizePlanSchedule(value: unknown): AssistantSchedule | null {
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
export function normalizePlanConnections(value: unknown): AssistantPlanConnection[] {
  if (!Array.isArray(value)) return []
  const result: AssistantPlanConnection[] = []
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
    const setup = typeof entry.setup === 'string' ? entry.setup.trim() : ''
    result.push({ name, ...(utilityId ? { utilityId } : {}), ...(setup ? { setup } : {}) })
  }
  return result
}

/**
 * Validate one decoded plan value against the plan schema. Returns the plan, or
 * null when it carries nothing the app can act on   no usable schedule, no
 * connection, and no reporting agreement   so a stray JSON object never reads
 * as an assistant plan.
 */
export function parseAssistantPlanValue(value: unknown): AssistantPlan | null {
  if (!isRecord(value)) return null
  const name = normalizeReadableText(value.name, MAX_PLAN_TEXT)
  const personality = normalizeReadableText(value.personality, MAX_PLAN_PERSONALITY)
  const scheduleName = normalizeReadableText(value.scheduleName, MAX_PLAN_SCHEDULE_NAME)
  const scheduled = typeof value.scheduled === 'boolean' ? value.scheduled : null
  const schedule = normalizePlanSchedule(value.schedule)
  const connections = normalizePlanConnections(value.connections)
  const delivery = normalizePlanDelivery(value.delivery)
  const priority = normalizePlanPriority(value.priority)
  if (
    !schedule &&
    connections.length === 0 &&
    !delivery &&
    !priority &&
    !name &&
    !personality &&
    !scheduleName &&
    scheduled === null
  ) {
    return null
  }
  return { name, personality, scheduled, schedule, scheduleName, connections, delivery, priority }
}

/** Parse a JSON plan body (the `assistant` fence) against the plan schema. */
export function parseAssistantPlanJson(body: string): AssistantPlan | null {
  const text = body.trim()
  if (!text.startsWith('{')) return null
  try {
    return parseAssistantPlanValue(JSON.parse(text))
  } catch {
    return null
  }
}
