/** Low-level Claude Code stream value guards and serialization helpers. */

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

export function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function numberProperty(
  value: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const candidate = number(value[key])
    if (candidate !== undefined) return candidate
  }
  return undefined
}

export function epochMilliseconds(value: unknown): number | undefined {
  const numeric = number(value)
  if (numeric !== undefined) return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

export function serializeContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => serializeContent(item))
      .filter((item): item is string => Boolean(item))
      .join('\n')
  }
  const item = record(value)
  if (!item) return undefined
  return string(item['text']) ?? string(item['content']) ?? JSON.stringify(item)
}

export function summaryText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const summary = value
    .map((item) => string(record(item)?.['text']) ?? string(record(item)?.['summary']))
    .filter((item): item is string => Boolean(item))
    .join('\n')
  return summary || undefined
}
