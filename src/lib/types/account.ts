import type { ThinkingLevel } from './common'
import type { AccountActivityDay, AccountUsageBreakdown } from './usage'

/** Inclusive/exclusive local analytics window supplied by the Profile page. */
export interface LocalProfileAnalyticsRange {
  startAt: number
  endAt: number
}

/**
 * One clearable local usage record store on the Usage page. The split follows
 * the persisted records, not the page's panels: the activity calendar, models,
 * harnesses, providers, thinking levels, projects, daily and hourly charts are
 * all aggregates over the same `usage_events` ledger rows, so clearing any of
 * them independently would silently empty the rest.
 */
export type LocalUsageRecordStore = 'agentResponses' | 'utilities'

/** How many records each Usage page store currently holds. */
export interface LocalUsageRecordCounts {
  /** Model turn rows in the usage ledger inside the selected range. */
  agentResponses: number
  /** Auxiliary utility rows in the usage ledger inside the selected range. */
  utilities: number
}

/** Request to start a Usage page record store from a clean slate. */
export interface LocalUsageClearInput {
  /** Store to clear, or `all` for every store the Usage page reads. */
  store: LocalUsageRecordStore | 'all'
  /** Range whose ledger rows are removed. */
  range: LocalProfileAnalyticsRange
}

export interface LocalProfileUsageBreakdown extends AccountUsageBreakdown {
  harnessId?: string
  providerId?: string
  /** Reasoning effort of the turns this row aggregates, when the data is recorded. */
  thinkingLevel?: ThinkingLevel
  durationMs: number
}

/** Consumption recorded on one local calendar day in the selected usage range. */
export interface LocalProfileUsageDay extends AccountUsageBreakdown {
  /** Local date in YYYY-MM-DD form. */
  date: string
  durationMs: number
}

/** Consumption grouped by local hour of day across the selected usage range. */
export interface LocalProfileUsageHour extends AccountUsageBreakdown {
  /** Local hour from 0 through 23. */
  hour: number
  durationMs: number
}

/** Date-range project activity shown on the local Profile page. */
export interface LocalProfileProjectBreakdown extends AccountUsageBreakdown {
  name: string
  color?: string
  iconType?: string
  hasCustomIcon: boolean
  durationMs: number
  threadCount: number
  activeDays: number
  lastActiveAt: number
}

/** Fully local, range-aware analytics. This is never required for account authentication. */
export interface LocalProfileAnalytics {
  range: LocalProfileAnalyticsRange
  /** Rolling 12-month window represented by the activity calendar. */
  activityRange: LocalProfileAnalyticsRange
  messageCount: number
  costUsd: number
  tokens: number
  durationMs: number
  /** Wall-clock runtime of assistant responses, from agent_messages. */
  responseDurationMs: number
  topHarnessId: string | null
  topProviderId: string | null
  topModelId: string | null
  harnesses: LocalProfileUsageBreakdown[]
  providers: LocalProfileUsageBreakdown[]
  models: LocalProfileUsageBreakdown[]
  /** Standalone reasoning-effort rollup across every model in the period. */
  thinkingLevels: LocalProfileUsageBreakdown[]
  /** Auxiliary utility calls (image descriptor, memory, title) with their cost. */
  utilities: LocalProfileUsageBreakdown[]
  projects: LocalProfileProjectBreakdown[]
  activityDays: AccountActivityDay[]
  /** Total model and utility consumption for each active local day. */
  dailyUsage: LocalProfileUsageDay[]
  /** Total model and utility consumption by local hour of day. */
  hourlyUsage: LocalProfileUsageHour[]
  /** Current size of each clearable record store behind this page. */
  records: LocalUsageRecordCounts
  generatedAt: number
}
