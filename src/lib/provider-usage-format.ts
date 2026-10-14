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
    hint: 'OpenAI-style `{ data: [...] }` lists and plain `{ used, limit }` objects.'
  },
  {
    value: 'new-api',
    label: 'new-api / one-api',
    hint: 'The `/status` quota object (`quota`, `used_quota`).'
  },
  {
    value: 'command-code',
    label: 'Command Code',
    hint: '`windowLimits.fiveHour` / `windowLimits.weekly` plus the credit buckets.'
  },
  {
    value: 'open-design',
    label: 'Open Design',
    hint: 'Coding-plan windows from the daemon billing route, or the wallet balance.'
  },
  {
    value: 'zai',
    label: 'Z.ai / GLM',
    hint: '`data.limits[]` percentage windows with `unit` / `number` durations.'
  },
  {
    value: 'kimi',
    label: 'Kimi Code',
    hint: '`limits[]` session windows plus the top-level weekly `usage`.'
  }
] as const

const FORMAT_IDS = new Set<string>(PROVIDER_USAGE_FORMATS.map((format) => format.value))

export function isBaseUrlProviderUsageFormat(value: unknown): value is BaseUrlProviderUsageFormat {
  return typeof value === 'string' && FORMAT_IDS.has(value)
}

/** Label for one format id, for tooltips outside the select. */
export function providerUsageFormatLabel(format: BaseUrlProviderUsageFormat): string {
  return PROVIDER_USAGE_FORMATS.find((option) => option.value === format)?.label ?? format
}
