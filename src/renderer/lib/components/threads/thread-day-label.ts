/**
 * Day labels for thread-list day grouping.
 *
 * Threads in the ungrouped thread view are separated by day headers
 * ("Today", "Yesterday", "Earlier this week", the date). The label is
 * computed from the thread's last-activity timestamp relative to the
 * current calendar day.
 */

export function threadDayLabel(timestamp: number, now: number): string {
  const d = new Date(timestamp)
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const threadDay = new Date(d)
  threadDay.setHours(0, 0, 0, 0)

  const diffMs = today.getTime() - threadDay.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return 'Earlier this week'
  if (diffDays < 30) return 'Earlier this month'
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}
