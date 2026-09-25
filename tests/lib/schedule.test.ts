import { describe, expect, it } from 'vitest'
import {
  describeSchedule,
  missedRunId,
  nextRunAt,
  normalizedTimes,
  parseTimeOfDay,
  previousDueAt,
  scheduleIsActive,
  type RoutineSchedule
} from '../../src/lib/types/schedule'

/** Build a local-time Date at a fixed wall clock so tests never depend on TZ. */
function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

const daily = (times: string[]): RoutineSchedule => ({ cadence: 'daily', times })
const weekly = (weekdays: number[], times: string[]): RoutineSchedule => ({
  cadence: 'weekly',
  times,
  weekdays
})

describe('parseTimeOfDay', () => {
  it('parses valid times and rejects malformed ones', () => {
    expect(parseTimeOfDay('09:30')).toEqual({ hours: 9, minutes: 30 })
    expect(parseTimeOfDay('9:05')).toEqual({ hours: 9, minutes: 5 })
    expect(parseTimeOfDay('24:00')).toBeNull()
    expect(parseTimeOfDay('09:60')).toBeNull()
    expect(parseTimeOfDay('noon')).toBeNull()
  })
})

describe('normalizedTimes', () => {
  it('sorts, de-duplicates, and drops malformed times', () => {
    expect(normalizedTimes(daily(['17:00', '9:00', '09:00', 'bad']))).toEqual(['09:00', '17:00'])
  })
})

describe('scheduleIsActive', () => {
  it('is false for empty schedules and true when a target exists', () => {
    expect(scheduleIsActive(null)).toBe(false)
    expect(scheduleIsActive(daily([]))).toBe(false)
    expect(scheduleIsActive(daily(['09:00']))).toBe(true)
    expect(scheduleIsActive({ cadence: 'hourly', times: [] })).toBe(true)
    expect(scheduleIsActive({ cadence: 'once', times: [] })).toBe(false)
    expect(scheduleIsActive({ cadence: 'once', times: [], onceAt: 123 })).toBe(true)
  })
})

describe('nextRunAt', () => {
  it('returns the next daily time later the same day', () => {
    const from = at(2026, 3, 10, 8, 0)
    expect(nextRunAt(daily(['09:00', '17:00']), from)).toBe(at(2026, 3, 10, 9, 0))
  })

  it('rolls to the next day once all of today\'s times have passed', () => {
    const from = at(2026, 3, 10, 18, 0)
    expect(nextRunAt(daily(['09:00', '17:00']), from)).toBe(at(2026, 3, 11, 9, 0))
  })

  it('never returns a time at or before `from`', () => {
    const from = at(2026, 3, 10, 9, 0)
    expect(nextRunAt(daily(['09:00']), from)).toBe(at(2026, 3, 11, 9, 0))
  })

  it('skips weekends for weekdays', () => {
    // Friday 2026-03-13 18:00 -> Monday 2026-03-16 09:00
    const from = at(2026, 3, 13, 18, 0)
    expect(nextRunAt({ cadence: 'weekdays', times: ['09:00'] }, from)).toBe(
      at(2026, 3, 16, 9, 0)
    )
  })

  it('honours the selected weekdays for weekly', () => {
    // Sunday 2026-03-08 10:00; weekly on Monday -> Monday 2026-03-09 09:00
    const from = at(2026, 3, 8, 10, 0)
    expect(nextRunAt(weekly([1], ['09:00']), from)).toBe(at(2026, 3, 9, 9, 0))
  })

  it('returns the next top of the hour for hourly', () => {
    const from = at(2026, 3, 10, 8, 30)
    expect(nextRunAt({ cadence: 'hourly', times: [] }, from)).toBe(at(2026, 3, 10, 9, 0))
  })

  it('returns the once time only when still in the future', () => {
    const onceAt = at(2026, 3, 10, 9, 0)
    expect(nextRunAt({ cadence: 'once', times: [], onceAt }, at(2026, 3, 10, 8, 0))).toBe(onceAt)
    expect(nextRunAt({ cadence: 'once', times: [], onceAt }, at(2026, 3, 10, 10, 0))).toBeNull()
  })

  it('returns null for an inactive schedule', () => {
    expect(nextRunAt(daily([]), Date.now())).toBeNull()
    expect(nextRunAt(null, Date.now())).toBeNull()
  })
})

describe('previousDueAt', () => {
  it('returns the most recent due time, including one earlier the same day', () => {
    const now = at(2026, 3, 10, 18, 0)
    expect(previousDueAt(daily(['09:00', '17:00']), now)).toBe(at(2026, 3, 10, 17, 0))
  })

  it('rolls back to the previous day before the first time of day', () => {
    const now = at(2026, 3, 10, 8, 0)
    expect(previousDueAt(daily(['09:00', '17:00']), now)).toBe(at(2026, 3, 9, 17, 0))
  })

  it('returns null before a once schedule has ever come due', () => {
    const onceAt = at(2026, 3, 10, 9, 0)
    expect(previousDueAt({ cadence: 'once', times: [], onceAt }, at(2026, 3, 10, 8, 0))).toBeNull()
    expect(previousDueAt({ cadence: 'once', times: [], onceAt }, at(2026, 3, 10, 10, 0))).toBe(onceAt)
  })
})

describe('describeSchedule', () => {
  it('labels empty schedules and each cadence', () => {
    expect(describeSchedule(null)).toBe('Not scheduled')
    expect(describeSchedule({ cadence: 'hourly', times: [] })).toBe('Every hour')
    expect(describeSchedule(daily(['09:00', '17:00']))).toBe('Daily at 9:00 AM, 5:00 PM')
    expect(describeSchedule({ cadence: 'weekdays', times: ['09:00'] })).toBe('Weekdays at 9:00 AM')
    expect(describeSchedule(weekly([1, 3], ['09:00']))).toBe('Weekly on Mon, Wed at 9:00 AM')
  })

  it('reads a stored HH:mm time as the app clock, never as 24-hour', () => {
    expect(describeSchedule(daily(['00:00']))).toBe('Daily at 12:00 AM')
    expect(describeSchedule(daily(['12:00']))).toBe('Daily at 12:00 PM')
    expect(describeSchedule(daily(['8:05', '20:30']))).toBe('Daily at 8:05 AM, 8:30 PM')
    expect(describeSchedule(daily(['23:59']))).toBe('Daily at 11:59 PM')
  })
})

describe('missedRunId', () => {
  it('is stable for a task and intended fire time', () => {
    expect(missedRunId('t1', 123)).toBe('t1:123')
    expect(missedRunId('t1', 123)).toBe(missedRunId('t1', 123))
    expect(missedRunId('t1', 123)).not.toBe(missedRunId('t1', 124))
  })
})
