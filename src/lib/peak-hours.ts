/**
 * Peak-hours / off-peak pricing schedules for models billed by time of day.
 *
 * Availability of peak billing is NOT reported by the harness catalogs or the
 * llmpricing.dev pricing feed, so it is curated here in a registry
 * (`PEAK_HOURS_REGISTRY`) — exactly like `fast-inference.ts` curates fast-tier
 * multipliers. Register a model, a model family, or a whole provider with
 * `registerPeakHours` when a vendor moves billing to time of day (e.g. the
 * DeepSeek V4 family, which bills peak vs off-peak from Aug 16 2026).
 *
 * Peak windows are stored in UTC (the vendor's denomination) and converted to
 * the user's local timezone at render time, so the badge state and the hover
 * description always match "now" in the user's timezone.
 *
 * Some vendors bill peak rates on weekdays only (e.g. DeepSeek applies its peak
 * windows Monday through Friday and bills off-peak all day on Saturdays and
 * Sundays). Schedules that do this declare a `days` set; schedules without one
 * apply their windows every day of the week.
 *
 * A schedule may also carry the vendor's peak multiplier. The pricing feed
 * publishes ONE flat official rate per model, and for a vendor that bills by
 * hour that flat rate is its off-peak rate, so the multiplier is what raises a
 * cost estimate inside a peak window. It is curated from the vendor's official
 * pricing page, the same as the windows themselves.
 */

import { formatTime } from './date-time-format'

/** A single daily peak window, clamped to `[0, 24]` UTC hours. */
export interface PeakHoursWindow {
  /** Inclusive start hour (UTC), `0-23`. */
  startHour: number
  /** Exclusive end hour (UTC), `1-24`. */
  endHour: number
}

/** Time-of-day pricing schedule for one model family. */
export interface PeakHoursSchedule {
  /** Human label for the pricing scheme, e.g. "DeepSeek V4". */
  label: string
  /** Peak windows (UTC). Every other hour of the day bills off-peak. */
  windows: PeakHoursWindow[]
  /**
   * UTC days of week (0=Sunday … 6=Saturday) on which the peak windows apply,
   * e.g. `[1, 2, 3, 4, 5]` for weekday-only billing. Omitted = every day.
   * Outside these days the model bills off-peak around the clock.
   */
  days?: readonly number[]
  /**
   * Multiplier applied to the vendor's reference rate inside a peak window,
   * e.g. `2` when peak rates are double off-peak. Omitted when the vendor
   * bills peak hours but publishes no peak rate, in which case a cost estimate
   * keeps using the reference rate and records the window it fell in.
   */
  peakMultiplier?: number
}

/** What a model's peak-hours badge should say right now, or null when the model
 *  has no time-of-day pricing. */
export interface PeakHoursBadge {
  state: 'peak' | 'off-peak'
  /** Badge label for model rows: `Peak` while billing peak, `Off peak` otherwise. */
  label: string
  /** Compact badge label for the composer trigger: `Peak` / `Off P`. */
  triggerLabel: string
  /** Tooltip/aria text: `Peak: <local time-ranges>`, with the day scope when
   *  peak billing is not daily   `Peak (Mon–Fri): <local time-ranges>`. */
  tooltip: string
}

/**
 * DeepSeek V4   peak `01:00–04:00` and `06:00–10:00` UTC, weekdays only
 * (Monday–Friday); weekends bill off-peak around the clock.
 *
 * Peak rates are double the reference rate. DeepSeek's official pricing page
 * states "Off-peak rates are half of the peak rates. Peak hours are 01:00 -
 * 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public
 * holidays", and its peak column is exactly 2x the off-peak column the pricing
 * feed publishes (Flash `0.15/0.6/0.003` → `0.3/1.2/0.006`, Pro
 * `0.66/1.98/0.022` → `1.32/3.96/0.044`). OpenRouter's published per-window
 * overrides for the Pro model double the same three rates inside the same two
 * windows, so both sources agree on the multiplier.
 *
 * Chinese public holidays are billed off-peak and are NOT modelled here, so a
 * holiday run inside a window is recorded at peak rates.
 */
export const DEEPSEEK_V4_PEAK_HOURS: PeakHoursSchedule = {
  label: 'DeepSeek V4',
  windows: [
    { startHour: 1, endHour: 4 },
    { startHour: 6, endHour: 10 }
  ],
  days: [1, 2, 3, 4, 5],
  peakMultiplier: 2
}

/** How a peak-hours registration selects the models it bills. */
export type PeakHoursMatcher =
  | { kind: 'model'; modelId: string }
  | { kind: 'family'; pattern: RegExp }
  | { kind: 'provider'; providerId: string }

/** One entry of the peak-hours registry: a schedule plus what it applies to. */
export interface PeakHoursRegistration {
  schedule: PeakHoursSchedule
  match: PeakHoursMatcher
}

/**
 * The peak-hours registry. Curated (not reported by harness catalogs or the
 * pricing feed), so vendors/models/providers are registered here explicitly.
 *
 * Lookup precedence when several entries could apply: exact model id wins over
 * family pattern wins over provider id; ties resolve in registration order.
 * This lets a provider-wide billing scheme be overridden for single models.
 * Family patterns are tested against every identity form of a model (its id, the
 * bare model part of a namespaced id, and its display name), never against the
 * harness or provider serving it.
 */
const PEAK_HOURS_REGISTRY: PeakHoursRegistration[] = [
  {
    // Paid DeepSeek V4 family: every `deepseek-v4…` variant (flash/pro and
    // future versions like `deepseek-v4.1`) bills the same time-of-day scheme.
    // Family patterns may match anywhere after a string start or a `/`, so
    // provider-namespaced ids (e.g. `cline-pass/deepseek-v4-flash`) resolve, and
    // the version may run straight into the family marker because a harness id
    // is not the vendor's own spelling (`deepseek-v41-flash-1017`). The `-free`
    // tier is matched separately below and never billed.
    match: { kind: 'family', pattern: /(?:^|\/)deepseek-v4(?=[.-]|\d|$)/iu },
    schedule: DEEPSEEK_V4_PEAK_HOURS
  },
  {
    // Pi's own DeepSeek provider does not spell the family at all: it lists the
    // V4.1 flash model as `deepseek-flash`, so both the badge and the cost
    // estimate have to recognize that id as the flash model it is.
    match: { kind: 'model', modelId: 'deepseek-flash' },
    schedule: DEEPSEEK_V4_PEAK_HOURS
  }
]

/**
 * Register a model, family, or provider with the peak-hours registry.
 *
 * Returns a disposer that removes the entry again, so callers (e.g. a driver
 * discovering time-of-day billing at runtime) can unregister on teardown.
 */
export function registerPeakHours(registration: PeakHoursRegistration): () => void {
  PEAK_HOURS_REGISTRY.push(registration)
  return () => {
    const index = PEAK_HOURS_REGISTRY.indexOf(registration)
    if (index !== -1) PEAK_HOURS_REGISTRY.splice(index, 1)
  }
}

/** Free-tier model ids are never billed, so no peak/off-peak badge applies. */
const FREE_MODEL_PATTERN = /-free\b/iu

/**
 * The catalog reference a peak-hours lookup reads: the model id the harness
 * reports plus the model's display name.
 *
 * The id alone is not the model's identity. A vendor or gateway ships the same
 * model under ids that carry no family marker at all   Pi's `deepseek-flash` is
 * "DeepSeek V4.1 Flash", Cursor's is `deepseek-v41-flash-1017`   so the name is
 * matched as well. Billing follows the MODEL, never the harness that drives it
 * or the provider that serves it, which is why only the id and name decide the
 * family and the provider id is only consulted for provider-wide schedules.
 */
export interface PeakHoursModelRef {
  /** Model id as the harness reports it. */
  id: string
  /** Display name shown in the catalog, when the catalog carries one. */
  name?: string
}

/**
 * Normalize one id or display name into the id-like form the matchers read.
 *
 * Runtime labels a harness appends are dropped (`deepseek-…[reasoning_effort=high]`)
 * and every word separator collapses to a hyphen, so a display name
 * ("DeepSeek V4.1 Flash") reads as the id spelling it belongs to
 * (`deepseek-v4.1-flash`).
 */
function peakHoursIdentityForm(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]/gu, '')
    .replace(/[\s_]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^-+|-+$/gu, '')
}

/** Every id-like form one catalog model answers to: its id, the bare model part
 *  of a gateway-namespaced id, and its display name. */
function peakHoursIdentityForms(model: PeakHoursModelRef): string[] {
  const forms: string[] = []
  const push = (value: string | undefined): void => {
    if (!value) return
    const form = peakHoursIdentityForm(value)
    if (form && !forms.includes(form)) forms.push(form)
  }
  push(model.id)
  const slash = model.id.lastIndexOf('/')
  if (slash !== -1) push(model.id.slice(slash + 1))
  push(model.name)
  return forms
}

/** The peak/off-peak schedule for a catalog model (and, for provider-level
 *  registrations, its provider id), or null when the model has no time-of-day
 *  pricing. */
export function peakHoursScheduleFor(
  model: PeakHoursModelRef,
  providerId?: string
): PeakHoursSchedule | null {
  if (!model.id.trim()) return null
  const forms = peakHoursIdentityForms(model)
  // A free tier is never billed, and its display name says so too
  // ("DeepSeek V4.1 Flash Free").
  if (forms.some((form) => FREE_MODEL_PATTERN.test(form))) return null
  const provider = providerId?.trim().toLowerCase() ?? null
  for (const kind of ['model', 'family', 'provider'] as const) {
    for (const { match, schedule } of PEAK_HOURS_REGISTRY) {
      if (match.kind !== kind) continue
      const hit =
        match.kind === 'model'
          ? forms.includes(peakHoursIdentityForm(match.modelId))
          : match.kind === 'family'
            ? forms.some((form) => match.pattern.test(form))
            : provider !== null && match.providerId.trim().toLowerCase() === provider
      if (hit) return schedule
    }
  }
  return null
}

/** Short weekday names indexed by `Date#getUTCDay` (0=Sunday). */
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/**
 * Human day scope of the schedule's `days` set, or null when the windows apply
 * every day. Contiguous runs collapse to a range (`Mon–Fri`); anything else
 * lists the days (`Sat, Sun`), matching the window-label style.
 */
export function peakHoursDayScope(schedule: PeakHoursSchedule): string | null {
  const days = schedule.days ? [...schedule.days].sort((a, b) => a - b) : null
  if (!days || days.length === 0) return null
  const contiguous = days.every((day, index) => index === 0 || day === days[index - 1] + 1)
  if (contiguous && days.length > 1) {
    return `${DAY_NAMES[days[0]]}–${DAY_NAMES[days[days.length - 1]]}`
  }
  return days.map((day) => DAY_NAMES[day]).join(', ')
}

/** Whether `now` falls inside any of the schedule's peak windows (UTC), on a
 *  day the schedule bills peak. */
export function isPeakHour(schedule: PeakHoursSchedule, now = new Date()): boolean {
  if (schedule.days && !schedule.days.includes(now.getUTCDay())) return false
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes()
  return schedule.windows.some(
    (window) => utcMinutes >= window.startHour * 60 && utcMinutes < window.endHour * 60
  )
}

/**
 * Render the schedule's peak windows as clock times in the user's local
 * timezone. Boundaries are converted through real `Date` instants so DST
 * transitions are honored on the day the badge is drawn.
 */
function peakHoursLocalWindows(schedule: PeakHoursSchedule, now: Date): string[] {
  // UTC midnight of the user's current UTC day; adding the UTC window hours
  // yields exact UTC boundary instants that `formatTime` renders in local time.
  const utcDayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return schedule.windows.map((window) => {
    const start = formatTime(new Date(utcDayStart + window.startHour * 3_600_000))
    const end = formatTime(new Date(utcDayStart + window.endHour * 3_600_000))
    return `${start}–${end}`
  })
}

/** Human description of the peak windows in the user's local timezone. */
export function peakHoursLocalLabel(schedule: PeakHoursSchedule, now = new Date()): string {
  const windows = peakHoursLocalWindows(schedule, now)
  if (windows.length <= 1) return windows[0] ?? ''
  return windows.join(', ')
}

/** Badge data for a catalog model (and, for provider-level registrations, its
 *  provider id) right now, or null when the model has no time-of-day pricing. */
export function peakHoursBadgeFor(
  model: PeakHoursModelRef,
  providerId?: string,
  now = new Date()
): PeakHoursBadge | null {
  const schedule = peakHoursScheduleFor(model, providerId)
  if (!schedule) return null
  const peak = isPeakHour(schedule, now)
  // Day scope rides inside the tooltip   e.g. `Peak (Mon–Fri): 3:00 AM–6:00 AM`
  //   so daily schedules keep the plain form and weekday-only ones self-explain.
  const dayScope = peakHoursDayScope(schedule)
  const scopeSuffix = dayScope ? ` (${dayScope})` : ''
  return {
    state: peak ? 'peak' : 'off-peak',
    label: peak ? 'Peak' : 'Off peak',
    triggerLabel: peak ? 'Peak' : 'Off P',
    tooltip: `Peak${scopeSuffix}: ${peakHoursLocalLabel(schedule, now)}`
  }
}
