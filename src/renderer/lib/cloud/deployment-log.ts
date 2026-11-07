/**
 * Parse a cloud deployment build log into human-readable lines.
 *
 * Coolify deployment records carry their log as a JSON-encoded array of
 * entries shaped `{ command, output, type, timestamp, hidden, batch, order }`,
 * where `type` is `stdout` or `stderr`. We render each entry as a timestamp
 * line followed by its output line(s), and mark only lines from `stderr`
 * entries as errors so the UI can tint them destructively. Nothing is inferred
 * from the text itself   a successful build can print words like "error" or
 * "failed" on stdout (e.g. a commit message), so the stream type is the single
 * source of truth. Anything that is not that JSON-array shape is treated as
 * plain text and split on newlines.
 *
 * The app caps how much of a provider log it keeps, so a payload can arrive
 * with its JSON cut mid-entry. Those whole leading entries are salvaged and the
 * view ends with a notice, because the alternative is dumping raw JSON text.
 */

export interface DeploymentLogLine {
  /** Human-readable text for this line. */
  text: string
  /** True when this line came from a `stderr` stream (a build/step error). */
  isError: boolean
}

interface CoolifyLogEntry {
  output?: unknown
  type?: unknown
  timestamp?: unknown
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
] as const

/**
 * Format an ISO timestamp (`2026-08-11T06:49:50.202938Z`) into a readable
 * `2026-Aug-11 06:49:50.202938` string, preserving the reported time as-is
 * (no timezone shift) so it matches what the provider returned.
 */
export function formatCoolifyTimestamp(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/u.exec(iso)
  if (!match) return iso
  const [, year, monthNum, day, hour, minute, second, fraction] = match
  const month = MONTH_NAMES[Number(monthNum) - 1] ?? monthNum
  const frac = fraction ? `.${fraction.slice(0, 6)}` : ''
  return `${year}-${month}-${day} ${hour}:${minute}:${second}${frac}`
}

/**
 * Turn a raw build-log string into lines ready for display. Returns an empty
 * array when there is nothing to show.
 */
export function parseDeploymentLog(raw: string): DeploymentLogLine[] {
  const source = (raw ?? '').trim()
  if (!source) return []

  const parsed = readLogEntries(source)
  if (parsed) {
    const lines: DeploymentLogLine[] = []
    for (const entry of parsed.entries) {
      const output = typeof entry.output === 'string' ? entry.output : ''
      if (!output.trim()) continue
      const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null
      if (timestamp) {
        lines.push({ text: formatCoolifyTimestamp(timestamp), isError: false })
      }
      // The provider's `type` is authoritative: only stderr is a real error.
      const isError = entry.type === 'stderr'
      const outputLines = output.split(/\r?\n/u)
      for (const line of outputLines) {
        const trimmed = line.trim()
        if (trimmed) lines.push({ text: line, isError })
      }
    }
    if (parsed.truncated && lines.length > 0) {
      lines.push({ text: TRUNCATED_LOG_NOTICE, isError: false })
    }
    return lines
  }

  return source
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .map((line) => ({ text: line, isError: false }))
}

/** Serialize parsed lines back to a single readable string (e.g. for copying). */
export function deploymentLogToText(lines: DeploymentLogLine[]): string {
  return lines.map((line) => line.text).join('\n')
}

/** Shown as the last line when the app only received part of a log. */
const TRUNCATED_LOG_NOTICE =
  '[log cut short when it was loaded, so only the entries above are shown]'

/** Parse a JSON log array, and report whether the payload was a truncated one. */
function readLogEntries(source: string): LogEntryBatch | null {
  if (!source.startsWith('[')) return null
  const direct = parseLogArray(source)
  if (direct) return direct
  const completeEnd = lastCompleteEntryEnd(source)
  if (completeEnd === null) return null
  const recovered = parseLogArray(`${source.slice(0, completeEnd)}]`)
  if (!recovered) return null
  return { entries: recovered.entries, truncated: true }
}

interface LogEntryBatch {
  entries: CoolifyLogEntry[]
  /** True when entries had to be salvaged from a payload cut mid-entry. */
  truncated: boolean
}

function parseLogArray(source: string): LogEntryBatch | null {
  try {
    const parsed: unknown = JSON.parse(source)
    if (!Array.isArray(parsed)) return null
    const entries: CoolifyLogEntry[] = []
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue
      entries.push(item as CoolifyLogEntry)
    }
    return { entries, truncated: false }
  } catch {
    return null
  }
}

/**
 * Index just past the last top-level array entry that closed completely, or
 * null when the payload holds no complete entry. Used to salvage a log that
 * was truncated mid-entry (the provider caps the payload, so the tail of the
 * JSON can be missing) instead of dumping the raw JSON into the log view.
 */
function lastCompleteEntryEnd(payload: string): number | null {
  let depth = 0
  let inString = false
  let escaped = false
  let end: number | null = null

  for (let index = 1; index < payload.length; index += 1) {
    const char = payload[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') {
      depth += 1
      continue
    }
    if (char === '}' || char === ']') {
      if (char === ']' && depth === 0) break
      depth -= 1
      if (depth === 0) end = index + 1
    }
  }

  return end
}
