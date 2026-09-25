import type {
  LocalProfileAnalyticsRange,
  LocalUsageRecordCounts,
  LocalUsageRecordStore
} from '$shared/types'
import { formatDateRange, formatLongDate, formatNumber } from './profile-settings-format'

/**
 * A clear action target: one record store, or every store the Usage page reads.
 *
 * The stores follow the persisted records rather than the page's panels. The
 * activity calendar, models, harnesses, providers, thinking levels, projects,
 * daily and hourly charts are all aggregates over the same usage ledger rows,
 * so a per-panel button would silently empty its neighbours.
 */
export type UsageClearTarget = LocalUsageRecordStore | 'all'

/** Presentation of one clear target: its name and what it covers. */
export interface UsageClearTargetInfo {
  /** Button and dialog title for the action. */
  label: string
  /** One line explaining the records this target owns. */
  description: string
}

export const USAGE_RECORD_STORES: readonly LocalUsageRecordStore[] = [
  'agentResponses',
  'utilities',
  'modelRankings'
]

const STORE_INFO: Record<LocalUsageRecordStore, UsageClearTargetInfo> = {
  agentResponses: {
    label: 'Agent responses',
    description: 'Every agent turn with its tokens, cost and runtime in the selected range.'
  },
  utilities: {
    label: 'Utilities',
    description: 'Image descriptor, memory and title generation calls in the selected range.'
  },
  modelRankings: {
    label: 'Model rankings',
    description: 'Graded one-shot and multi-shot results, and any conversation still to be graded.'
  }
}

const ALL_INFO: UsageClearTargetInfo = {
  label: 'All usage records',
  description: 'Every store listed here, cleared in one action.'
}

/** One run of confirmation copy. `emphasis` marks the parts worth highlighting. */
export interface UsageClearCopyPart {
  text: string
  emphasis: boolean
}

/** Confirmation copy for one clear action, split so markup carries no wording. */
export interface UsageClearConfirmation {
  title: string
  confirmLabel: string
  /** Sentence stating the clean slate's scope, including its exact dates. */
  scope: UsageClearCopyPart[]
  /** Sentence stating what is removed, in detail. */
  removal: UsageClearCopyPart[]
  /** Irreversibility line shown under the body. */
  note: string
}

export function usageClearInfo(target: UsageClearTarget): UsageClearTargetInfo {
  return target === 'all' ? ALL_INFO : STORE_INFO[target]
}

/** Records a clear action removes, counting queued conversations as records. */
export function usageClearRecordCount(
  target: UsageClearTarget,
  counts: LocalUsageRecordCounts
): number {
  switch (target) {
    case 'agentResponses':
      return counts.agentResponses
    case 'utilities':
      return counts.utilities
    case 'modelRankings':
      return counts.modelRankings + counts.pendingGrades
    case 'all':
      return counts.agentResponses + counts.utilities + counts.modelRankings + counts.pendingGrades
  }
}

/** Summary line under a store's name in the records panel. */
export function usageRecordSummary(
  store: LocalUsageRecordStore,
  counts: LocalUsageRecordCounts,
  range: LocalProfileAnalyticsRange
): string {
  if (store === 'agentResponses') {
    return `${recordClause(counts.agentResponses, 'record', 'records')} · ${formatDateRange(range)}`
  }
  if (store === 'utilities') {
    return `${recordClause(counts.utilities, 'record', 'records')} · ${formatDateRange(range)}`
  }
  return [
    recordClause(counts.modelRankings, 'ranked configuration', 'ranked configurations'),
    recordClause(
      counts.pendingGrades,
      'conversation awaiting grading',
      'conversations awaiting grading'
    ),
    'all time'
  ].join(' · ')
}

/**
 * Build the confirmation shown before a clear runs.
 *
 * The copy names the exact dates for range-scoped stores and says plainly that
 * the ranking store is all-time, so the promise a user confirms always matches
 * what the purge actually removes.
 */
export function usageClearConfirmation(
  target: UsageClearTarget,
  counts: LocalUsageRecordCounts,
  range: LocalProfileAnalyticsRange
): UsageClearConfirmation {
  return {
    title: `Clear ${usageClearInfo(target).label.toLowerCase()}`,
    confirmLabel: target === 'all' ? 'Clear all records' : 'Clear records',
    scope: scopeParts(target, range),
    removal: removalParts(target, counts),
    note: noteFor(target)
  }
}

/**
 * Irreversibility line. The ranking stores additionally warn that discarding the
 * grading queue means those conversations can never be scored, which a user
 * cannot infer from a record count alone.
 */
function noteFor(target: UsageClearTarget): string {
  const ledgerNote =
    'Clearing usage records cannot be undone, and removes them from this device only.'
  const rankingNote =
    'Conversations awaiting grading are discarded with the ranking records, so they are never scored.'
  if (target === 'modelRankings') return `Clearing ranking records cannot be undone. ${rankingNote}`
  if (target === 'all') return `${ledgerNote} ${rankingNote}`
  return ledgerNote
}

function scopeParts(
  target: UsageClearTarget,
  range: LocalProfileAnalyticsRange
): UsageClearCopyPart[] {
  if (target === 'modelRankings') {
    return [
      quoted('You are about to start from a clean slate for '),
      emphasised(STORE_INFO.modelRankings.label),
      quoted(', which are kept all time and carry no dates.')
    ]
  }
  const windowParts = rangeParts(range)
  if (target === 'all') {
    return [
      quoted('You are about to start from a clean slate from '),
      ...windowParts,
      quoted(' for '),
      emphasised(STORE_INFO.agentResponses.label),
      quoted(' and '),
      emphasised(STORE_INFO.utilities.label),
      quoted(', and all time for '),
      emphasised(STORE_INFO.modelRankings.label),
      quoted('.')
    ]
  }
  return [
    quoted('You are about to start from a clean slate from '),
    ...windowParts,
    quoted(' for '),
    emphasised(usageClearInfo(target).label),
    quoted('.')
  ]
}

/** The "from A to B" run, shared so every range-scoped dialog reads identically. */
function rangeParts(range: LocalProfileAnalyticsRange): UsageClearCopyPart[] {
  return [
    emphasised(formatLongDate(range.startAt)),
    quoted(' to '),
    emphasised(formatLongDate(range.endAt - 1))
  ]
}

function removalParts(
  target: UsageClearTarget,
  counts: LocalUsageRecordCounts
): UsageClearCopyPart[] {
  return [
    quoted('This removes '),
    emphasised(joinClauses(removalClauses(target, counts))),
    quoted(' from this device.')
  ]
}

/** Plain list of what a clear removed, for the notice shown after it runs. */
export function clearedRecordsSummary(
  target: UsageClearTarget,
  cleared: LocalUsageRecordCounts
): string {
  return joinClauses(removalClauses(target, cleared))
}

/** The per-store clauses a clear covers, in the order the stores are listed. */
function removalClauses(target: UsageClearTarget, counts: LocalUsageRecordCounts): string[] {
  const clauses: string[] = []
  if (target === 'all' || target === 'agentResponses') {
    clauses.push(
      recordClause(counts.agentResponses, 'agent response record', 'agent response records')
    )
  }
  if (target === 'all' || target === 'utilities') {
    clauses.push(recordClause(counts.utilities, 'utility record', 'utility records'))
  }
  if (target === 'all' || target === 'modelRankings') {
    clauses.push(
      recordClause(counts.modelRankings, 'ranked configuration', 'ranked configurations')
    )
    clauses.push(
      recordClause(
        counts.pendingGrades,
        'conversation awaiting grading',
        'conversations awaiting grading'
      )
    )
  }
  return clauses
}

/**
 * One counted clause. Both forms are explicit because appending an `s` mangles
 * multi-word nouns (`conversations awaiting gradings`).
 */
function recordClause(count: number, singular: string, plural: string): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`
}

function joinClauses(clauses: readonly string[]): string {
  if (clauses.length <= 1) return clauses[0] ?? 'no records'
  const head = clauses.slice(0, -1).join(', ')
  return `${head} and ${clauses[clauses.length - 1] ?? ''}`
}

function quoted(text: string): UsageClearCopyPart {
  return { text, emphasis: false }
}

function emphasised(text: string): UsageClearCopyPart {
  return { text, emphasis: true }
}
