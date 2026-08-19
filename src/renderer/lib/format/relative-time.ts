/**
 * Human-friendly "time since" for provider timestamps.
 *
 * Accepts an ISO-8601 string (what the GitHub API returns) or an epoch
 * millisecond value, and degrades to an empty string for missing input so
 * callers can render it inline without guarding.
 */
export function relativeTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return ''
  const timestamp = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''

  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 0) return 'just now'
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}
