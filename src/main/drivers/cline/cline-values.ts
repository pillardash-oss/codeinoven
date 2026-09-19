export function utilityKey(value: string): string {
  const key = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return key || 'utility'
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function timestampValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

export function serializeToolOutput(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
