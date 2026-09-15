/**
 * Duration formatting shared by the run surfaces (working trace, sub-agent
 * cards, sub-agent session header).
 *
 * These read "how long has this been running" at a glance, so the wording
 * stays compact and never repeats a zero unit: `45s`, `3m 5s`, `1h 4m`.
 */
export function formatDurationSeconds(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  if (total < 60) return `${total}s`
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  const remainder = total % 60
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`
}
