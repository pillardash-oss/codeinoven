import type { RankingJudgeKind } from './agent'
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
export type LocalUsageRecordStore = 'agentResponses' | 'utilities' | 'modelRankings'

/**
 * How many records each Usage page store currently holds.
 *
 * The two ledger counts follow the selected range. Ranking rows and their
 * grading queue carry no per-range timestamp, so those two are always all-time.
 */
export interface LocalUsageRecordCounts {
  /** Model turn rows in the usage ledger inside the selected range. */
  agentResponses: number
  /** Auxiliary utility rows in the usage ledger inside the selected range. */
  utilities: number
  /** Permanent ranking aggregate rows (all-time). */
  modelRankings: number
  /** Conversations captured but not yet graded (all-time). */
  pendingGrades: number
}

/** Request to start a Usage page record store from a clean slate. */
export interface LocalUsageClearInput {
  /** Store to clear, or `all` for every store the Usage page reads. */
  store: LocalUsageRecordStore | 'all'
  /** Range whose ledger rows are removed. The ranking store ignores it. */
  range: LocalProfileAnalyticsRange
}

/**
 * What a manual ranking grade run covers.
 *
 * `due` grades only conversations whose inactivity window already closed, which
 * is exactly what the automatic drain is about to take. `all` grades every
 * conversation still waiting, pulling it forward, and gives a conversation
 * parked after exhausting its retries one fresh attempt.
 */
export type LocalRankingGradeScope = 'due' | 'all'

/** Progress of a manual ranking grade run, and the queue it is working through. */
export interface LocalRankingQueueStatus {
  /** Every conversation still waiting for a grade, including parked failures. */
  awaiting: number
  /** Conversations whose inactivity window has closed, so the next pass takes them. */
  due: number
  /** Conversations parked after exhausting their retry budget. */
  failed: number
  /** The judge a manual run would use, and whether that judge can run at all. */
  judge: LocalRankingJudgeView
  /** The run in flight, or null when the queue is idle. */
  run: LocalRankingGradeProgress | null
}

/** The judge a manual run would use, resolved for display. */
export interface LocalRankingJudgeView {
  /** Pinned judge kind, or `automatic` when the chain decides. */
  kind: RankingJudgeKind
  /** One line naming the judge, e.g. `TypeSafe (Jev)` or `pi · openai/gpt-5`. */
  label: string
}

/** Live counters of one manual ranking grade run. */
export interface LocalRankingGradeProgress {
  /** Conversations the run set out to grade. */
  requested: number
  /** Conversations graded and folded into the aggregates so far. */
  graded: number
  /** Conversations the judge could not score, left queued for a later attempt. */
  failed: number
  /** Conversations still awaiting a grade. */
  remaining: number
  /** True once the user cancelled the run; the current pass still finished. */
  cancelled: boolean
}

/** Date-range usage row with enough identity to render harness and provider marks. */
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
  /** Harness/provider/model/thinking-level 0–10 ranking aggregates (all-time, not period-scoped). */
  modelRankings: LocalProfileModelRanking[]
  /** All-time priced cost of every ranked session folded into the aggregates. */
  gradingSpend: LocalProfileGradingSpend
  /** Current size of each clearable record store behind this page. */
  records: LocalUsageRecordCounts
  generatedAt: number
}

/** Shot category of one ranked conversation window. */
export type RankingShotCategory = 'first_shot' | 'multi_shot'

/** Queue processing state of a ranking snapshot (workflow state, not quality). */
export type RankingSnapshotStatus = 'pending' | 'processing' | 'scored' | 'failed'

/** One persisted ranking snapshot row (transient grading queue entry). */
export interface ModelRankingSnapshotRow {
  id: string
  /** Null after the owning thread is deleted (ON DELETE SET NULL). */
  thread_id: string | null
  project_id: string
  shot_category: RankingShotCategory
  status: RankingSnapshotStatus
  harness_id: string
  provider_id: string
  model_id: string
  thinking_level: string
  started_at: number
  ended_at: number
  /** Set when the conversation window closed; null while follow-ups may land. */
  closed_at_ms: number | null
  due_at_ms: number
  user_message_text: string
  assistant_output_text: string
  follow_up_text: string | null
  /** Visible user message this window currently answers; null on legacy rows. */
  anchor_message_id: string | null
  cost_usd: number | null
  cost_status: 'known' | 'estimated' | 'unavailable' | null
  attempt_count: number
  last_attempt_at_ms: number | null
  /** Unique tag of the current drain claim; NULL while not claimed. */
  claim_token: string | null
  created_at: number
}

/** One persisted model-ranking aggregate row (permanent analytics record). */
export interface ModelRankingRow {
  id: string
  harness_id: string
  provider_id: string
  model_id: string
  thinking_level: string
  one_shot_score_sum: number
  one_shot_samples: number
  one_shot_duration_sum_ms: number
  one_shot_cost_usd: number
  multi_shot_score_sum: number
  multi_shot_samples: number
  multi_shot_duration_sum_ms: number
  multi_shot_cost_usd: number
  rubric_version: string
  calc_version: string
  updated_at: number
}

/** Per-shot-category ranking statistics; averages are always sum ÷ count. */
export interface LocalProfileRankingModeStats {
  /** Average judge score on the 0–10 rubric, or null before the first sample. */
  averageScore: number | null
  samples: number
  /** Average agent window duration in milliseconds, or null before the first sample. */
  averageDurationMs: number | null
  /** Sum of priced session cost in USD for this category. */
  costUsd: number
}

/** Aggregated LLM-judge ranking for one (harness, provider, model, thinking level). */
export interface LocalProfileModelRanking {
  harnessId: string
  providerId: string
  modelId: string
  thinkingLevel: ThinkingLevel | null
  /** Rubric that produced these sums; migrated legacy data carries a legacy tag. */
  rubricVersion: string
  oneShot: LocalProfileRankingModeStats
  multiShot: LocalProfileRankingModeStats
  updatedAt: number
}

/** All-time priced cost of the ranked sessions (aggregate is not period-scoped). */
export interface LocalProfileGradingSpend {
  costUsd: number
}
