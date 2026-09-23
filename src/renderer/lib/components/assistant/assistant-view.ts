import {
  describeRelativeTime,
  routineAgentsComplete,
  routineHowToComplete,
  type AgentCapabilityCatalog,
  type MissedRun,
  type Routine,
  type RoutineConnection,
  type RoutineSchedule,
  type ScheduleCadence,
  type Thread,
  type UtilityCatalog,
  type UtilityDefinition
} from '$shared/types'
import {
  parseRoutinePlanJson,
  type RoutinePlan,
  type RoutinePlanConnection
} from '$shared/routine-plan'
import { threadStatusPolicy } from '$shared/thread-status-policy'
import {
  buildConnectionLibrary,
  connectionNamesOverlap,
  findConnectionEntry,
  normalizeConnectionName,
  type ConnectionLibraryEntry
} from './connection-library'

/**
 * Pure presentation logic for Assistant View, kept out of the components so the
 * row/tab rules can be unit-tested without a DOM.
 */

/** The Missed runs tab only exists when at least one run was missed. */
export function missedTabVisible(runs: readonly MissedRun[]): boolean {
  return runs.length > 0
}

/** Group key for missed runs whose task belongs to no routine. */
export const UNGROUPED_MISSED_RUNS = '__ungrouped__'

/** One routine's pending missed runs. */
export interface MissedRunGroup {
  /** Routine id, or `UNGROUPED_MISSED_RUNS` for routine-less tasks. */
  key: string
  /** Routine name, or the neutral label used for routine-less tasks. */
  label: string
  runs: MissedRun[]
}

/**
 * Missed runs are surfaced per routine: one group per owning routine, plus a
 * single group for routine-less tasks. Group order follows first appearance,
 * which is the store's due-time order.
 */
export function groupMissedRunsByRoutine(
  runs: readonly MissedRun[],
  routineNameById: ReadonlyMap<string, string>
): MissedRunGroup[] {
  const groups = new Map<string, MissedRunGroup>()
  for (const run of runs) {
    const key = run.routineId ?? UNGROUPED_MISSED_RUNS
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        label: run.routineId
          ? (routineNameById.get(run.routineId) ?? 'Routine')
          : 'Tasks without a routine',
        runs: []
      }
      groups.set(key, group)
    }
    group.runs.push(run)
  }
  return [...groups.values()]
}

/** Whether a task row shows the missed badge. */
export function taskHasMissed(runs: readonly MissedRun[]): boolean {
  return runs.length > 0
}

/**
 * Line 2 of a task row: the next intended run for a scheduled task, else the
 * last run, else "Not scheduled".
 */
export function taskRunLine(
  task: Pick<Thread, 'lastRunAt'>,
  nextRunAt: number | null,
  now: number
): string {
  if (nextRunAt !== null) return `Next run ${describeRelativeTime(nextRunAt, now)}`
  if (task.lastRunAt !== undefined) return `Last run ${describeRelativeTime(task.lastRunAt, now)}`
  return 'Not scheduled'
}

/**
 * The task row icon key: a custom icon when the task carries one, otherwise the
 * Hammer for a routine's how-to ("Getting started") thread, otherwise the plain
 * task clock. The generic assistant robot is deliberately gone.
 */
export function taskRowIconKey(
  task: Pick<Thread, 'assistantIconType' | 'assistantGettingStarted'>
): 'custom' | 'how-to' | 'task' {
  if (task.assistantIconType) return 'custom'
  return task.assistantGettingStarted === true ? 'how-to' : 'task'
}

/**
 * Fence tag or leading body line naming a block as a how-to: `how-to`,
 * `howto`, `how_to`, `how to`, each optionally followed by `: <title>` or
 * `- <title>`. A trailing `.md` or other word is rejected.
 */
const HOW_TO_TAG = /^how[ _-]?to(?:[ \t]*[-:][^\n]*)?$/i

/** A leading `how-to` marker line inside a block, e.g. `how-to: Slack digest`. */
const HOW_TO_MARKER_LINE = /^[ \t]*how[-_]?to\b[ \t]*(?:[-:][ \t]*[^\n]*)?$/

/** A fence line: indent, a backtick run of 3+, and an optional tag (no backticks). */
const FENCE_LINE = /^[ \t]*(`{3,})[ \t]*([^`]*)$/

interface FenceLine {
  /** Index of the fence line in the message. */
  index: number
  /** Backtick run length   a closing fence must be at least this long. */
  length: number
  /** Everything after the backticks, trimmed; empty for an untagged fence. */
  tag: string
}

/** Every fence line in the message, in order. */
function collectFences(lines: readonly string[]): FenceLine[] {
  const fences: FenceLine[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = FENCE_LINE.exec(lines[index] ?? '')
    if (!match) continue
    fences.push({
      index,
      length: (match[1] ?? '').length,
      tag: (match[2] ?? '').trim()
    })
  }
  return fences
}

/** The first non-blank line of a block body, or null when the body is blank. */
function firstNonEmptyLine(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (line.trim() !== '') return line
  }
  return null
}

/** Drop a leading marker line so a block's body is content only. */
function stripLeadingMarker(body: string, matchesMarker: (line: string) => boolean): string {
  const lines = body.split('\n')
  const start = lines.findIndex((line) => line.trim() !== '')
  if (start === -1) return ''
  const content = matchesMarker(lines[start]) ? lines.slice(start + 1) : lines.slice(start)
  return content.join('\n').trim()
}

/**
 * The newest fenced block whose opening tag   or whose first body line   the
 * caller recognises, or null when the text holds none. Tagged inner fences are
 * tracked as nesting, so a block that carries its own code examples is read
 * whole; only an untagged fence at the outer depth closes it. The returned body
 * has its leading marker line stripped.
 */
function newestTaggedBlock(
  text: string,
  matchesTag: (tag: string) => boolean,
  matchesMarker: (line: string) => boolean
): string | null {
  const lines = text.split('\n')
  const fences = collectFences(lines)

  let lastOpening: FenceLine | null = null
  for (const fence of fences) {
    if (matchesTag(fence.tag)) {
      lastOpening = fence
      continue
    }
    const head = firstNonEmptyLine(lines.slice(fence.index + 1))
    if (head !== null && matchesMarker(head)) lastOpening = fence
  }
  if (!lastOpening) return null
  const open = lastOpening

  let depth = 1
  for (const fence of fences) {
    if (fence.index <= open.index) continue
    if (fence.length < open.length) continue
    if (fence.tag !== '') {
      // A tagged fence is an inner opening (a nested example), not the close.
      depth += 1
      continue
    }
    depth -= 1
    if (depth > 0) continue
    return stripLeadingMarker(lines.slice(open.index + 1, fence.index).join('\n'), matchesMarker)
  }
  return null
}

/**
 * The how-to draft inside one assistant message, or null when it holds none.
 *
 * The authoring contract asks for a fence tagged `how-to`, but a model also
 * opens a bare fence and starts the body with a `how-to: <title>` line, so both
 * shapes are accepted. The newest how-to block in the text wins, and a leading
 * marker line is stripped so the saved how-to is instructions only.
 *
 * A how-to is a step-by-step instruction set, so it often carries its own code
 * fences (a command to run, a payload to post). Matching the block to its first
 * closing fence would silently truncate it there, so tagged inner fences are
 * tracked as nesting and only an untagged fence at the outer depth closes the
 * block. Prose written after the block is left out of the saved how-to.
 */
export function extractHowToDraft(text: string): string | null {
  const draft = newestTaggedBlock(
    text,
    (tag) => HOW_TO_TAG.test(tag),
    (line) => HOW_TO_MARKER_LINE.test(line)
  )
  return draft || null
}

/**
 * The newest how-to draft across assistant messages, newest message first.
 * Messages are given as plain text so this stays free of thread plumbing.
 */
export function latestHowToDraft(assistantTexts: readonly string[]): string | null {
  for (let index = assistantTexts.length - 1; index >= 0; index -= 1) {
    const draft = extractHowToDraft(assistantTexts[index] ?? '')
    if (draft) return draft
  }
  return null
}

/** Overall state passed to the shared thread hover popover. */
export type TaskPopoverState =
  | 'unread'
  | 'temporary-unread'
  | 'read'
  | 'todo'
  | 'completed'
  | 'working'
  | 'working-paused'
  | 'spec'
  | 'approval'
  | 'error'
  | 'scheduled'

/**
 * Assistant tasks reuse the regular thread hover popover, which takes an
 * overall state rather than a status. The mapping mirrors the thread row's own
 * badge priority: unread wins, then the status policy's tone.
 */
export function taskPopoverState(task: Pick<Thread, 'status' | 'read'>): TaskPopoverState {
  if (!task.read) return 'unread'
  switch (threadStatusPolicy(task.status).tone) {
    case 'working':
      return 'working'
    case 'working-paused':
      return 'working-paused'
    case 'attention':
      return 'approval'
    case 'spec':
      return 'spec'
    case 'error':
      return 'error'
    case 'done':
      return 'completed'
    default:
      return 'todo'
  }
}

// ─── How-to sections ──────────────────────────────────────────────────────

/** A markdown heading: one to six `#`, then the title. */
const MARKDOWN_HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*$/

/**
 * Whether a line reads as a section title in the how-to's own style: no leading
 * space, no list or sentence punctuation at the end, and uppercase throughout.
 * Lowercase is tolerated inside parentheses, so `DRAIN PROCEDURE (0600 and
 * 1800)` is recognised while `1. Window: for 1800, local today 06:00` is not.
 */
function isCapsTitle(line: string): boolean {
  if (line.length < 3 || line.length > 80) return false
  if (line !== line.trim()) return false
  if (/[.!?:;,]$/.test(line)) return false
  if (/^[-*+]\s/.test(line) || /^\d+[.)]\s/.test(line)) return false
  const bare = line.replace(/\([^)]*\)/g, ' ')
  if (!/[A-Z]/.test(bare)) return false
  return /^[A-Z0-9 '&/.,:_-]+$/.test(bare)
}

/** One foldable section of an authored how-to. */
export interface HowToSection {
  /** Index-based key, stable across a re-parse of the same document. */
  id: string
  /** Raw heading line as it appears in the source; empty for a heading-less doc. */
  heading: string
  /** Display title with markdown markers stripped. */
  title: string
  body: string
}

/**
 * Split an authored how-to into foldable sections.
 *
 * The authoring agent writes either markdown headings or ALL-CAPS title lines,
 * and both are recognised so the panel can render one section at a time. Lines
 * inside a fenced code block are never treated as headings. A how-to with no
 * headings becomes a single section whose heading is empty, so serializing it
 * back round-trips the source.
 */
export function parseHowToSections(markdown: string): HowToSection[] {
  const sections: HowToSection[] = []
  let heading: string | null = null
  let title = ''
  let body: string[] = []
  let inFence = false
  let fenceMarker = ''

  const flush = (): void => {
    const trimmed = body.join('\n').trim()
    if (heading === null) {
      if (trimmed) {
        sections.push({
          id: `section-${sections.length}`,
          heading: '',
          title: 'Overview',
          body: trimmed
        })
      }
      return
    }
    sections.push({ id: `section-${sections.length}`, heading, title, body: trimmed })
  }

  for (const line of markdown.split('\n')) {
    const fence = /^[ \t]*(`{3,})/.exec(line)
    if (fence) {
      const marker = fence[1] ?? ''
      if (!inFence) {
        inFence = true
        fenceMarker = marker
      } else if (marker.length >= fenceMarker.length) {
        inFence = false
        fenceMarker = ''
      }
      body.push(line)
      continue
    }

    if (!inFence) {
      const markdownHeading = MARKDOWN_HEADING.exec(line)
      if (markdownHeading) {
        flush()
        heading = line
        title = (markdownHeading[2] ?? '').trim()
        body = []
        continue
      }
      if (isCapsTitle(line)) {
        flush()
        heading = line
        title = line
        body = []
        continue
      }
    }

    body.push(line)
  }
  flush()

  if (sections.length === 1 && sections[0]?.heading === '') {
    sections[0] = { ...sections[0], title: 'Instructions' }
  }
  return sections
}

/** Reassemble sections into the how-to markdown that gets persisted. */
export function serializeHowToSections(sections: readonly HowToSection[]): string {
  return sections
    .map((section) => {
      const body = section.body.trim()
      if (!section.heading) return body
      return body ? `${section.heading}\n${body}` : section.heading
    })
    .filter((part) => part.length > 0)
    .join('\n\n')
}

// ─── The agent's structured routine plan ──────────────────────────────────

/** Fence tag naming a machine-readable routine plan. */
const ROUTINE_TAG = /^routine(?:[-_ ]?plan)?(?:[ \t]*[-:][^\n]*)?$/i

/** A leading `routine` marker line inside a plain fence. */
const ROUTINE_MARKER_LINE = /^[ \t]*routine(?:[-_ ]?plan)?\b[ \t]*(?:[-:][ \t]*[^\n]*)?$/i

const CADENCE_PATTERNS: ReadonlyArray<readonly [RegExp, ScheduleCadence]> = [
  [/^(?:once|one[- ]?off|one[- ]?time)$/, 'once'],
  [/^(?:hourly|every hour|each hour)$/, 'hourly'],
  [/^(?:weekdays?|every weekday|business days?)$/, 'weekdays'],
  [/^(?:weekly|every week|week)$/, 'weekly'],
  [/^(?:daily|every day|each day|day)$/, 'daily']
]

const WEEKDAY_NAMES: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(?:sun|sunday)$/, 0],
  [/^(?:mon|monday)$/, 1],
  [/^(?:tue|tues|tuesday)$/, 2],
  [/^(?:wed|wednesday)$/, 3],
  [/^(?:thu|thur|thurs|thursday)$/, 4],
  [/^(?:fri|friday)$/, 5],
  [/^(?:sat|saturday)$/, 6]
]

/** The structured plan the authoring agent emits alongside the how-to. */
export type RoutinePlanDraft = RoutinePlan

/** Normalise one time to `HH:mm`, accepting `8`, `8:30`, `8am`, `8:30 pm`, `18:00`. */
export function parsePlanTime(raw: string): string | null {
  const match = /^(\d{1,2})(?::(\d{2}))?[ \t]*(am|pm)?\.?$/i.exec(raw.trim())
  if (!match) return null
  let hours = Number(match[1])
  const minutes = Number(match[2] ?? 0)
  const meridiem = match[3]?.toLowerCase()
  if (minutes > 59) return null
  if (meridiem === 'pm' && hours < 12) hours += 12
  if (meridiem === 'am' && hours === 12) hours = 0
  if (hours > 23) return null
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/** The cadence a free-text schedule phrase names, or null. */
function scanCadence(value: string): ScheduleCadence | null {
  const normalized = value.toLowerCase().trim()
  for (const [pattern, cadence] of CADENCE_PATTERNS) {
    if (pattern.test(normalized)) return cadence
  }
  if (/\bweekday/.test(normalized)) return 'weekdays'
  if (/\bweek\b/.test(normalized)) return 'weekly'
  if (/\bhour/.test(normalized)) return 'hourly'
  if (/\b(?:day|daily)\b/.test(normalized)) return 'daily'
  return null
}

/** Every `HH:mm` time a free-text value carries, ascending and de-duplicated. */
function scanTimes(value: string): string[] {
  const found: string[] = []
  for (const match of value.matchAll(/\b(\d{1,2}(?::\d{2})?[ \t]*(?:am|pm)?)\b/gi)) {
    const time = parsePlanTime(match[1] ?? '')
    if (time && !found.includes(time)) found.push(time)
  }
  return found.sort()
}

/** Split a comma/semicolon/`and`-separated list into trimmed entries. */
function splitList(value: string): string[] {
  return value
    .split(/[,;]|\band\b/i)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/** Weekday index for a name or abbreviation, or null for anything else. */
function weekdayIndex(value: string): number | null {
  const token = value.toLowerCase().trim()
  for (const [pattern, index] of WEEKDAY_NAMES) {
    if (pattern.test(token)) return index
  }
  return null
}

/** Assemble the schedule a plan's fields describe, or null when they cannot. */
function buildPlanSchedule(
  cadence: ScheduleCadence | null,
  times: readonly string[],
  weekdays: readonly number[]
): RoutineSchedule | null {
  if (!cadence && times.length === 0 && weekdays.length === 0) return null
  const sortedTimes = [...times].sort()
  const isWeekdaySet =
    weekdays.length === 5 && [1, 2, 3, 4, 5].every((day) => weekdays.includes(day))
  let resolved: ScheduleCadence = cadence ?? 'daily'
  if (!cadence && weekdays.length > 0) resolved = isWeekdaySet ? 'weekdays' : 'weekly'
  if (cadence === 'daily' && weekdays.length > 0) resolved = isWeekdaySet ? 'weekdays' : 'weekly'
  if (resolved === 'once') return null
  if (resolved === 'hourly') return { cadence: 'hourly', times: [] }
  if (sortedTimes.length === 0) return null
  if (resolved === 'weekly') {
    return {
      cadence: 'weekly',
      times: sortedTimes,
      ...(weekdays.length > 0 ? { weekdays: [...weekdays].sort((a, b) => a - b) } : {})
    }
  }
  return { cadence: resolved, times: sortedTimes }
}

/**
 * Read one `key: value` plan block   the tolerant fallback for a draft written
 * before the JSON plan contract, or by a model that ignored it. Unknown keys
 * are ignored rather than rejected, so an explanatory line does not break the
 * plan. The strict JSON schema in `$shared/routine-plan` is the primary shape.
 */
export function parseRoutinePlan(body: string): RoutinePlanDraft | null {
  let cadence: ScheduleCadence | null = null
  const times: string[] = []
  const weekdays: number[] = []
  const connections: RoutinePlanConnection[] = []
  let sawAnything = false

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('//')) continue
    const separator = line.indexOf(':')
    const key = (separator === -1 ? line : line.slice(0, separator)).trim().toLowerCase()
    const value = separator === -1 ? '' : line.slice(separator + 1).trim()
    if (!value) continue

    if (
      ['connections', 'connection', 'services', 'service', 'tools', 'integrations'].includes(key)
    ) {
      for (const name of splitList(value)) connections.push({ name })
      sawAnything = true
      continue
    }
    if (['weekdays', 'days'].includes(key)) {
      for (const entry of splitList(value)) {
        const index = weekdayIndex(entry)
        if (index !== null && !weekdays.includes(index)) weekdays.push(index)
      }
      sawAnything = true
      continue
    }
    if (['times', 'time', 'at'].includes(key)) {
      for (const entry of splitList(value)) {
        const time = parsePlanTime(entry)
        if (time && !times.includes(time)) times.push(time)
      }
      for (const time of scanTimes(value)) {
        if (!times.includes(time)) times.push(time)
      }
      sawAnything = true
      continue
    }
    if (['cadence', 'frequency', 'schedule', 'recurrence'].includes(key)) {
      cadence = scanCadence(value) ?? cadence
      for (const time of scanTimes(value)) {
        if (!times.includes(time)) times.push(time)
      }
      sawAnything = true
      continue
    }
  }

  if (!sawAnything) return null
  return {
    schedule: buildPlanSchedule(cadence, times, weekdays),
    connections: [
      ...new Map(connections.map((entry) => [entry.name.toLowerCase(), entry])).values()
    ]
  }
}

/**
 * The routine plan inside one assistant message, or null when it holds none.
 * The plan is JSON matching `ROUTINE_PLAN_JSON_SCHEMA`; a `key: value` body is
 * still read as a fallback so an older or non-conforming draft can commit.
 */
export function extractRoutinePlanDraft(text: string): RoutinePlanDraft | null {
  const body = newestTaggedBlock(
    text,
    (tag) => ROUTINE_TAG.test(tag),
    (line) => ROUTINE_MARKER_LINE.test(line)
  )
  if (!body) return null
  return parseRoutinePlanJson(body) ?? parseRoutinePlan(body)
}

/** The newest routine plan across assistant messages, newest message first. */
export function latestRoutinePlanDraft(assistantTexts: readonly string[]): RoutinePlanDraft | null {
  for (let index = assistantTexts.length - 1; index >= 0; index -= 1) {
    const draft = extractRoutinePlanDraft(assistantTexts[index] ?? '')
    if (draft) return draft
  }
  return null
}

// ─── Authoring confirmation ───────────────────────────────────────────────

/**
 * A plain, unambiguous "yes" and nothing else. The authoring agent asks the
 * user to confirm the routine recap, and this is the typed spelling of that
 * go-ahead   it must never match a message that also carries an instruction, so
 * only a short, whole-message confirmation counts.
 */
const ROUTINE_CONFIRMATION =
  /^(?:yes|y|yeah|yep|yup|sure|ok|okay|k|go ahead|go for it|do it|save it|save|looks good|looks great|sounds good|that works|perfect|great|nice|confirm|confirmed|approve|approved|ship it|lgtm|👍)$/

/** Whether a user message is a plain go-ahead for the pending routine recap. */
export function isRoutineConfirmation(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[\s.!?,]+$/u, '')
    .trim()
  if (!normalized || normalized.length > 32) return false
  return ROUTINE_CONFIRMATION.test(normalized)
}

/**
 * What a routine still needs before it can run: a how-to, a model set, or both.
 * Null means it is ready. Drives the amber badge on every routine surface, so
 * the sidebar and the panel never disagree about what is missing.
 */
export function routineGap(routine: Pick<Routine, 'howTo' | 'agents'>): string | null {
  const missing: string[] = []
  if (!routineHowToComplete(routine)) missing.push('a how-to')
  if (!routineAgentsComplete(routine)) missing.push('a model')
  if (missing.length === 0) return null
  return `Needs ${missing.join(' and ')}`
}

// ─── Hand-off ─────────────────────────────────────────────────────────────

/**
 * The context summary that seeds a project fork, so the project thread continues
 * with the routine's instructions and the task's last run in view.
 */
export function handoffSummary(
  task: Pick<Thread, 'title' | 'lastRunAt'>,
  routine: Pick<Routine, 'name' | 'howTo'> | null
): string {
  const lines = [
    `Handed off from Assistant View on ${new Date().toLocaleString()}.`,
    `Task: ${task.title}`
  ]
  if (routine) lines.push(`Routine: ${routine.name}`)
  const howTo = routine?.howTo?.trim()
  if (howTo) lines.push('', 'How-to:', howTo)
  if (task.lastRunAt !== undefined) {
    lines.push('', `Last scheduled run: ${new Date(task.lastRunAt).toLocaleString()}`)
  }
  return lines.join('\n')
}

// ─── Connections ──────────────────────────────────────────────────────────

/** How a routine connection resolves against the app utility library. */
export type ConnectionStatus = 'ready' | 'disabled' | 'incomplete' | 'needs-setup'

export interface ConnectionView {
  connection: RoutineConnection
  /** The library utility this connection resolves to, or null when missing. */
  utility: UtilityDefinition | null
  /**
   * The library entry it resolved to, whether a registry utility or a
   * harness-discovered capability, or null when the library does not carry it.
   */
  entry: ConnectionLibraryEntry | null
  status: ConnectionStatus
  /** Short reason shown under the row when the status is not `ready`. */
  detail: string
}

/** Lowercase alphanumeric form used for name matching. */
const normalizeName = normalizeConnectionName

/** Whether a connection label names a library utility. */
function matchesUtility(label: string, utility: UtilityDefinition): boolean {
  return [utility.name, utility.id].some((candidate) => connectionNamesOverlap(candidate, label))
}

/** The `{env:NAME}` references an MCP utility declares in its environment/headers. */
function declaredSecretNames(utility: UtilityDefinition): string[] {
  if (utility.kind !== 'mcp') return []
  const names = new Set<string>()
  const collect = (record: Record<string, string> | undefined): void => {
    for (const value of Object.values(record ?? {})) {
      for (const match of value.matchAll(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        if (match[1]) names.add(match[1])
      }
    }
  }
  collect(utility.config.environment)
  collect(utility.config.headers)
  return [...names]
}

/** An obvious hole in a utility's own configuration, or null when it looks set. */
function utilityConfigGap(utility: UtilityDefinition): string | null {
  switch (utility.kind) {
    case 'mcp':
      if (!utility.config.command && !utility.config.url) return 'No server command or URL'
      return null
    case 'provider':
      if (!utility.config.providerId) return 'No provider selected'
      return null
    case 'computer_use':
      if (!utility.config.backend) return 'No backend configured'
      return null
    case 'skill':
      if (!utility.config.instructions.trim()) return 'No instructions written'
      return null
    case 'web_search':
    case 'web_fetch':
      if (utility.config.provider === 'custom' && !utility.config.endpoint) {
        return 'No endpoint configured'
      }
      return null
    default:
      return null
  }
}

/**
 * Resolve a routine's connections against the connection library so the panel
 * can show what is actually ready. The library is the same union the Utilities
 * page renders   registry utilities plus the MCP servers and skills a harness
 * discovers   so a connection that points at a discovered capability resolves
 * instead of reading as missing. A connection the library does not carry, or one
 * that is switched off or half-configured, is surfaced as needing setup rather
 * than rendered as a working connection.
 */
export function resolveConnections(
  connections: readonly RoutineConnection[],
  catalog: UtilityCatalog | null,
  capabilities: AgentCapabilityCatalog | null = null
): ConnectionView[] {
  const library = buildConnectionLibrary(catalog, capabilities)
  return connections.map((connection) => {
    const entry = findConnectionEntry(library, connection)
    if (!entry) {
      return {
        connection,
        utility: null,
        entry: null,
        status: 'needs-setup',
        detail: 'Not in your utility library yet'
      }
    }
    if (!entry.enabled) {
      return {
        connection,
        utility: entry.utility,
        entry,
        status: 'disabled',
        detail: 'Switched off in Utilities'
      }
    }
    // A harness-discovered capability has no registry config to inspect, so it
    // is ready once it is switched on and carries a usable transport.
    if (!entry.utility) {
      if (entry.kind === 'mcp' && !entry.capability?.detail?.trim()) {
        return {
          connection,
          utility: null,
          entry,
          status: 'incomplete',
          detail: 'No server command or URL'
        }
      }
      return { connection, utility: null, entry, status: 'ready', detail: 'Ready' }
    }
    const utility = entry.utility
    const gap = utilityConfigGap(utility)
    if (gap) return { connection, utility, entry, status: 'incomplete', detail: gap }
    const stored = new Set(
      utility.credentials
        .map((credential) => credential.environmentVariable)
        .filter((name): name is string => Boolean(name))
    )
    const missing = declaredSecretNames(utility).filter((name) => !stored.has(name))
    if (missing.length > 0) {
      return {
        connection,
        utility,
        entry,
        status: 'incomplete',
        detail: `Needs ${missing.join(', ')}`
      }
    }
    return { connection, utility, entry, status: 'ready', detail: 'Ready' }
  })
}

/**
 * Fold the connections a plan names into a routine's connection list. An entry
 * that carries a `utilityId` links straight to that utility; otherwise the
 * name is matched against the library. A connection the library does not carry
 * stays as a required connection, which the panel renders as needing setup. An
 * entry already covered   by label, or by the utility it resolves to   is not
 * duplicated, and a plain string is accepted as shorthand for `{ name }`.
 *
 * A plan may also carry a `setup` prompt for a connection the agent could not
 * install itself. That prompt lands on the connection so the panel can prefill
 * the agent-assisted utility setup, and a later plan that refines it wins.
 */
export function connectionsFromPlan(
  entries: readonly (string | RoutinePlanConnection)[],
  existing: readonly RoutineConnection[],
  utilities: readonly UtilityDefinition[]
): RoutineConnection[] {
  const merged = [...existing]
  const indexOfCover = (label: string, utilityId: string | null): number => {
    const needle = normalizeName(label)
    return merged.findIndex((connection) => {
      if (utilityId !== null && connection.utilityId === utilityId) return true
      return [connection.label, connection.utilityId.replace(/^required:/, '')]
        .map(normalizeName)
        .some((candidate) => candidate === needle)
    })
  }
  for (const raw of entries) {
    const entry = typeof raw === 'string' ? { name: raw } : raw
    const label = entry.name.trim()
    if (!label) continue
    const setup = entry.setup?.trim() ?? ''
    const byId = entry.utilityId
      ? (utilities.find((candidate) => candidate.id === entry.utilityId) ?? null)
      : null
    const utility = byId ?? utilities.find((candidate) => matchesUtility(label, candidate)) ?? null
    const covered = indexOfCover(label, utility?.id ?? null)
    if (covered >= 0) {
      const existingConnection = merged[covered]
      if (setup && existingConnection) {
        merged[covered] = { ...existingConnection, setup }
      }
      continue
    }
    merged.push(
      utility
        ? {
            utilityId: utility.id,
            label: utility.name,
            kind: utility.kind,
            ...(setup ? { setup } : {})
          }
        : {
            utilityId: `required:${normalizeName(label)}`,
            label,
            required: true,
            ...(setup ? { setup } : {})
          }
    )
  }
  return merged
}
