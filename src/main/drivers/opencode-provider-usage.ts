import type { AgentRateLimitWindow } from '../../lib/types'

export const OPENCODE_ACCOUNT_USAGE_ENDPOINT = 'https://opencode.ai/zen/go/v1/usage'
export const OPENCODE_ACCOUNT_PROVIDER_IDS = ['opencode-go', 'opencode'] as const

const OPENCODE_USAGE_WINDOWS: ReadonlyArray<{
  id: string
  key: string
  label: string
  windowMinutes: number
}> = [
  { id: 'rolling', key: 'rolling', label: '5-hour limit', windowMinutes: 300 },
  { id: 'weekly', key: 'weekly', label: 'Weekly limit', windowMinutes: 10_080 },
  { id: 'monthly', key: 'monthly', label: 'Monthly limit', windowMinutes: 43_200 }
]

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function timestampValue(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Normalize OpenCode's account-wide rolling, weekly, and monthly quota windows. */
export function mapOpenCodeAccountUsage(value: unknown): AgentRateLimitWindow[] {
  const usage = recordValue(recordValue(value)?.['usage'])
  if (!usage) return []
  return OPENCODE_USAGE_WINDOWS.flatMap((definition) => {
    const window = recordValue(usage[definition.key])
    if (!window) return []
    const percent = numberValue(window['percent'])
    const resetsAt = timestampValue(window['resetsAt'])
    if (percent === undefined && resetsAt === undefined) return []
    const status = stringValue(window['status'])
    return [
      {
        id: `opencode-go:${definition.id}`,
        label: definition.label,
        ...(status ? { status } : {}),
        ...(percent === undefined ? {} : { usedPercent: Math.max(0, Math.min(100, percent)) }),
        ...(resetsAt === undefined ? {} : { resetsAt }),
        windowMinutes: definition.windowMinutes
      }
    ]
  })
}
