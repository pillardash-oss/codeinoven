/**
 * Parse a cloud deployment build log into human-readable lines.
 *
 * Coolify deployment records carry their log as a JSON-encoded array of
 * entries shaped `{ command, output, type, timestamp, hidden, batch, order }`.
 * We render each entry as a timestamp line followed by its output line(s), and
 * mark lines that carry an explicit failure marker so the UI can tint them
 * destructively. Build tools write progress and even success messages to
 * `stderr`, so the stream is not used on its own to decide "error" — only the
 * line text does. Anything that is not that JSON-array shape is treated as
 * plain text and split on newlines.
 */

export interface DeploymentLogLine {
  /** Human-readable text for this line. */
  text: string
  /** True when this line represents an actual build/step failure. */
  isError: boolean
}

interface CoolifyLogEntry {
  output?: unknown
  type?: unknown
  timestamp?: unknown
}

/**
 * Strong failure indicators — a line carrying any of these is treated as an
 * error regardless of which stream Coolify reported it on. This stops benign
 * stderr progress/info (e.g. "Service ... built", which build tools write to
 * stderr) from being tinted destructively.
 */
const FAILURE_MARKERS =
  /(error|fatal|failed|failure|exit code|nonzero|exception|panic|killed|denied|permission denied|command not found|not found|could not|unable to|cannot|no such file|tsc: error|npm err|yarn error|make: \*\*\*)/iu

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

  const entries = tryParseCoolifyLog(source)
  if (entries) {
    const lines: DeploymentLogLine[] = []
    for (const entry of entries) {
      const output = typeof entry.output === 'string' ? entry.output : ''
      if (!output.trim()) continue
      const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null
      if (timestamp) {
        lines.push({ text: formatCoolifyTimestamp(timestamp), isError: false })
      }
      const outputLines = output.split(/\r?\n/u)
      for (const line of outputLines) {
        const trimmed = line.trim()
        if (trimmed) lines.push({ text: line, isError: isFailureLine(line) })
      }
    }
    return lines
  }

  return source
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .map((line) => ({ text: line, isError: isFailureLine(line) }))
}

/**
 * Decide whether a single log line is a genuine failure. Coolify's build tools
 * write progress and even success messages to `stderr`, so we only mark a line
 * as an error when its text carries an explicit failure marker — never merely
 * because it was emitted on stderr.
 */
function isFailureLine(line: string): boolean {
  return FAILURE_MARKERS.test(line)
}

/** Serialize parsed lines back to a single readable string (e.g. for copying). */
export function deploymentLogToText(lines: DeploymentLogLine[]): string {
  return lines.map((line) => line.text).join('\n')
}

function tryParseCoolifyLog(source: string): CoolifyLogEntry[] | null {
  if (!source.startsWith('[')) return null
  try {
    const parsed: unknown = JSON.parse(source)
    if (!Array.isArray(parsed)) return null
    const entries: CoolifyLogEntry[] = []
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue
      entries.push(item as CoolifyLogEntry)
    }
    return entries
  } catch {
    return null
  }
}
