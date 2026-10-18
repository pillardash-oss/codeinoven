/**
 * Preset response formats for a custom provider's usage route.
 *
 * The list lives in shared code so the editor, the IPC validator, the provider
 * service, and the clipboard all agree on the same ids. `auto` is the default
 * and the fallback every named format degrades to.
 */
import type { BaseUrlProviderUsageFormat } from './types/base-url-provider'

export interface ProviderUsageFormatOption {
  value: BaseUrlProviderUsageFormat
  label: string
  hint: string
  /** Route a fresh pick fills into the Usage endpoint field. Relative paths are
   *  resolved against the provider base URL; absolute URLs are used as-is. */
  endpoint?: string
}

export const PROVIDER_USAGE_FORMATS: readonly ProviderUsageFormatOption[] = [
  {
    value: 'auto',
    label: 'Auto-detect',
    hint: 'Reads whatever the endpoint returns and maps every object that looks like a quota.'
  },
  {
    value: 'openai',
    label: 'OpenAI-compatible',
    hint: 'OpenAI-style `{ data: [...] }` lists and plain `{ used, limit }` objects.',
    endpoint: '/usage'
  },
  {
    value: 'new-api',
    label: 'new-api / one-api',
    hint: 'The `/status` quota object (`quota`, `used_quota`).',
    endpoint: '/status'
  },
  {
    value: 'command-code',
    label: 'Command Code',
    hint: '`windowLimits.fiveHour` / `windowLimits.weekly` plus the credit buckets.',
    endpoint: 'https://api.commandcode.ai/alpha/billing/credits'
  },
  {
    value: 'zai',
    label: 'Z.ai / GLM',
    hint: '`data.limits[]` percentage windows with `unit` / `number` durations.',
    endpoint: 'https://api.z.ai/api/monitor/usage/quota/limit'
  },
  {
    value: 'kimi',
    label: 'Kimi Code',
    hint: '`limits[]` session windows plus the top-level weekly `usage`.',
    endpoint: 'https://api.kimi.com/coding/v1/usages'
  }
] as const

const FORMAT_IDS = new Set<string>(PROVIDER_USAGE_FORMATS.map((format) => format.value))

/** Route a format fills into the Usage endpoint field when picked, if it declares one. */
export function providerUsageFormatEndpoint(
  format: BaseUrlProviderUsageFormat
): string | undefined {
  return PROVIDER_USAGE_FORMATS.find((option) => option.value === format)?.endpoint
}

export function isBaseUrlProviderUsageFormat(value: unknown): value is BaseUrlProviderUsageFormat {
  return typeof value === 'string' && FORMAT_IDS.has(value)
}

/** Label for one format id, for tooltips outside the select. */
export function providerUsageFormatLabel(format: BaseUrlProviderUsageFormat): string {
  return PROVIDER_USAGE_FORMATS.find((option) => option.value === format)?.label ?? format
}
