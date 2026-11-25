import type { AuthoredWorkKind } from '../../../../lib/ipc/design'
import {
  isAuthoredWorkKind,
  orderAuthoredWorkKinds,
  parseAuthoredWorkKinds
} from '../../../../lib/design/authored-work-kinds'
import {
  sanitizeThreadSettings,
  type AgentRateLimitWindow,
  type AgentTokenUsage,
  type Thread,
  type ThreadContextUsage,
  type ThreadSettings,
  type ThreadStatus,
  type ThreadTitleSource
} from '../../../../lib/types'

/** One `threads` row exactly as SQLite returns it. */
export interface ThreadRow {
  id: string
  project_id: string
  provider_id: string
  title: string
  title_source: string
  status: string
  pinned: number
  pinned_at: number | null
  bookmarked: number
  sort_order: number | null
  scope_sort_order: number | null
  archived: number
  read: number
  branch: string | null
  feature_slug: string | null
  authored_work_kind: string | null
  authored_work_kinds: string | null
  scope_bucket_id: string | null
  bound_scope_project_id: string | null
  bound_scope_scope_id: string | null
  bound_scope_home_project_id: string | null
  run_base: string | null
  dispatch_origin: string | null
  park_reason: string | null
  settings: string | null
  context_usage: string | null
  session_id: string | null
  session_harness_id: string | null
  session_account_id: string | null
  dismissed_spec_id: string | null
  dismissed_spec_version: number | null
  audit_state: string | null
  loop_iteration: number | null
  active_audit_id: string | null
  active_audit_version: number | null
  assignment_id: string | null
  assignment_role: string | null
  assignment_task_id: string | null
  coordinator_thread_id: string | null
  achievement_role: string | null
  achievement_goal: string | null
  auditor_thread_id: string | null
  user_input_locked: number
  engineering: number
  independent_audit: number
  independent_audit_initialized: number
  assistant_id: string | null
  assistant_icon_type: string | null
  assistant_icon: string | null
  schedule_override: string | null
  scheduled: number | null
  last_run_at: number | null
  last_dispatched_at: number | null
  last_success_at: number | null
  assistant_getting_started: number
  assistant_task_id: string | null
  group_participants: string | null
  group_title: string | null
  last_error: string | null
  last_error_at: number | null
  last_outcome: string | null
  drafting: number
  draft_json: string | null
  created_at: number
  updated_at: number
  last_activity: number
  working_directory: string
}

/** Safe JSON read for optional blob columns   a corrupt row must not break a thread list. */
function parseStoredJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * The assistant ids taking part in a group thread.
 *
 * A corrupt or hand-edited row must never break a thread list, so a value that
 * is not a list of non-empty strings reads as no participants at all, which is
 * exactly the ordinary single-speaker thread.
 */
function parseGroupParticipants(raw: string): string[] {
  const parsed = parseStoredJson(raw)
  if (!Array.isArray(parsed)) return []
  return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

/** Store a group thread's participants, or nothing when it is not a group. */
export function serializeGroupParticipants(participants: string[] | undefined): string | null {
  return participants && participants.length > 0 ? JSON.stringify(participants) : null
}

/**
 * Validate a raw context-usage snapshot with integrity checks so a corrupt or
 * corrupt blob can never crash a thread list or render a bogus meter. Returns
 * null when the shape is unusable.
 */
export function parseThreadContextUsage(value: unknown): ThreadContextUsage | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.harnessId !== 'string' || typeof record.providerId !== 'string') return null
  if (typeof record.costUsd !== 'number') return null
  const contextUsed = typeof record.contextUsed === 'number' ? record.contextUsed : undefined
  const contextEstimated = record.contextEstimated === true
  const tokenRecord = record.tokens
  if (tokenRecord !== undefined && (!tokenRecord || typeof tokenRecord !== 'object')) return null
  const tokenFields: Array<keyof AgentTokenUsage> = [
    'input',
    'output',
    'reasoning',
    'cacheRead',
    'cacheWrite',
    'total'
  ]
  const tokens = tokenRecord as Record<string, unknown> | undefined
  if (tokens) {
    for (const field of tokenFields) {
      if (typeof tokens[field] !== 'number') return null
    }
  }
  const rateLimits = Array.isArray(record.rateLimits)
    ? (record.rateLimits as AgentRateLimitWindow[])
    : []
  const creditsRecord = record.credits
  const credits =
    creditsRecord && typeof creditsRecord === 'object'
      ? (() => {
          const raw = creditsRecord as Record<string, unknown>
          return {
            ...(typeof raw.balance === 'number' ? { balance: raw.balance } : {}),
            ...(typeof raw.hasCredits === 'boolean' ? { hasCredits: raw.hasCredits } : {}),
            ...(typeof raw.unlimited === 'boolean' ? { unlimited: raw.unlimited } : {}),
            ...(typeof raw.planType === 'string' ? { planType: raw.planType } : {})
          }
        })()
      : undefined
  return {
    harnessId: record.harnessId,
    providerId: record.providerId,
    ...(contextUsed === undefined ? {} : { contextUsed }),
    ...(contextEstimated ? { contextEstimated: true } : {}),
    contextPercent: typeof record.contextPercent === 'number' ? record.contextPercent : undefined,
    contextWindow: typeof record.contextWindow === 'number' ? record.contextWindow : undefined,
    costUsd: record.costUsd,
    ...(tokens ? { tokens: tokens as unknown as AgentTokenUsage } : {}),
    rateLimits,
    ...(credits && Object.keys(credits).length > 0 ? { credits } : {})
  }
}

/**
 * The authored-work kinds a row carries, or undefined when it has done none.
 *
 * The durable set is the answer, and the session kind is merged in because it is
 * the one fact every write path is guaranteed to keep current. A row written
 * before the set existed, or by a path that recorded only the session, still
 * draws its marker instead of an empty row. Unknown values are dropped rather
 * than trusted, so a hand-edited column cannot conjure a glyph.
 */
function authoredWorkKindsFromRow(row: ThreadRow): AuthoredWorkKind[] | undefined {
  const kinds = orderAuthoredWorkKinds([
    ...parseAuthoredWorkKinds(row.authored_work_kinds),
    row.authored_work_kind
  ])
  return kinds.length > 0 ? kinds : undefined
}

/**
 * The bound scope a row carries, reconstructed from its columns.
 *
 * Project and scope together or nothing: a half-written pair cannot name a
 * scope, and reading one would resolve a checkout nobody chose. The home
 * container is optional, so an unbind still knows where the thread came from.
 */
function threadBoundScopeFromRow(row: ThreadRow): Thread['boundScope'] {
  if (!row.bound_scope_project_id || !row.bound_scope_scope_id) return undefined
  return {
    projectId: row.bound_scope_project_id,
    scopeBucketId: row.bound_scope_scope_id,
    ...(row.bound_scope_home_project_id ? { homeProjectId: row.bound_scope_home_project_id } : {})
  }
}

/** A run's recorded base, parsed defensively: a corrupt value means no base. */
function threadRunBaseFromRow(row: ThreadRow): Thread['runBase'] {
  if (!row.run_base) return undefined
  const parsed = parseStoredJson(row.run_base)
  if (!parsed || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  if (
    typeof record['sha'] !== 'string' ||
    typeof record['projectId'] !== 'string' ||
    typeof record['scopeBucketId'] !== 'string' ||
    typeof record['recordedAt'] !== 'number'
  ) {
    return undefined
  }
  return {
    sha: record['sha'],
    projectId: record['projectId'],
    scopeBucketId: record['scopeBucketId'],
    recordedAt: record['recordedAt']
  }
}

/** A park reason, parsed defensively so a corrupt row renders no guidance. */
function threadParkReasonFromRow(row: ThreadRow): Thread['parkReason'] {
  if (!row.park_reason) return undefined
  const parsed = parseStoredJson(row.park_reason)
  if (!parsed || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  if (
    typeof record['category'] !== 'string' ||
    typeof record['message'] !== 'string' ||
    typeof record['projectId'] !== 'string' ||
    typeof record['scopeBucketId'] !== 'string'
  ) {
    return undefined
  }
  return {
    category: record['category'] as NonNullable<Thread['parkReason']>['category'],
    message: record['message'],
    projectId: record['projectId'],
    scopeBucketId: record['scopeBucketId']
  }
}

/** A dispatch origin, parsed defensively so a corrupt row renders no badge. */
function threadDispatchOriginFromRow(row: ThreadRow): Thread['dispatchOrigin'] {
  if (!row.dispatch_origin) return undefined
  const parsed = parseStoredJson(row.dispatch_origin)
  if (!parsed || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  if (
    typeof record['initiatorProjectId'] !== 'string' ||
    typeof record['initiatorThreadId'] !== 'string' ||
    typeof record['at'] !== 'number'
  ) {
    return undefined
  }
  return {
    initiatorProjectId: record['initiatorProjectId'],
    initiatorThreadId: record['initiatorThreadId'],
    at: record['at'],
    ...(typeof record['assistantId'] === 'string' ? { assistantId: record['assistantId'] } : {}),
    ...(typeof record['assistantName'] === 'string'
      ? { assistantName: record['assistantName'] }
      : {})
  }
}

/** Parse a raw thread row into a display-facing Thread. */
export function rowToThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    projectId: row.project_id,
    providerId: row.provider_id,
    title: row.title,
    titleSource: (row.title_source || 'default') as ThreadTitleSource,
    status: row.status as ThreadStatus,
    pinned: row.pinned === 1,
    bookmarked: row.bookmarked === 1,
    pinnedAt: row.pinned_at ?? undefined,
    sortOrder: row.sort_order ?? undefined,
    scopeSortOrder: row.scope_sort_order ?? undefined,
    archived: row.archived === 1,
    read: row.read === 1,
    branch: row.branch ?? undefined,
    featureSlug: row.feature_slug ?? undefined,
    authoredWorkKind: isAuthoredWorkKind(row.authored_work_kind)
      ? row.authored_work_kind
      : undefined,
    authoredWorkKinds: authoredWorkKindsFromRow(row),
    scopeBucketId: row.scope_bucket_id ?? undefined,
    boundScope: threadBoundScopeFromRow(row),
    runBase: threadRunBaseFromRow(row),
    dispatchOrigin: threadDispatchOriginFromRow(row),
    parkReason: threadParkReasonFromRow(row),
    settings: row.settings
      ? (sanitizeThreadSettings(JSON.parse(row.settings)) as ThreadSettings)
      : undefined,
    contextUsage: row.context_usage
      ? (parseThreadContextUsage(parseStoredJson(row.context_usage)) ?? undefined)
      : undefined,
    sessionId: row.session_id ?? undefined,
    sessionHarnessId: row.session_harness_id ?? undefined,
    sessionAccountId: row.session_account_id ?? undefined,
    dismissedSpecId: row.dismissed_spec_id ?? undefined,
    dismissedSpecVersion: row.dismissed_spec_version ?? undefined,
    // Legacy independent audits persisted the active report pointer without
    // an audit state, stranding the review surface (no Review/Complete
    // buttons, no severity badges, no next verification pass). Every current
    // writer keeps the pointer and the state in lockstep — clearing one
    // clears both — so a pointer without a state can only be a legacy report
    // awaiting review.
    auditState:
      (row.audit_state as Thread['auditState']) ??
      (row.active_audit_id !== null ? 'report_ready' : undefined),
    loopIteration: row.loop_iteration ?? undefined,
    activeAuditId: row.active_audit_id ?? undefined,
    activeAuditVersion: row.active_audit_version ?? undefined,
    assignmentId: row.assignment_id ?? undefined,
    assignmentRole: (row.assignment_role as Thread['assignmentRole']) ?? undefined,
    assignmentTaskId: row.assignment_task_id ?? undefined,
    coordinatorThreadId: row.coordinator_thread_id ?? undefined,
    achievementRole: (row.achievement_role as Thread['achievementRole']) ?? undefined,
    ...(row.achievement_goal !== null ? { achievementGoal: row.achievement_goal } : {}),
    auditorThreadId: row.auditor_thread_id ?? undefined,
    userInputLocked: row.user_input_locked === 1,
    engineering: row.engineering === 1,
    independentAudit: row.independent_audit === 1,
    independentAuditInitialized: row.independent_audit_initialized === 1,
    assistantId: row.assistant_id ?? undefined,
    assistantIconType: row.assistant_icon_type ?? undefined,
    assistantIcon: row.assistant_icon ?? undefined,
    scheduleOverride: row.schedule_override
      ? ((parseStoredJson(row.schedule_override) as Thread['scheduleOverride']) ?? undefined)
      : undefined,
    scheduled: row.scheduled === null ? undefined : row.scheduled === 1,
    lastRunAt: row.last_run_at ?? undefined,
    lastDispatchedAt: row.last_dispatched_at ?? undefined,
    lastSuccessAt: row.last_success_at ?? undefined,
    ...(row.assistant_getting_started === 1 ? { assistantGettingStarted: true } : {}),
    ...(row.assistant_task_id !== null ? { assistantTaskId: row.assistant_task_id } : {}),
    ...(row.group_participants !== null
      ? { groupParticipants: parseGroupParticipants(row.group_participants) }
      : {}),
    ...(row.group_title !== null ? { groupTitle: row.group_title } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    ...(row.last_error_at !== null ? { lastErrorAt: row.last_error_at } : {}),
    ...(row.last_outcome !== null
      ? { lastOutcome: row.last_outcome as Thread['lastOutcome'] }
      : {}),
    ...(row.drafting === 1 ? { drafting: true } : {}),
    ...(row.draft_json !== null ? { draftJson: row.draft_json } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivity: row.last_activity,
    workingDirectory: row.working_directory
  }
}
