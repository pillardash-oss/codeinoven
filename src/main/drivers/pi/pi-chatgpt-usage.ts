import type { AgentBankedResets, AgentRateLimitWindow, AgentUsageCredits } from '../../../lib/types'
import { rateLimitWindowLabel } from '../../usage/rate-limit-window-label'
import { numberValue, record, stringValue } from './pi-values'

/**
 * ChatGPT plan usage, read on demand from the same route the Codex client uses.
 *
 * Pi's ChatGPT sign-in can issue two kinds of credential. The modern `openai`
 * provider's token is scoped to `api.openai.com` and exposes no plan-limit
 * route at all. The Codex-style provider (`openai-codex`) issues a
 * `chatgpt.com`-capable token and stores the ChatGPT account id, and that pair
 * is what answers this route with the subscription windows, prepaid credits,
 * and banked rate-limit resets the battery popover shows.
 */

export const CHATGPT_USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage'

export interface PiChatGptPlanUsage {
  rateLimits: AgentRateLimitWindow[]
  credits?: AgentUsageCredits
  bankedResets?: AgentBankedResets
}

/**
 * Map one `rate_limit` window (`primary_window`/`secondary_window`). The route
 * reports the window length in seconds, the percentage already used, and both
 * an absolute `reset_at` (Unix seconds) and a relative `reset_after_seconds`.
 */
function planWindow(
  key: 'primary' | 'secondary',
  raw: unknown,
  planType: string | undefined
): AgentRateLimitWindow | null {
  const window = record(raw)
  if (!window) return null
  const usedPercent = numberValue(window['used_percent'])
  const windowSeconds = numberValue(window['limit_window_seconds'])
  const windowMinutes =
    windowSeconds === undefined ? undefined : Math.max(1, Math.round(windowSeconds / 60))
  const resetAt = numberValue(window['reset_at'])
  const resetAfter = numberValue(window['reset_after_seconds'])
  const resetsAt =
    resetAt !== undefined
      ? resetAt * 1_000
      : resetAfter !== undefined && resetAfter > 0
        ? Date.now() + resetAfter * 1_000
        : undefined
  if (usedPercent === undefined && windowMinutes === undefined && resetsAt === undefined)
    return null
  return {
    id: `pi-chatgpt:${planType ?? 'plan'}:${key}`,
    label: rateLimitWindowLabel(
      windowMinutes,
      key === 'primary' ? 'Primary limit' : 'Secondary limit'
    ),
    ...(usedPercent === undefined ? {} : { usedPercent: Math.max(0, Math.min(100, usedPercent)) }),
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...(resetsAt === undefined ? {} : { resetsAt })
  }
}

/**
 * Map the `wham/usage` payload into the shared quota shape. A payload with
 * nothing recognizable (no windows, no plan, no credits) resolves to null so
 * the caller omits provider usage instead of showing an empty battery.
 */
export function mapChatGptPlanUsage(value: unknown): PiChatGptPlanUsage | null {
  const payload = record(value)
  if (!payload) return null

  const planType = stringValue(payload['plan_type'])
  const rateLimits: AgentRateLimitWindow[] = []
  const limits = record(payload['rate_limit'])
  if (limits) {
    const primary = planWindow('primary', limits['primary_window'], planType)
    if (primary) rateLimits.push(primary)
    const secondary = planWindow('secondary', limits['secondary_window'], planType)
    if (secondary) rateLimits.push(secondary)
  }

  const creditsValue = record(payload['credits'])
  const balance = numberValue(creditsValue?.['balance'])
  const credits: AgentUsageCredits | undefined =
    creditsValue || planType
      ? {
          ...(planType === undefined ? {} : { planType }),
          ...(typeof creditsValue?.['has_credits'] === 'boolean'
            ? { hasCredits: creditsValue['has_credits'] }
            : {}),
          ...(typeof creditsValue?.['unlimited'] === 'boolean'
            ? { unlimited: creditsValue['unlimited'] }
            : {}),
          ...(balance === undefined ? {} : { balance })
        }
      : undefined

  const availableCount = numberValue(
    record(payload['rate_limit_reset_credits'])?.['available_count']
  )
  const bankedResets: AgentBankedResets | undefined =
    availableCount === undefined ? undefined : { availableCount }

  if (rateLimits.length === 0 && !credits && !bankedResets) return null
  return {
    rateLimits,
    ...(credits ? { credits } : {}),
    ...(bankedResets ? { bankedResets } : {})
  }
}
