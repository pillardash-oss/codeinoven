import { SvelteDate } from 'svelte/reactivity'
import type {
  AccountUsageBreakdown,
  LocalProfileAnalytics,
  LocalProfileAnalyticsRange,
  LocalProfileModelRanking,
  LocalProfileRankingModeStats,
  ThinkingLevel
} from '$shared/types'
import { STANDARD_THINKING_PRESETS } from '$shared/thinking-presets'

export type ThinkingFilter = 'all' | ThinkingLevel
export type ShotFilter = 'all' | 'one_shot' | 'multi_shot'
export type RankingSortKey = 'aggregate' | 'one_shot' | 'multi_shot'
export type RangePreset = 'today' | 'yesterday' | '7d' | '30d' | 'year' | 'custom'
export type ModelRankMetric = 'cost' | 'tokens' | 'runtime'

export interface CalendarDay {
  date: string
  count: number
  outsideRange: boolean
  selected: boolean
}

export interface CalendarWeek {
  days: CalendarDay[]
  monthLabel: string
  selected: boolean
  rangeStart: boolean
  rangeEnd: boolean
}

export const RANGE_PRESETS: ReadonlyArray<{
  id: Exclude<RangePreset, 'custom'>
  label: string
  days: number
  endOffsetDays?: number
}> = [
  { id: 'today', label: 'Today', days: 1 },
  { id: 'yesterday', label: 'Yesterday', days: 1, endOffsetDays: 0 },
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: 'year', label: '12 months', days: 365 }
]

export const MODEL_RANK_METRICS: readonly ModelRankMetric[] = ['cost', 'tokens', 'runtime']

export function analyticsRange(days: number, endOffsetDays = 1): LocalProfileAnalyticsRange {
  const end = new SvelteDate()
  end.setHours(0, 0, 0, 0)
  end.setDate(end.getDate() + endOffsetDays)
  const start = new SvelteDate(end)
  start.setDate(end.getDate() - days)
  return { startAt: start.getTime(), endAt: end.getTime() }
}

export function localDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function dateInputValue(value: number): string {
  return localDateKey(new SvelteDate(value))
}

export function localDateFromInput(value: string): SvelteDate | null {
  const parts = value.split('-').map(Number)
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return null
  const [year, month, day] = parts
  if (year === undefined || month === undefined || day === undefined) return null
  const date = new SvelteDate(year, month - 1, day)
  date.setHours(0, 0, 0, 0)
  return localDateKey(date) === value ? date : null
}

export const DEFAULT_RANGE = analyticsRange(365)

export const EMPTY_USAGE: LocalProfileAnalytics = {
  range: DEFAULT_RANGE,
  activityRange: analyticsRange(365),
  messageCount: 0,
  costUsd: 0,
  tokens: 0,
  durationMs: 0,
  topHarnessId: null,
  topProviderId: null,
  topModelId: null,
  harnesses: [],
  providers: [],
  models: [],
  thinkingLevels: [],
  utilities: [],
  projects: [],
  activityDays: [],
  dailyUsage: [],
  hourlyUsage: [],
  modelRankings: [],
  responseDurationMs: 0,
  gradingSpend: {
    costUsd: 0
  },
  records: {
    agentResponses: 0,
    utilities: 0,
    modelRankings: 0,
    pendingGrades: 0
  },
  generatedAt: 0
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1
  }).format(value)
}

export function formatCost(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 1 ? 2 : 0,
    maximumFractionDigits: value < 1 ? 4 : 2
  }).format(value)
}

export function formatDuration(value: number): string {
  if (value > 0 && value < 60_000) return '<1m'
  const totalMinutes = Math.round(value / 60_000)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
}

export function utilityLabel(id: string): string {
  switch (id) {
    case 'image_descriptor':
      return 'Image descriptor'
    case 'memory':
      return 'Memory'
    case 'title':
      return 'Title generation'
    default:
      return id
  }
}

export function formatDateRange(range: LocalProfileAnalyticsRange): string {
  const format = new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })
  return `${format.format(range.startAt)} – ${format.format(range.endAt - 1)}`
}

export function formatDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(value)
}

/** Spelled-out date for confirmations, where an abbreviated month reads as a code. */
export function formatLongDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(value)
}

export function formatUsageDate(value: string): string {
  const date = localDateFromInput(value)
  if (!date) return value
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

export function formatHour(hour: number): string {
  const date = new SvelteDate(2000, 0, 1, hour)
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(date)
}

export function formatIdentifier(value: string): string {
  return value
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function activityClass(day: CalendarDay, maxActivity: number): string {
  if (day.outsideRange) return 'bg-transparent'
  if (day.count <= 0 || maxActivity <= 0) return 'bg-raised'
  const ratio = day.count / maxActivity
  if (ratio <= 0.25) return 'bg-primary/25'
  if (ratio <= 0.5) return 'bg-primary/50'
  if (ratio <= 0.75) return 'bg-primary/75'
  return 'bg-primary'
}

export function usageWidth(item: AccountUsageBreakdown, maximum: number): string {
  if (maximum <= 0) return '0%'
  return `${Math.max(4, (item.tokens / maximum) * 100)}%`
}

export function usageHeight(item: AccountUsageBreakdown, maximum: number): string {
  if (maximum <= 0 || item.tokens <= 0) return '2px'
  return `${Math.max(8, (item.tokens / maximum) * 100)}%`
}

export function thinkingLevelLabel(level: ThinkingLevel): string {
  return (
    STANDARD_THINKING_PRESETS.find((preset) => preset.id === level)?.label ??
    level.charAt(0).toUpperCase() + level.slice(1)
  )
}

export function rankingScoreLabel(stats: LocalProfileRankingModeStats): string {
  if (stats.samples === 0 || stats.averageScore === null) return ' '
  return `${stats.averageScore.toFixed(1)}/10`
}

export function rankingSamplesLabel(stats: LocalProfileRankingModeStats): string {
  return stats.samples === 1 ? '1 conversation' : `${stats.samples} conversations`
}

export function rankingDurationLabel(stats: LocalProfileRankingModeStats): string {
  if (stats.samples === 0 || stats.averageDurationMs === null) return ' '
  return formatDuration(stats.averageDurationMs)
}

export function rankingAggregateLabel(entry: LocalProfileModelRanking): string {
  const aggregate = rankingAggregate(entry)
  return aggregate === null ? ' ' : `${aggregate.toFixed(1)}/10`
}

export function rankingTotalSamplesLabel(entry: LocalProfileModelRanking): string {
  const total = entry.oneShot.samples + entry.multiShot.samples
  return total === 1 ? '1 conversation' : `${total} conversations`
}

/** Sample-weighted average across both shot categories; null when nothing is ranked yet. */
export function rankingAggregate(entry: LocalProfileModelRanking): number | null {
  const oneShotScore = entry.oneShot.averageScore
  const multiShotScore = entry.multiShot.averageScore
  const samples = entry.oneShot.samples + entry.multiShot.samples
  if (samples === 0) return null
  const weighted =
    (oneShotScore === null ? 0 : oneShotScore * entry.oneShot.samples) +
    (multiShotScore === null ? 0 : multiShotScore * entry.multiShot.samples)
  const scoredSamples =
    (oneShotScore === null ? 0 : entry.oneShot.samples) +
    (multiShotScore === null ? 0 : entry.multiShot.samples)
  return scoredSamples === 0 ? null : weighted / scoredSamples
}
