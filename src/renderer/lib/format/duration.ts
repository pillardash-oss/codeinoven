/**
 * Duration formatting shared by the run surfaces (working trace, sub-agent
 * cards, sub-agent session header, turn audit lines, auditor runtime).
 *
 * These read "how long did this take" at a glance, so the wording cascades
 * down the natural calendar units: weeks, days, hours, minutes, seconds. It
 * never repeats a zero unit, and it stops after `MAX_DURATION_UNITS` so a
 * half-day turn reads `5h 35m 32s` instead of an unreadable `335m 32s`.
 */
const DURATION_UNITS = [
  { label: 'w', seconds: 604_800 },
  { label: 'd', seconds: 86_400 },
  { label: 'h', seconds: 3_600 },
  { label: 'm', seconds: 60 },
  { label: 's', seconds: 1 }
] as const

/**
 * The most units a single duration renders (`5h 35m 32s`). Beyond three the
 * tail stops being readable, so week-long spans drop their seconds.
 */
const MAX_DURATION_UNITS = 3

/** Formats a whole-second span as `45s`, `3m 5s`, `5h 35m 32s`, `2d 4h 9m` or `1w 2d 3h`. */
export function formatDurationSeconds(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const units: string[] = []
  let remaining = total
  for (const unit of DURATION_UNITS) {
    if (units.length === MAX_DURATION_UNITS) break
    const value = Math.floor(remaining / unit.seconds)
    if (value === 0) continue
    remaining -= value * unit.seconds
    units.push(`${value}${unit.label}`)
  }
  return units.length > 0 ? units.join(' ') : '0s'
}

/** The same cascade for millisecond spans; sub-second ones stay as `<1s`. */
export function formatDurationMs(milliseconds: number): string {
  if (milliseconds < 1_000) return '<1s'
  return formatDurationSeconds(milliseconds / 1_000)
}
