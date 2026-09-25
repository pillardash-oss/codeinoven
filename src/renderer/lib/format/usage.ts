import type { AgentBankedResets, AgentRateLimitWindow, AgentUsageCredits } from '$shared/types'
import { APP_LOCALE, formatDateTimeWithWeekday } from '$shared/date-time-format'

/**
 * Presentation helpers for provider quota telemetry (`AgentRateLimitWindow`,
 * credits, and banked resets).
 *
 * These are shared by every surface that renders quota windows (the
 * conversation usage popover and the Harness settings Accounts table), so a
 * window reads identically wherever it appears: the same percent derivation,
 * the same reset wording, the same credit/expiry phrasing.
 */

/** Compact token/amount counts: `942`, `12.4k`, `3.1m`. */
export function compactCount(value: number): string {
  const absolute = Math.abs(value)
  if (absolute < 1_000) return Math.round(value).toLocaleString()
  const divisor = absolute >= 1_000_000 ? 1_000_000 : 1_000
  const suffix = divisor === 1_000_000 ? 'm' : 'k'
  const scaled = value / divisor
  const precision = Math.abs(scaled) < 100 ? 1 : 0
  return `${scaled.toFixed(precision).replace(/\.0$/, '')}${suffix}`
}

export function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2
  }).format(value)
}

/** Percent of a quota window consumed, whether reported or derived from amounts. */
export function quotaPercent(limit: AgentRateLimitWindow): number | undefined {
  const reported = limit.usedPercent
  const calculated =
    limit.remaining !== undefined && limit.limit !== undefined && limit.limit > 0
      ? ((limit.limit - limit.remaining) / limit.limit) * 100
      : undefined
  const percent = reported ?? calculated
  return percent === undefined ? undefined : Math.max(0, Math.min(100, percent))
}

/** `allowed` → `Allowed`; provider status words surface as readable copy. */
export function readableStatus(value: string | undefined): string {
  if (!value) return 'Status unavailable'
  const normalized = value.replaceAll('_', ' ')
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

/**
 * When a window resets, written as a live-feeling countdown plus the absolute
 * local time: `Resets in 2h 14m · Tue, Sep 16, 3:00 PM`.
 */
export function formatResetCountdown(resetsAt: number | undefined): string {
  if (!resetsAt) return 'Reset time unavailable'
  const label = formatDateTimeWithWeekday(resetsAt)
  if (resetsAt <= Date.now()) return `Reset ${label}`
  const minutes = Math.max(1, Math.round((resetsAt - Date.now()) / 60_000))
  const duration =
    minutes >= 1_440
      ? `${Math.round(minutes / 1_440)}d ${Math.round((minutes % 1_440) / 60)}h`
      : minutes >= 60
        ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
        : `${minutes}m`
  return `Resets in ${duration} · ${label}`
}

const EXPIRY_FORMATTER = new Intl.DateTimeFormat(APP_LOCALE, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short'
})

/** Absolute expiry for banked reset credits: `Expires Aug 12, 2026, 3:00 PM GMT+1`. */
export function formatExpiry(value: number | null | undefined): string {
  if (value === null) return 'Does not expire'
  if (value === undefined || !Number.isFinite(new Date(value).getTime())) {
    return 'Expiry time unavailable'
  }
  const label = EXPIRY_FORMATTER.format(value)
  return `Expires ${label}`
}

/** Window length in minutes → a stable display bucket for grouping and sorting. */
export type QuotaWindowKind = 'session' | 'daily' | 'weekly' | 'monthly' | 'other'

export function quotaWindowKind(windowMinutes: number | undefined): QuotaWindowKind {
  if (windowMinutes === undefined) return 'other'
  if (windowMinutes <= 360) return 'session'
  if (windowMinutes <= 1_440) return 'daily'
  if (windowMinutes <= 10_080) return 'weekly'
  if (windowMinutes <= 44_640) return 'monthly'
  return 'other'
}

/**
 * Rolling windows ordered shortest-first (5-hour → daily → weekly → monthly),
 * then alphabetically so model-scoped limits such as Codex Spark stay grouped
 * with their base window instead of scattered by provider response order.
 */
export function sortRateLimitWindows(
  limits: readonly AgentRateLimitWindow[]
): AgentRateLimitWindow[] {
  return [...limits].toSorted((left, right) => {
    const leftMinutes = left.windowMinutes ?? Number.POSITIVE_INFINITY
    const rightMinutes = right.windowMinutes ?? Number.POSITIVE_INFINITY
    if (leftMinutes !== rightMinutes) return leftMinutes - rightMinutes
    return left.label.localeCompare(right.label, 'en-US')
  })
}

/** Overage/extra-usage copy for a window, when the provider reports any. */
export function overageLabel(limit: AgentRateLimitWindow): string | undefined {
  if (limit.isUsingOverage) return 'Using extra usage'
  if (!limit.overageStatus && !limit.overageDisabledReason) return undefined
  const status = limit.overageStatus
    ? `Extra usage: ${readableStatus(limit.overageStatus).toLowerCase()}`
    : 'Extra usage unavailable'
  return limit.overageDisabledReason
    ? `${status} · ${readableStatus(limit.overageDisabledReason).toLowerCase()}`
    : status
}

/** Prepaid-credit summary, e.g. `$12.40 credits`, `Unlimited`, `Credits active`. */
export function creditsLabel(source: { credits?: AgentUsageCredits }): string | undefined {
  const credits = source.credits
  if (!credits) return undefined
  if (credits.unlimited) return 'Unlimited'
  if (credits.balance !== undefined) return `${formatMoney(credits.balance)} credits`
  if (credits.hasCredits) return 'Credits active'
  return undefined
}

/**
 * Banked reset summary: how many are redeemable plus when the next one expires
 * (`3 banked resets · next expiry Aug 12, 2026, 3:00 PM GMT+1`).
 */
export function bankedResetSummary(resets: AgentBankedResets | undefined): string | undefined {
  if (!resets || resets.availableCount <= 0) return undefined
  const noun = resets.availableCount === 1 ? 'banked reset' : 'banked resets'
  const count = `${resets.availableCount} ${noun}`
  const expiries = (resets.credits ?? [])
    .map((credit) => credit.expiresAt)
    .filter((expiresAt): expiresAt is number => typeof expiresAt === 'number')
  if (expiries.length === 0) return `${count} · no expiry reported`
  const next = Math.min(...expiries)
  const expiry = formatExpiry(next)
  const label = `${expiry.charAt(0).toLowerCase()}${expiry.slice(1)}`
  return `${count} · next ${label}`
}
