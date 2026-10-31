/**
 * Whether a string is a full site address the board may measure.
 *
 * The check lives in a plain module rather than in the panel's controller: it is
 * pure, it has no reactive state, and it is the one place that decides what the
 * reference field accepts.
 */
export function isSiteUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
