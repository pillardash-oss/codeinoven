/**
 * Peak-hours / off-peak pricing schedules for models billed by time of day.
 *
 * Availability of peak billing is NOT reported by the harness catalogs or the
 * llmpricing.dev pricing feed, so it is curated here — exactly like
 * `fast-inference.ts` curates fast-tier multipliers. Add a family entry when a
 * vendor moves a model to time-of-day billing (e.g. DeepSeek V4 Flash/Pro,
 * which bills peak vs off-peak from Aug 16 2026).
 *
 * Peak windows are stored in UTC (the vendor's denomination) and converted to
 * the user's local timezone at render time, so the badge state and the hover
 * description always match "now" in the user's timezone.
 *
 * Some vendors bill peak rates on weekdays only (e.g. DeepSeek applies its peak
 * windows Monday through Friday and bills off-peak all day on Saturdays and
 * Sundays). Schedules that do this declare a `days` set; schedules without one
 * apply their windows every day of the week.
 */

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
   *  peak billing is not daily — `Peak (Mon–Fri): <local time-ranges>`. */
  tooltip: string
}

/**
 * DeepSeek V4 — peak `01:00–04:00` and `06:00–10:00` UTC, weekdays only
 * (Monday–Friday); weekends bill off-peak around the clock.
 */
export const DEEPSEEK_V4_PEAK_HOURS: PeakHoursSchedule = {
  label: 'DeepSeek V4',
  windows: [
    { startHour: 1, endHour: 4 },
    { startHour: 6, endHour: 10 }
  ],
  days: [1, 2, 3, 4, 5]
}

/** Model families that bill peak vs off-peak, with the model id they apply to.
 *  Matched case-insensitively against the catalog model id. */
const PEAK_HOURS_SCHEDULES: ReadonlyArray<{
  match: RegExp
  schedule: PeakHoursSchedule
}> = [
  {
    // Paid DeepSeek V4 family (flash/pro and their dated/reasoning variants).
    // The `-free` tier is matched separately below and never billed.
    match: /^deepseek-v4-(?:flash|pro)/iu,
    schedule: DEEPSEEK_V4_PEAK_HOURS
  }
]

/** Free-tier model ids are never billed, so no peak/off-peak badge applies. */
const FREE_MODEL_PATTERN = /-free\b/iu

/** The peak/off-peak schedule for a catalog model id, or null when the model
 *  has no time-of-day pricing. */
export function peakHoursScheduleFor(modelId: string): PeakHoursSchedule | null {
  const id = modelId.trim().toLowerCase()
  if (!id || FREE_MODEL_PATTERN.test(id)) return null
  for (const { match, schedule } of PEAK_HOURS_SCHEDULES) {
    if (match.test(id)) return schedule
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
    (window) =>
      utcMinutes >= window.startHour * 60 && utcMinutes < window.endHour * 60
  )
}

/**
 * Render the schedule's peak windows as clock times in the user's local
 * timezone. Boundaries are converted through real `Date` instants so DST
 * transitions are honored on the day the badge is drawn.
 */
function peakHoursLocalWindows(schedule: PeakHoursSchedule, now: Date): string[] {
  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
  // UTC midnight of the user's current UTC day; adding the UTC window hours
  // yields exact UTC boundary instants that `formatter` renders in local time.
  const utcDayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return schedule.windows.map((window) => {
    const start = formatter.format(new Date(utcDayStart + window.startHour * 3_600_000))
    const end = formatter.format(new Date(utcDayStart + window.endHour * 3_600_000))
    return `${start}–${end}`
  })
}

/** Human description of the peak windows in the user's local timezone. */
export function peakHoursLocalLabel(schedule: PeakHoursSchedule, now = new Date()): string {
  const windows = peakHoursLocalWindows(schedule, now)
  if (windows.length <= 1) return windows[0] ?? ''
  return windows.join(', ')
}

/** Badge data for a catalog model id right now, or null when the model has no
 *  time-of-day pricing. */
export function peakHoursBadgeFor(modelId: string, now = new Date()): PeakHoursBadge | null {
  const schedule = peakHoursScheduleFor(modelId)
  if (!schedule) return null
  const peak = isPeakHour(schedule, now)
  // Day scope rides inside the tooltip — e.g. `Peak (Mon–Fri): 3:00 AM–6:00 AM`
  // — so daily schedules keep the plain form and weekday-only ones self-explain.
  const dayScope = peakHoursDayScope(schedule)
  const scopeSuffix = dayScope ? ` (${dayScope})` : ''
  return {
    state: peak ? 'peak' : 'off-peak',
    label: peak ? 'Peak' : 'Off peak',
    triggerLabel: peak ? 'Peak' : 'Off P',
    tooltip: `Peak${scopeSuffix}: ${peakHoursLocalLabel(schedule, now)}`
  }
}
