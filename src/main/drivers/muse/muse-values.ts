export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return record(value)
  try {
    return record(JSON.parse(value) as unknown)
  } catch {
    return null
  }
}

export function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0)
}

/**
 * Muse treats `@path` in the prompt as a native file mention and strictly
 * resolves it; a glued or unresolvable mention aborts the whole run (exit 1,
 * "file mention @src/app.htmland rejected: file does not exist"). CodeInOven
 * already conveys attached paths to the model through a separate JSON context
 * block, so the literal `@path` token the composer leaves in the message is
 * redundant for Muse. Escape path-like `@` mentions so Muse reads them as plain
 * text instead of attempting (and failing) native attachment resolution.
 * Emails (`user@example.com`) and non-path tokens (`@task:…`, plain words) are
 * left untouched.
 */
export function escapeMuseMentions(text: string): string {
  return text.replace(/(^|[\s([{>`])@([^\s()\]}\],;:!?]+)/gu, (match, prefix, token) => {
    const isPath = token.includes('/') || /^[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8}$/u.test(token)
    if (!isPath) return match
    return `${prefix}\\@${token}`
  })
}
