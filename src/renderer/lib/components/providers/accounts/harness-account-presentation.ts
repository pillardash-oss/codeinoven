import type { AgentRateLimitWindow, HarnessAccount } from '$shared/types'
import { formatResetCountdown, quotaPercent, sortRateLimitWindows } from '$lib/format/usage'

/**
 * Presentation rules for the Harness settings Accounts page.
 *
 * The page reads provider quota in two places that must agree: the compact
 * glance under each account in the list, and the full window rows in the
 * detail pane. Both take their percent derivation, ordering, wording and
 * severity from here so a window can never read differently in the two.
 */

/** How urgent a quota window looks. Thresholds match the conversation surface. */
export type QuotaHeat = 'cool' | 'warn' | 'hot'

export interface AccountGroup {
  harnessId: string
  harnessName: string
  accounts: HarnessAccount[]
}

export function quotaHeat(percent: number | undefined): QuotaHeat {
  if (percent === undefined) return 'cool'
  if (percent >= 90) return 'hot'
  if (percent >= 70) return 'warn'
  return 'cool'
}

/** Fill colour of a quota meter. */
export function meterClass(heat: QuotaHeat): string {
  if (heat === 'hot') return 'bg-danger'
  if (heat === 'warn') return 'bg-warning'
  return 'bg-info'
}

/** Ink colour of the percentage sitting beside a meter. */
export function percentClass(heat: QuotaHeat): string {
  if (heat === 'hot') return 'text-danger'
  if (heat === 'warn') return 'text-warning'
  return 'text-foreground'
}

/**
 * The short window name that fits the glance column: `5h`, `7d`, `30d`.
 *
 * A model-scoped window keeps its own label (`Opus 4`), because two rows
 * reading `7d` would hide the fact that one of them is a per-model limit.
 */
export function windowShortLabel(window: AgentRateLimitWindow): string {
  if (window.model) return window.label
  const minutes = window.windowMinutes
  if (minutes === undefined) return window.label
  if (minutes >= 43_200) return '30d'
  if (minutes >= 10_080) return '7d'
  if (minutes >= 1_440) return '24h'
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`
  return `${minutes}m`
}

/** What the window measures, in the detail pane's own words. */
export function windowScopeLabel(minutes: number | undefined): string {
  if (minutes === undefined) return 'reported limit'
  if (minutes >= 43_200) return 'rolling month'
  if (minutes >= 10_080) return 'rolling week'
  if (minutes >= 1_440) return 'rolling day'
  return 'rolling session'
}

/** `resets in 2h 14m`, without the absolute time the hover carries. */
export function resetShortLabel(resetsAt: number | undefined): string {
  const [head] = formatResetCountdown(resetsAt).split(' · ')
  return head.replace(/^Resets /, 'resets ').replace(/^Reset /, 'reset ')
}

/** The windows a glance shows, shortest first. */
export function glanceWindows(limits: readonly AgentRateLimitWindow[]): AgentRateLimitWindow[] {
  return sortRateLimitWindows(limits).slice(0, 3)
}

/** Whether any window reports provider overage, which the list notes inline. */
export function usesOverage(limits: readonly AgentRateLimitWindow[]): boolean {
  return limits.some((limit) => limit.isUsingOverage === true)
}

/** Whole percent for display, or undefined when the provider reports no quota. */
export function windowPercent(window: AgentRateLimitWindow): number | undefined {
  const percent = quotaPercent(window)
  return percent === undefined ? undefined : Math.round(percent)
}

/**
 * Accounts grouped by the harness that owns them, in the order the caller
 * supplied, so the list reads as one section per harness rather than a flat
 * run of rows.
 */
export function groupAccountsByHarness(
  accounts: readonly HarnessAccount[],
  nameFor: (harnessId: string) => string
): AccountGroup[] {
  const groups = new Map<string, AccountGroup>()
  for (const account of accounts) {
    const group = groups.get(account.harnessId)
    if (group) group.accounts.push(account)
    else
      groups.set(account.harnessId, {
        harnessId: account.harnessId,
        harnessName: nameFor(account.harnessId),
        accounts: [account]
      })
  }
  return [...groups.values()]
}
