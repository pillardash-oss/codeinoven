import { SvelteDate, SvelteMap } from 'svelte/reactivity'
import { APP_LOCALE } from '$shared/date-time-format'
import type {
  LocalProfileAnalytics,
  LocalProfileUsageBreakdown,
  LocalProfileUsageHour
} from '$shared/types'
import {
  localDateKey,
  type CalendarDay,
  type CalendarWeek,
  type ModelRankMetric
} from './profile-settings-format'

const MONTH_FORMATTER = new Intl.DateTimeFormat(APP_LOCALE, { month: 'short' })

export function buildCalendarWeeks(
  usage: LocalProfileAnalytics,
  activityByDate: Map<string, number>
): CalendarWeek[] {
  const rangeStart = new SvelteDate(usage.activityRange.startAt)
  const rangeEndDay = new SvelteDate(usage.activityRange.endAt - 1)
  const start = new SvelteDate(rangeStart)
  start.setDate(rangeStart.getDate() - rangeStart.getDay())
  start.setHours(12, 0, 0, 0)
  const end = new SvelteDate(rangeEndDay)
  end.setDate(rangeEndDay.getDate() + (6 - rangeEndDay.getDay()))
  end.setHours(12, 0, 0, 0)

  const weeks: CalendarWeek[] = []
  let previousMonth = -1
  for (let weekIndex = 0; weekIndex < 54; weekIndex += 1) {
    const days: CalendarDay[] = []
    const firstDay = new SvelteDate(start)
    firstDay.setDate(start.getDate() + weekIndex * 7)
    if (firstDay.getTime() > end.getTime()) break
    const month = firstDay.getMonth()
    const monthLabel = month !== previousMonth ? MONTH_FORMATTER.format(firstDay) : ''
    previousMonth = month

    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const date = new SvelteDate(firstDay)
      date.setDate(firstDay.getDate() + dayIndex)
      const key = localDateKey(date)
      days.push({
        date: key,
        count: activityByDate.get(key) ?? 0,
        outsideRange:
          date.getTime() < usage.activityRange.startAt ||
          date.getTime() >= usage.activityRange.endAt,
        selected: date.getTime() >= usage.range.startAt && date.getTime() < usage.range.endAt
      })
    }
    weeks.push({
      days,
      monthLabel,
      selected: days.some((day) => day.selected),
      rangeStart: false,
      rangeEnd: false
    })
  }
  const firstSelectedWeek = weeks.findIndex((week) => week.selected)
  const lastSelectedWeek = weeks.findLastIndex((week) => week.selected)
  const rangeStartWeek = weeks[firstSelectedWeek]
  const rangeEndWeek = weeks[lastSelectedWeek]
  if (rangeStartWeek) rangeStartWeek.rangeStart = true
  if (rangeEndWeek) rangeEndWeek.rangeEnd = true
  return weeks
}

/** Fills a stable 0-23 hourly timeline, adding zeroed rows for unrecorded hours. */
export function buildHourlyTimeline(hourlyUsage: LocalProfileUsageHour[]): LocalProfileUsageHour[] {
  const byHour = new Map(hourlyUsage.map((item) => [item.hour, item]))
  return Array.from({ length: 24 }, (_, hour): LocalProfileUsageHour => {
    return (
      byHour.get(hour) ?? {
        id: String(hour),
        hour,
        messageCount: 0,
        costUsd: 0,
        tokens: 0,
        durationMs: 0
      }
    )
  })
}

/** Groups per-thinking-level model rows back into one row per model, ranked by `metric`. */
export function groupTopModels(
  models: LocalProfileUsageBreakdown[],
  metric: ModelRankMetric
): LocalProfileUsageBreakdown[] {
  const grouped = new SvelteMap<string, LocalProfileUsageBreakdown>()
  for (const model of models) {
    const key = `${model.harnessId ?? ''}:${model.providerId ?? ''}:${model.id}`
    const existing = grouped.get(key)
    if (existing) {
      existing.messageCount += model.messageCount
      existing.costUsd += model.costUsd
      existing.tokens += model.tokens
      existing.durationMs += model.durationMs
      continue
    }
    grouped.set(key, {
      id: model.id,
      ...(model.harnessId ? { harnessId: model.harnessId } : {}),
      ...(model.providerId ? { providerId: model.providerId } : {}),
      messageCount: model.messageCount,
      costUsd: model.costUsd,
      tokens: model.tokens,
      durationMs: model.durationMs
    })
  }
  return [...grouped.values()]
    .sort((left, right) => {
      const difference =
        metric === 'cost'
          ? right.costUsd - left.costUsd
          : metric === 'runtime'
            ? right.durationMs - left.durationMs
            : right.tokens - left.tokens
      return difference || right.tokens - left.tokens || right.messageCount - left.messageCount
    })
    .slice(0, 3)
}
