/**
 * Schedule model for Assistant View routines and tasks.
 *
 * Pure, dependency-free next-run / previous-due math shared by the main-process
 * scheduler and the renderer (routine rows, the how-to panel's schedule editor).
 * All computation is local-time based: the app fires schedules against the
 * machine's clock, so a "daily 9am" cadence means 9am wherever the app runs.
 */

import { formatDateTime, formatTimeOfDay } from '../date-time-format'

export type ScheduleCadence = 'once' | 'hourly' | 'daily' | 'weekdays' | 'weekly'

/** One recurring (or one-shot) schedule. A routine carries the default; a task
 *  may override it. */
export interface RoutineSchedule {
  cadence: ScheduleCadence
  /** `HH:mm` times of day used by `daily`, `weekdays`, and `weekly`. */
  times: string[]
  /** `0` (Sunday) through `6` (Saturday); used by `weekly`. */
  weekdays?: number[]
  /** Epoch milliseconds; used by `once`. */
  onceAt?: number
}

/**
 * Why a scheduled fire was not run.
 *
 * `app-closed`   the app was not running at the due time (this launch began
 * after it). `delayed`   the app was running but could not start the run
 * within the grace window, typically because the machine slept or a tick was
 * held up.
 */
export type MissedRunReason = 'app-closed' | 'delayed'

/** A scheduled fire the app was not open to run. Surfaced, never auto-run. */
export interface MissedRun {
  /** Stable identity: one record per (task, intended fire time). */
  id: string
  /** The assistant task thread whose run was missed. */
  threadId: string
  /** Owning routine, when the task belongs to one. */
  routineId?: string
  /** Intended fire time (epoch ms). */
  dueAt: number
  /** When the miss was detected (epoch ms). */
  detectedAt: number
  /** Title snapshot so the list renders without re-reading the thread. */
  title: string
  /**
   * Why the fire was not run, so the surfaces can state what actually happened
   * instead of always claiming the app was closed. Absent on records written
   * before this field existed; treated as `app-closed`.
   */
  reason?: MissedRunReason
  status: 'pending' | 'dismissed' | 'run'
}

export const SCHEDULE_CADENCES: readonly ScheduleCadence[] = [
  'once',
  'hourly',
  'daily',
  'weekdays',
  'weekly'
]

export const CADENCE_LABELS: Readonly<Record<ScheduleCadence, string>> = {
  once: 'Once',
  hourly: 'Hourly',
  daily: 'Daily',
  weekdays: 'Weekdays',
  weekly: 'Weekly'
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** Parse an `HH:mm` string into hours/minutes, or null when malformed. */
export function parseTimeOfDay(value: string): { hours: number; minutes: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return { hours, minutes }
}

/** Ascending, de-duplicated `HH:mm` values, dropping malformed entries. */
export function normalizedTimes(schedule: RoutineSchedule): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of schedule.times) {
    const parsed = parseTimeOfDay(raw)
    if (!parsed) continue
    const key = `${String(parsed.hours).padStart(2, '0')}:${String(parsed.minutes).padStart(2, '0')}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(key)
  }
  return result.sort()
}

function dayMatches(schedule: RoutineSchedule, day: Date): boolean {
  const weekday = day.getDay()
  if (schedule.cadence === 'weekdays') return weekday >= 1 && weekday <= 5
  if (schedule.cadence === 'weekly') {
    const days = schedule.weekdays ?? []
    return days.length === 0 ? true : days.includes(weekday)
  }
  return true
}

/** Whether the schedule can ever fire (has a target time configured). */
export function scheduleIsActive(schedule: RoutineSchedule | null | undefined): boolean {
  if (!schedule) return false
  if (schedule.cadence === 'once') return schedule.onceAt !== undefined
  if (schedule.cadence === 'hourly') return true
  return normalizedTimes(schedule).length > 0
}

/**
 * The next fire strictly after `from`, or null when the schedule is inactive or
 * exhausted. `weekly` and `weekdays` are bounded to a two-week lookahead, so a
 * schedule whose weekdays never match can never loop forever.
 */
export function nextRunAt(
  schedule: RoutineSchedule | null | undefined,
  from: number
): number | null {
  if (!schedule) return null
  if (schedule.cadence === 'once') {
    return schedule.onceAt !== undefined && schedule.onceAt > from ? schedule.onceAt : null
  }
  if (schedule.cadence === 'hourly') {
    const hourStart = new Date(from)
    hourStart.setMinutes(0, 0, 0)
    let candidate = hourStart.getTime()
    if (candidate <= from) candidate += 60 * 60 * 1000
    return candidate
  }

  const times = normalizedTimes(schedule)
  if (times.length === 0) return null
  const base = new Date(from)
  for (let dayOffset = 0; dayOffset <= 14; dayOffset++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset)
    if (!dayMatches(schedule, day)) continue
    for (const time of times) {
      const parsed = parseTimeOfDay(time)
      if (!parsed) continue
      const candidate = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        parsed.hours,
        parsed.minutes,
        0,
        0
      ).getTime()
      if (candidate > from) return candidate
    }
  }
  return null
}

/**
 * The most recent intended fire at or before `now`, or null when nothing has
 * come due yet. The scheduler compares this against the task's last fire to
 * decide between dispatching a run and recording a missed run.
 */
export function previousDueAt(
  schedule: RoutineSchedule | null | undefined,
  now: number
): number | null {
  if (!schedule) return null
  if (schedule.cadence === 'once') {
    return schedule.onceAt !== undefined && schedule.onceAt <= now ? schedule.onceAt : null
  }
  if (schedule.cadence === 'hourly') {
    const hourStart = new Date(now)
    hourStart.setMinutes(0, 0, 0)
    return hourStart.getTime()
  }

  const times = normalizedTimes(schedule)
  if (times.length === 0) return null
  const base = new Date(now)
  for (let dayOffset = 0; dayOffset >= -14; dayOffset--) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset)
    if (!dayMatches(schedule, day)) continue
    for (let index = times.length - 1; index >= 0; index--) {
      const parsed = parseTimeOfDay(times[index])
      if (!parsed) continue
      const candidate = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        parsed.hours,
        parsed.minutes,
        0,
        0
      ).getTime()
      if (candidate <= now) return candidate
    }
  }
  return null
}

/**
 * Human-readable summary used by rows, the schedule editor, and tooltips.
 *
 * Times are stored as `HH:mm` and read as the app's 12-hour clock, so a daily
 * `08:05` reads `Daily at 8:05 AM`.
 */
export function describeSchedule(schedule: RoutineSchedule | null | undefined): string {
  if (!scheduleIsActive(schedule) || !schedule) return 'Not scheduled'
  const times = normalizedTimes(schedule).map(formatTimeOfDay)
  if (schedule.cadence === 'once') {
    return `Once on ${formatDateTime(schedule.onceAt ?? 0)}`
  }
  if (schedule.cadence === 'hourly') return 'Every hour'
  if (schedule.cadence === 'daily') return `Daily at ${times.join(', ')}`
  if (schedule.cadence === 'weekdays') return `Weekdays at ${times.join(', ')}`
  const days = (schedule.weekdays ?? []).map((day) => WEEKDAY_SHORT[day] ?? '?').join(', ')
  return days ? `Weekly on ${days} at ${times.join(', ')}` : `Weekly at ${times.join(', ')}`
}

/** Relative description of a fire time ("in 2h", "3h ago"). */
export function describeRelativeTime(target: number, now: number): string {
  const delta = target - now
  const past = delta < 0
  const minutes = Math.round(Math.abs(delta) / 60_000)
  let label: string
  if (minutes < 1) label = 'now'
  else if (minutes < 60) label = `${minutes}m`
  else if (minutes < 60 * 24) label = `${Math.round(minutes / 60)}h`
  else label = `${Math.round(minutes / (60 * 24))}d`
  if (label === 'now') return 'now'
  return past ? `${label} ago` : `in ${label}`
}

/** Dedup key for one intended fire of one task. */
export function missedRunId(threadId: string, dueAt: number): string {
  return `${threadId}:${dueAt}`
}
