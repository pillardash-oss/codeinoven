/**
 * Reads a custom provider's usage route body into quota windows.
 *
 * Providers backed by a subscription answer their status route with very
 * different JSON, so this module is a small adapter registry:
 *
 * - `auto` (the default) walks whatever the body contains and maps every
 *   object that looks like a quota, tolerating snake_case keys, 0..1 ratios,
 *   raw amount/limit pairs, several reset-time spellings, and duration fields.
 * - The named formats (`command-code`, `zai`, `kimi`, ...) know the exact
 *   envelope one provider family returns.
 *
 * A named format that recognizes nothing falls back to `auto`, so a wrong pick
 * degrades to a best-effort read instead of showing no bars. A body that parses
 * to nothing yields `null`.
 */
import type {
  AgentRateLimitWindow,
  AgentUsageCredits,
  BaseUrlProviderUsageFormat
} from '../../lib/types'

const MAX_WINDOWS = 16
const MAX_DEPTH = 7
const MAX_CANDIDATES = MAX_WINDOWS * 6

export interface ParsedProviderUsage {
  rateLimits: AgentRateLimitWindow[]
  credits?: AgentUsageCredits
}

// ─── Value readers ───────────────────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Numbers arrive as JSON numbers or decimal strings (`"12.34"`). */
function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function pickNumber(entry: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = num(entry[key])
    if (value !== undefined) return value
  }
  return undefined
}

function pickString(entry: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = entry[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

/**
 * A timestamp written as epoch seconds, epoch milliseconds, or an ISO string.
 * Values too small to be a real timestamp (under 2001) are rejected rather than
 * mistaken for a duration.
 */
function epochMs(value: unknown): number | undefined {
  const numeric = num(value)
  if (numeric !== undefined) {
    if (numeric > 1e12) return numeric
    if (numeric > 1e9) return numeric * 1000
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function pickEpoch(entry: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = epochMs(entry[key])
    if (value !== undefined) return value
  }
  return undefined
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function titleCase(value: string): string {
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replaceAll(/[_-]/gu, ' ')
    .trim()
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : 'Quota'
}

/** Plan/tier ids arrive shouted (`LEVEL_INTERMEDIATE`, `INDIVIDUAL_GO`). */
function humanizePlan(value: string): string {
  return value
    .replace(/^LEVEL_/iu, '')
    .split(/[\s_-]+/u)
    .filter(Boolean)
    .map(
      (word) => word.charAt(0).toLocaleUpperCase('en-US') + word.slice(1).toLocaleLowerCase('en-US')
    )
    .join(' ')
}

const USED_KEYS = [
  'used',
  'current',
  'usage',
  'consumed',
  'usedCredits',
  'used_credits',
  'usedQuota',
  'used_quota',
  'currentValue',
  'current_value'
] as const
const LIMIT_KEYS = [
  'limit',
  'quota',
  'total',
  'max',
  'cap',
  'allowance',
  'limitCredits',
  'limit_credits',
  'totalCredits',
  'total_credits'
] as const
const REMAINING_KEYS = [
  'remaining',
  'left',
  'available',
  'remainingCredits',
  'remaining_credits',
  'remainingQuota',
  'remaining_quota',
  'availableCredits',
  'available_credits'
] as const
const PERCENT_KEYS = [
  'usedPercent',
  'used_percent',
  'usagePercent',
  'usage_percent',
  'percent',
  'percentage'
] as const
const RATIO_KEYS = ['utilization', 'usedRatio', 'used_ratio', 'ratio'] as const
const RESET_KEYS = [
  'resetsAt',
  'resets_at',
  'resetAt',
  'reset_at',
  'resetTime',
  'reset_time',
  'nextResetTime',
  'next_reset_time',
  'expiresAt',
  'expires_at',
  'expires'
] as const
const LABEL_KEYS = [
  'label',
  'name',
  'title',
  'policyId',
  'policy_id',
  'resource',
  'type',
  'key'
] as const

/** A used percentage from either a 0..100 field or a 0..1 utilization field. */
function percentFrom(entry: Record<string, unknown>): number | undefined {
  const direct = pickNumber(entry, PERCENT_KEYS)
  if (direct !== undefined) return clampPercent(direct)
  const ratio = pickNumber(entry, RATIO_KEYS)
  if (ratio !== undefined) return clampPercent(ratio <= 1 ? ratio * 100 : ratio)
  return undefined
}

const TIME_UNIT_MINUTES: Readonly<Record<string, number>> = {
  second: 1 / 60,
  seconds: 1 / 60,
  minute: 1,
  minutes: 1,
  hour: 60,
  hours: 60,
  day: 1440,
  days: 1440,
  week: 10080,
  weeks: 10080
}

function unitToMinutes(unit: string): number | undefined {
  const normalized = unit
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/^time_unit_/u, '')
  return TIME_UNIT_MINUTES[normalized]
}

/** Rolling-window length in minutes from the many spellings providers use. */
function windowMinutesFrom(entry: Record<string, unknown>): number | undefined {
  const minutes = pickNumber(entry, ['windowMinutes', 'window_minutes'])
  if (minutes !== undefined) return minutes
  const seconds = pickNumber(entry, [
    'windowSeconds',
    'window_seconds',
    'durationSeconds',
    'duration_seconds'
  ])
  if (seconds !== undefined) return seconds / 60
  const millis = pickNumber(entry, [
    'periodDurationMs',
    'period_duration_ms',
    'durationMs',
    'duration_ms'
  ])
  if (millis !== undefined) return millis / 60_000
  const window = record(entry['window'])
  if (window) {
    const duration = num(window['duration'])
    const unit = pickString(window, ['timeUnit', 'time_unit'])
    if (duration !== undefined && unit) {
      const factor = unitToMinutes(unit)
      if (factor !== undefined) return duration * factor
    }
  }
  return undefined
}

interface QuotaCandidate {
  label: string
  used?: number
  limit?: number
  remaining?: number
  usedPercent?: number
  resetsAt?: number
  windowMinutes?: number
  status?: string
}

/** Pull a quota out of one arbitrary object, tolerating many key spellings. */
function quotaFromObject(entry: Record<string, unknown>, label: string): QuotaCandidate | null {
  const used = pickNumber(entry, USED_KEYS)
  const limit = pickNumber(entry, LIMIT_KEYS)
  const remaining = pickNumber(entry, REMAINING_KEYS)
  const usedPercent = percentFrom(entry)
  if (
    used === undefined &&
    limit === undefined &&
    remaining === undefined &&
    usedPercent === undefined
  ) {
    return null
  }
  const resetsAt = pickEpoch(entry, RESET_KEYS)
  const windowMinutes = windowMinutesFrom(entry)
  const status = pickString(entry, ['status', 'state'])
  return {
    label,
    ...(used === undefined ? {} : { used }),
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...(status === undefined ? {} : { status })
  }
}

function labelFor(entry: Record<string, unknown>, path: string): string {
  const named = pickString(entry, LABEL_KEYS)
  if (named) return titleCase(named)
  const last = path.split('/').filter(Boolean).pop()
  return titleCase(last ?? 'Quota')
}

/** Recursively walk a JSON body and collect every object that looks like a quota. */
function collectQuotas(value: unknown, path: string, depth: number, out: QuotaCandidate[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_CANDIDATES) return
  const entry = record(value)
  if (entry) {
    const candidate = quotaFromObject(entry, labelFor(entry, path))
    if (candidate) {
      out.push(candidate)
      return
    }
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectQuotas(item, `${path}/${index}`, depth + 1, out))
    return
  }
  if (!entry) return
  for (const [key, child] of Object.entries(entry)) {
    if (record(child) || Array.isArray(child)) {
      collectQuotas(child, `${path}/${key}`, depth + 1, out)
    }
  }
}

/**
 * Credits can sit at the top level (`balance`, `balanceUsd`), inside a
 * `credits`/`balances` object, or beside the windows. The first recognizable
 * balance wins, preferring shallower objects.
 */
function collectCredits(value: unknown, depth: number, out: { credits?: AgentUsageCredits }): void {
  if (depth > MAX_DEPTH || out.credits) return
  const entry = record(value)
  if (entry) {
    const credits = creditsFromObject(entry)
    if (credits) {
      out.credits = credits
      return
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCredits(item, depth + 1, out)
    return
  }
  if (!entry) return
  for (const child of Object.values(entry)) {
    if (record(child) || Array.isArray(child)) collectCredits(child, depth + 1, out)
  }
}

const BALANCE_KEYS = [
  'balance',
  'credit',
  'credits',
  'balanceUsd',
  'balance_usd',
  'availableCredits',
  'available_credits',
  'totalAvailableCredits',
  'total_available_credits'
] as const
const PLAN_KEYS = [
  'planType',
  'plan_type',
  'plan',
  'tier',
  'membershipTier',
  'membership_tier',
  'level'
] as const

function creditsFromObject(entry: Record<string, unknown>): AgentUsageCredits | undefined {
  const balance = pickNumber(entry, BALANCE_KEYS)
  const unlimited = entry['unlimited'] === true ? true : undefined
  const planType = pickString(entry, PLAN_KEYS)
  if (balance === undefined && unlimited === undefined && planType === undefined) return undefined
  return {
    hasCredits: true,
    ...(balance === undefined ? {} : { balance }),
    ...(unlimited === undefined ? {} : { unlimited }),
    ...(planType === undefined ? {} : { planType })
  }
}

// ─── Window assembly ─────────────────────────────────────────────────────────

function toWindow(candidate: QuotaCandidate, index: number): AgentRateLimitWindow | null {
  let usedPercent = candidate.usedPercent
  if (
    usedPercent === undefined &&
    candidate.used !== undefined &&
    candidate.limit !== undefined &&
    candidate.limit > 0
  ) {
    usedPercent = (candidate.used / candidate.limit) * 100
  }
  if (
    usedPercent === undefined &&
    candidate.remaining !== undefined &&
    candidate.limit !== undefined &&
    candidate.limit > 0
  ) {
    usedPercent = ((candidate.limit - candidate.remaining) / candidate.limit) * 100
  }
  if (
    usedPercent === undefined &&
    candidate.remaining === undefined &&
    candidate.limit === undefined
  ) {
    return null
  }
  return {
    id: `custom:${index}`,
    label: candidate.label,
    ...(candidate.status === undefined ? {} : { status: candidate.status }),
    ...(usedPercent === undefined ? {} : { usedPercent: clampPercent(usedPercent) }),
    ...(candidate.remaining === undefined ? {} : { remaining: candidate.remaining }),
    ...(candidate.limit === undefined ? {} : { limit: candidate.limit }),
    ...(candidate.resetsAt === undefined ? {} : { resetsAt: candidate.resetsAt }),
    ...(candidate.windowMinutes === undefined ? {} : { windowMinutes: candidate.windowMinutes })
  }
}

function assemble(candidates: readonly QuotaCandidate[], index: number): AgentRateLimitWindow[] {
  const windows: AgentRateLimitWindow[] = []
  for (const candidate of candidates) {
    if (windows.length >= MAX_WINDOWS) break
    const mapped = toWindow(candidate, index + windows.length)
    if (mapped) windows.push(mapped)
  }
  return windows
}

// ─── Generic parser ──────────────────────────────────────────────────────────

function parseGeneric(body: unknown): ParsedProviderUsage {
  const candidates: QuotaCandidate[] = []
  collectQuotas(body, '', 0, candidates)
  const credits: { credits?: AgentUsageCredits } = {}
  collectCredits(body, 0, credits)
  return {
    rateLimits: assemble(candidates, 0),
    ...(credits.credits ? { credits: credits.credits } : {})
  }
}

// ─── Depth-bounded key lookup for adapter envelopes ──────────────────────────

/** Find the first object stored under `key` anywhere in the body (bounded). */
function findObject(
  body: unknown,
  keys: readonly string[],
  maxDepth = 4
): Record<string, unknown> | null {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: body, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || current.depth > maxDepth) continue
    const entry = record(current.value)
    if (!entry) {
      if (Array.isArray(current.value)) {
        for (const item of current.value) queue.push({ value: item, depth: current.depth + 1 })
      }
      continue
    }
    for (const key of keys) {
      const child = record(entry[key])
      if (child) return child
    }
    for (const child of Object.values(entry)) {
      if (record(child) || Array.isArray(child)) {
        queue.push({ value: child, depth: current.depth + 1 })
      }
    }
  }
  return null
}

// ─── Named adapters ──────────────────────────────────────────────────────────

function windowFromPair(
  label: string,
  entry: Record<string, unknown> | null,
  windowMinutes: number
): QuotaCandidate | null {
  if (!entry) return null
  const candidate = quotaFromObject(entry, label)
  if (!candidate) return null
  return { ...candidate, label, windowMinutes: candidate.windowMinutes ?? windowMinutes }
}

/** Command Code: `windowLimits.fiveHour` / `windowLimits.weekly` (`cap`, `resetAt`). */
function parseCommandCode(body: unknown): ParsedProviderUsage | null {
  const limits = findObject(body, ['windowLimits', 'window_limits'])
  if (!limits) return null
  const candidates: QuotaCandidate[] = []
  const fiveHour = windowFromPair(
    '5-hour session',
    record(limits['fiveHour'] ?? limits['five_hour'] ?? limits['fiveHours'] ?? limits['5h']),
    300
  )
  if (fiveHour) candidates.push(fiveHour)
  const weekly = windowFromPair(
    'Weekly',
    record(limits['weekly'] ?? limits['week'] ?? limits['sevenDay'] ?? limits['seven_day']),
    10080
  )
  if (weekly) candidates.push(weekly)
  if (candidates.length === 0) return null
  const buckets = findObject(body, ['credits', 'credit'])
  let credits: AgentUsageCredits | undefined
  if (buckets) {
    const parts = ['monthlyCredits', 'purchasedCredits', 'freeCredits'].flatMap((key) => {
      const value = num(
        buckets[key] ?? buckets[key.replace(/[A-Z]/gu, (c) => `_${c.toLowerCase()}`)]
      )
      return value === undefined ? [] : [value]
    })
    if (parts.length > 0) {
      credits = { hasCredits: true, balance: parts.reduce((sum, part) => sum + part, 0) }
    }
  }
  return { rateLimits: assemble(candidates, 0), ...(credits ? { credits } : {}) }
}

/** new-api / one-api `/status`: `data.quota` is the cap, `data.used_quota` the spend. */
function parseNewApi(body: unknown): ParsedProviderUsage | null {
  const root = record(body)
  if (!root) return null
  const data = record(root['data']) ?? root
  const used = pickNumber(data, ['used_quota', 'usedQuota'])
  const limit = pickNumber(data, ['quota'])
  if (used === undefined && limit === undefined) return null
  const resetsAt = pickEpoch(data, ['expires_at', 'expiresAt'])
  const candidate: QuotaCandidate = {
    label: 'Quota',
    ...(used === undefined ? {} : { used }),
    ...(limit === undefined ? {} : { limit }),
    ...(resetsAt === undefined ? {} : { resetsAt })
  }
  const credits = creditsFromObject(root)
  return { rateLimits: assemble([candidate], 0), ...(credits ? { credits } : {}) }
}

const ZAI_UNIT_MINUTES: Readonly<Record<number, number>> = {
  3: 60,
  4: 1440,
  5: 43200,
  6: 10080
}

function zaiWindowLabel(unit: number | undefined, number: number | undefined): string {
  if (unit === 3 && number === 5) return '5-hour session'
  if (unit === 6 && number === 1) return 'Weekly'
  if (unit === undefined || number === undefined) return 'Quota'
  const unitName = unit === 3 ? 'hour' : unit === 4 ? 'day' : unit === 5 ? 'month' : 'week'
  return `${number}-${unitName}`
}

/** Z.ai / GLM: `data.limits[]` percentage windows with `unit` / `number` durations. */
function parseZai(body: unknown): ParsedProviderUsage | null {
  const root = record(body)
  if (!root) return null
  if (root['success'] === false) return null
  const data = record(root['data']) ?? root
  const limits = Array.isArray(data['limits']) ? data['limits'] : null
  if (!limits) return null
  const candidates: QuotaCandidate[] = []
  for (const rawLimit of limits) {
    const limit = record(rawLimit)
    if (!limit) continue
    const type = pickString(limit, ['type'])
    if (type !== undefined && type.toLocaleUpperCase('en-US') === 'TIME_LIMIT') continue
    const candidate = quotaFromObject(limit, 'Quota')
    if (!candidate) continue
    const unit = num(limit['unit'])
    const number = num(limit['number'])
    const windowMinutes =
      candidate.windowMinutes ??
      (unit !== undefined && number !== undefined
        ? number * (ZAI_UNIT_MINUTES[unit] ?? 0)
        : undefined)
    candidates.push({
      ...candidate,
      label: zaiWindowLabel(unit, number),
      ...(windowMinutes === undefined || windowMinutes === 0 ? {} : { windowMinutes })
    })
  }
  const level = pickString(data, ['level'])
  if (candidates.length === 0 && !level) return null
  return {
    rateLimits: assemble(candidates, 0),
    ...(level ? { credits: { hasCredits: true, planType: humanizePlan(level) } } : {})
  }
}

/** Kimi Code: `limits[]` session windows plus the top-level weekly `usage`. */
function parseKimi(body: unknown): ParsedProviderUsage | null {
  const root = record(body)
  if (!root) return null
  const candidates: QuotaCandidate[] = []
  const limits = Array.isArray(root['limits']) ? root['limits'] : []
  for (const rawLimit of limits) {
    const limit = record(rawLimit)
    if (!limit) continue
    const detail = record(limit['detail']) ?? limit
    const candidate = quotaFromObject(detail, 'Session')
    if (!candidate) continue
    const window = record(limit['window'])
    const windowMinutes =
      candidate.windowMinutes ?? (window ? windowMinutesFrom(window) : undefined)
    candidates.push({
      ...candidate,
      label: 'Session',
      ...(windowMinutes === undefined ? {} : { windowMinutes })
    })
  }
  const usage = record(root['usage'])
  if (usage) {
    const weekly = quotaFromObject(usage, 'Weekly')
    if (weekly)
      candidates.push({ ...weekly, label: 'Weekly', windowMinutes: weekly.windowMinutes ?? 10080 })
  }
  const membership = record(record(root['user'])?.['membership'])
  const level = membership ? pickString(membership, ['level']) : undefined
  const planType = level ? humanizePlan(level) : undefined
  if (candidates.length === 0 && !planType) return null
  return {
    rateLimits: assemble(candidates, 0),
    ...(planType ? { credits: { hasCredits: true, planType } } : {})
  }
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

const ADAPTERS: Partial<
  Record<BaseUrlProviderUsageFormat, (body: unknown) => ParsedProviderUsage | null>
> = {
  'new-api': parseNewApi,
  'command-code': parseCommandCode,
  zai: parseZai,
  kimi: parseKimi
}

/**
 * Parse a usage route body with the selected format. The named formats run
 * first and fall back to the generic walk when they recognize nothing, so a
 * provider whose envelope changes still shows whatever quota is recognizable.
 */
export function parseProviderUsage(
  format: BaseUrlProviderUsageFormat | undefined,
  body: unknown
): ParsedProviderUsage | null {
  const specific = format && format !== 'auto' ? ADAPTERS[format]?.(body) : null
  const parsed =
    specific && (specific.rateLimits.length > 0 || specific.credits) ? specific : parseGeneric(body)
  if (parsed.rateLimits.length === 0 && !parsed.credits) return null
  return parsed
}
