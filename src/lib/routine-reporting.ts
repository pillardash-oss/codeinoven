/**
 * How a routine reports back to the user: the channel its output is delivered
 * to, and how urgent that output is.
 *
 * These are the two things a routine that produces something for the user to
 * read has to settle before it can run, so the authoring agent asks for them and
 * records the answer in the routine plan. Both are optional: an action-only
 * routine that changes something and reports nothing has neither.
 *
 * Priority is deliberately two independent brackets, because "urgent" is two
 * different questions:
 *
 * - `timeliness` is time-based   how soon the output matters (now, today,
 *   tomorrow, this week, whenever).
 * - `impact` is scope-based   how far the output reaches (just the user, their
 *   team, the company, or something critical that affects others and cannot
 *   wait).
 *
 * A routine stores its agreed default. Each run may refine it, because the
 * agent often only learns the real bracket from what it found.
 *
 * Pure and dependency-free, so the renderer, the main process, the contracts,
 * and tests all read the exact same vocabulary.
 */

import type {
  RoutineDelivery,
  RoutineDeliveryChannel,
  RoutineImpact,
  RoutinePriority,
  RoutineTimeliness
} from './types/routine'

/** One selectable delivery channel, with the label and whether it leaves the app. */
export interface RoutineDeliveryOption {
  id: RoutineDeliveryChannel
  label: string
  /** Whether the channel needs a connection before it can work. */
  external: boolean
}

/**
 * Every delivery channel, in the order the panel and the agent offer them.
 * `in-app` is the only channel wired up today, so it leads; the external ones
 * each need a connection the routine must have before it can deliver.
 */
export const ROUTINE_DELIVERY_OPTIONS: ReadonlyArray<RoutineDeliveryOption> = [
  { id: 'in-app', label: 'In-app thread', external: false },
  { id: 'slack', label: 'Slack', external: true },
  { id: 'telegram', label: 'Telegram', external: true },
  { id: 'whatsapp', label: 'WhatsApp', external: true },
  { id: 'signal', label: 'Signal', external: true },
  { id: 'email', label: 'Email', external: true },
  { id: 'other', label: 'Another app', external: true }
]

const DELIVERY_OPTION_BY_ID = new Map<string, RoutineDeliveryOption>(
  ROUTINE_DELIVERY_OPTIONS.map((option) => [option.id, option])
)

/** One selectable timeliness bracket. */
export interface RoutineTimelinessOption {
  id: RoutineTimeliness
  label: string
  hint: string
}

export const ROUTINE_TIMELINESS_OPTIONS: ReadonlyArray<RoutineTimelinessOption> = [
  { id: 'now', label: 'Now', hint: 'Act on it immediately' },
  { id: 'today', label: 'Today', hint: 'Worth acting on today' },
  { id: 'tomorrow', label: 'Tomorrow', hint: 'Fine to pick up tomorrow' },
  { id: 'this-week', label: 'This week', hint: 'Worth clearing this week' },
  { id: 'whenever', label: 'Whenever', hint: 'No deadline; read it when convenient' }
]

/** One selectable impact bracket. */
export interface RoutineImpactOption {
  id: RoutineImpact
  label: string
  hint: string
}

export const ROUTINE_IMPACT_OPTIONS: ReadonlyArray<RoutineImpactOption> = [
  { id: 'just-me', label: 'Just me', hint: 'Affects only the user' },
  { id: 'team', label: 'My team', hint: 'Affects the user\u2019s team as well' },
  { id: 'company', label: 'The company', hint: 'Affects the whole company' },
  {
    id: 'critical',
    label: 'Critical',
    hint: 'Affects others beyond the user and cannot wait'
  }
]

/** The time-based bracket ids, in offer order, for contracts and validation. */
export const ROUTINE_TIMELINESS_IDS: ReadonlyArray<RoutineTimeliness> =
  ROUTINE_TIMELINESS_OPTIONS.map((option) => option.id)

/** The scope-based bracket ids, in offer order, for contracts and validation. */
export const ROUTINE_IMPACT_IDS: ReadonlyArray<RoutineImpact> = ROUTINE_IMPACT_OPTIONS.map(
  (option) => option.id
)

/** The channel ids as the plan schema lists them. */
export const ROUTINE_DELIVERY_CHANNEL_IDS: ReadonlyArray<RoutineDeliveryChannel> =
  ROUTINE_DELIVERY_OPTIONS.map((option) => option.id)

/**
 * Aliases a model writes for each channel. A model told "in-app thread
 * notification" reaches for `in_app`, `notification`, or `thread`; told "Slack
 * channel" it reaches for `slack_channel`. Normalising here keeps a reasonable
 * answer from being thrown away over punctuation.
 */
const DELIVERY_ALIASES: ReadonlyArray<readonly [RegExp, RoutineDeliveryChannel]> = [
  [/^(?:in[-_ ]?app|inapp|app|notification|notify|thread|thread[-_ ]?notification|cio|codeinoven|code[-_ ]?in[-_ ]?oven|internal|none)$/, 'in-app'],
  [/^(?:slack|slack[-_ ]?(?:channel|dm|message)|slackbot)$/, 'slack'],
  [/^(?:telegram|tg|telegram[-_ ]?(?:bot|chat|channel))$/, 'telegram'],
  [/^(?:whatsapp|whats[-_ ]?app|wa|whatsapp[-_ ]?(?:chat|group))$/, 'whatsapp'],
  [/^(?:signal|signal[-_ ]?(?:chat|group))$/, 'signal'],
  [/^(?:email|e[-_ ]?mail|mail|gmail|outlook|smtp|inbox)$/, 'email'],
  [/^(?:other|other[-_ ]?app|im|instant[-_ ]?messaging|messaging|sms|imessage|discord|teams|matrix|sms[-_ ]?text)$/, 'other']
]

/** Aliases a model writes for each timeliness bracket. */
const TIMELINESS_ALIASES: ReadonlyArray<readonly [RegExp, RoutineTimeliness]> = [
  [/^(?:now|immediate|immediately|asap|right[-_ ]?now|urgent|instant)$/, 'now'],
  [/^(?:today|same[-_ ]?day|end[-_ ]?of[-_ ]?day|eod|daily)$/, 'today'],
  [/^(?:tomorrow|next[-_ ]?day|tmrw|tmw)$/, 'tomorrow'],
  [/^(?:this[-_ ]?week|week|weekly|few[-_ ]?days)$/, 'this-week'],
  [/^(?:whenever|anytime|any[-_ ]?time|no[-_ ]?rush|low|none|flexible|when[-_ ]?possible)$/, 'whenever']
]

/** Aliases a model writes for each impact bracket. */
const IMPACT_ALIASES: ReadonlyArray<readonly [RegExp, RoutineImpact]> = [
  [/^(?:just[-_ ]?me|me|self|personal|mine|individual|low)$/, 'just-me'],
  [/^(?:team|my[-_ ]?team|department|dept|group|squad)$/, 'team'],
  [/^(?:company|org|organisation|organization|company[-_ ]?wide|everyone|all|firm|business)$/, 'company'],
  [/^(?:critical|urgent|severe|blocker|blocking|emergency|high|company[-_ ]?critical|outage)$/, 'critical']
]

/** JSON schema for a routine's delivery, for the machine-readable plan. */
export const ROUTINE_DELIVERY_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  description:
    'Where this routine\u2019s output is delivered. Omit entirely for a routine that reports nothing to the user.',
  properties: {
    channel: {
      type: 'string',
      enum: [...ROUTINE_DELIVERY_CHANNEL_IDS],
      description:
        'in-app = a normal thread notification inside CodeInOven (the only channel wired up today). Every other channel needs a connection the routine must have.'
    },
    target: {
      type: 'string',
      minLength: 1,
      description:
        'The concrete destination the user named: a chat, a channel name, or an address. Omit for in-app.'
    },
    note: {
      type: 'string',
      minLength: 1,
      description: 'A short note on how delivery works, when it is worth recording.'
    }
  },
  required: ['channel']
}

/** JSON schema for a routine's priority, for the machine-readable plan. */
export const ROUTINE_PRIORITY_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  description:
    'How urgent this routine\u2019s output is, on two separate brackets. Omit to let every run decide from what it finds.',
  properties: {
    timeliness: {
      type: 'string',
      enum: [...ROUTINE_TIMELINESS_IDS],
      description: 'Time-based: how soon the output matters.'
    },
    impact: {
      type: 'string',
      enum: [...ROUTINE_IMPACT_IDS],
      description:
        'Scope-based: how far the output reaches. critical = it affects others beyond the user and cannot wait.'
    }
  },
  required: ['timeliness', 'impact']
}

/** The display label of a delivery channel, falling back to the raw id. */
export function routineDeliveryChannelLabel(channel: string): string {
  return DELIVERY_OPTION_BY_ID.get(channel)?.label ?? channel
}

/** Whether a channel needs a connection before it can deliver anything. */
export function isExternalDeliveryChannel(channel: RoutineDeliveryChannel): boolean {
  return DELIVERY_OPTION_BY_ID.get(channel)?.external ?? false
}

/** The one-line label of a delivery, e.g. `Slack · #eng-alerts`. */
export function routineDeliveryLabel(delivery: RoutineDelivery): string {
  const channel = routineDeliveryChannelLabel(delivery.channel)
  const target = delivery.target?.trim()
  return target ? `${channel} \u00b7 ${target}` : channel
}

/** The label of one timeliness bracket, falling back to the raw id. */
export function routineTimelinessLabel(timeliness: string): string {
  return ROUTINE_TIMELINESS_OPTIONS.find((option) => option.id === timeliness)?.label ?? timeliness
}

/** The label of one impact bracket, falling back to the raw id. */
export function routineImpactLabel(impact: string): string {
  return ROUTINE_IMPACT_OPTIONS.find((option) => option.id === impact)?.label ?? impact
}

/** The one-line label of a priority, e.g. `Today \u00b7 My team`. */
export function routinePriorityLabel(priority: RoutinePriority): string {
  return `${routineTimelinessLabel(priority.timeliness)} \u00b7 ${routineImpactLabel(priority.impact)}`
}

/** Match a free-text value against an alias table, or null. */
function matchAlias<T extends string>(
  value: string,
  aliases: ReadonlyArray<readonly [RegExp, T]>
): T | null {
  const token = value.trim().toLowerCase().replace(/[\s_]+/g, '-')
  for (const [pattern, id] of aliases) {
    if (pattern.test(token)) return id
  }
  return null
}

/**
 * Validate a plan's delivery value. Returns the delivery, or null when the
 * channel cannot be resolved   a routine is never given a delivery the user did
 * not ask for. An `in-app` delivery drops a target it cannot use, since the
 * in-app channel has no destination to name.
 */
export function normalizePlanDelivery(value: unknown): RoutineDelivery | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const raw = typeof record.channel === 'string' ? record.channel : ''
  if (!raw.trim()) return null
  const channel = matchAlias(raw, DELIVERY_ALIASES)
  if (!channel) return null
  const target = typeof record.target === 'string' ? record.target.trim() : ''
  const note = typeof record.note === 'string' ? record.note.trim() : ''
  return {
    channel,
    ...(target && channel !== 'in-app' ? { target } : {}),
    ...(note ? { note } : {})
  }
}

/**
 * Validate a plan's priority value. Returns the priority, or null when either
 * bracket cannot be resolved, so a half-read priority never becomes a routine's
 * default.
 */
export function normalizePlanPriority(value: unknown): RoutinePriority | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const rawTimeliness = typeof record.timeliness === 'string' ? record.timeliness : ''
  const rawImpact = typeof record.impact === 'string' ? record.impact : ''
  const timeliness = matchAlias(rawTimeliness, TIMELINESS_ALIASES)
  const impact = matchAlias(rawImpact, IMPACT_ALIASES)
  if (!timeliness || !impact) return null
  return { timeliness, impact }
}
