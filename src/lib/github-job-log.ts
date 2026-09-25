import type { GitHubDeploymentJob, GitHubDeploymentJobLog } from './types'

/**
 * GitHub Actions job logs, read the way GitHub writes them.
 *
 * A raw job log is one event per line, each prefixed with an ISO timestamp, with
 * `##[group]Title` and `##[endgroup]` around every step the workflow ran. GitHub's
 * web UI renders those groups as the collapsible sections you click through, and
 * that structure is what makes a failure readable: "Run bun install" failed, so
 * the five hundred lines about the runner image are not the point.
 *
 * This module recovers that structure, so the app can present a log the same way
 * and can hand an agent the step that failed instead of the whole log. It is pure
 * text handling with no Electron or DOM dependencies, so main caps a log with the
 * same rules the renderer parses it with.
 */

export type JobLogLineKind = 'output' | 'error' | 'warning' | 'omitted'

export interface JobLogLine {
  kind: JobLogLineKind
  text: string
}

export interface JobLogSection {
  /** Stable for a given log, so a view can remember which sections the user opened. */
  id: string
  title: string
  /** `preamble` holds the lines before the first `##[group]`. */
  kind: 'preamble' | 'group'
  lines: JobLogLine[]
  errorCount: number
  warningCount: number
  /** GitHub marked an error in this step, or the job report names it as failed. */
  failed: boolean
}

/** Line prefix GitHub puts on every event in a raw job log. */
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z ?/u
const GROUP_START = /^##\[(?:group|section)\](.*)$/u
const GROUP_END = '##[endgroup]'
const ERROR_MARKER = /^##\[error\](.*)$/u
const WARNING_MARKER = /^##\[warning\](.*)$/u
/** Command, debug and notice markers carry their text, only the wrapper is noise. */
const OTHER_MARKER = /^##\[(?:command|debug|notice)\](.*)$/u

/**
 * Terminal escape sequences: CSI colour and cursor codes, OSC hyperlink wrappers.
 * Built from character codes because a literal escape in a regex trips
 * `no-control-regex`, the same reason the provider accounts build their ANSI
 * pattern this way.
 */
const ANSI_ESCAPE = String.fromCharCode(27)
const ANSI_BELL = String.fromCharCode(7)
/** String Terminator, the other way an OSC sequence can end. */
const ANSI_ST = ANSI_ESCAPE + String.fromCharCode(92)
const ANSI_PATTERNS = [
  // OSC, which must not run past the next escape or line break.
  new RegExp(`${ANSI_ESCAPE}\\][^${ANSI_BELL}${ANSI_ESCAPE}]*`, 'gu'),
  new RegExp(`${ANSI_ESCAPE}\\[[0-?]*[ -/]*[@-~]`, 'gu'),
  new RegExp(ANSI_BELL, 'gu')
]

/** Job logs arrive wrapped for a terminal, and every pane in this app is plain text. */
export function stripJobLogEscapes(text: string): string {
  const stripped = ANSI_PATTERNS.reduce((result, pattern) => result.replace(pattern, ''), text)
  return stripped.split(ANSI_ST).join('')
}

function formatByteSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${Math.round(bytes / 1000)} KB`
}

/**
 * The line main leaves behind when it drops the middle of a log too large to keep
 * whole. It parses as its own line kind so a view can mark it and an agent excerpt
 * can never quote it as if the step had printed it.
 */
export function jobLogOmissionLine(input: {
  omittedLines: number
  totalBytes: number
  capBytes: number
}): string {
  return `===== ${input.omittedLines} lines omitted by CodeInOven: this log is ${formatByteSize(
    input.totalBytes
  )} and the app keeps ${formatByteSize(input.capBytes)} =====`
}

export function isJobLogOmissionLine(text: string): boolean {
  return text.startsWith('=====') && text.includes('omitted by CodeInOven')
}

/**
 * Cap an oversized log by keeping whole steps from both ends: the start of the log
 * and the end, which is where a failing workflow puts the step that broke. Cutting
 * on `##[group]` boundaries keeps every surviving section correctly titled, and the
 * omission marker tells the reader that the middle is missing.
 */
export function capJobLogText(
  text: string,
  capBytes: number
): { log: string; truncated: boolean; omittedLines: number } {
  if (text.length <= capBytes) return { log: text, truncated: false, omittedLines: 0 }
  const lines = text.split('\n')
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) {
    offsets.push(offset)
    offset += line.length + 1
  }
  const boundaries: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (GROUP_START.test(lines[index].replace(TIMESTAMP_PREFIX, ''))) boundaries.push(index)
  }
  // Two thirds for the head, one third for the tail, which holds the failure, and
  // a small reserve so the omission marker itself fits inside the cap.
  const budget = Math.max(0, capBytes - 256)
  const headBudget = Math.floor(budget * 0.6)
  const tailBudget = budget - headBudget
  const tolerance = Math.floor(budget * 0.15)
  const headEnd = cutIndex({
    offsets,
    boundaries,
    target: headBudget,
    tolerance,
    direction: -1
  })
  const tailStart = Math.min(
    lines.length,
    Math.max(
      cutIndex({
        offsets,
        boundaries,
        target: offset - tailBudget,
        tolerance,
        direction: 1
      }),
      headEnd + 1
    )
  )
  const omittedLines = tailStart - headEnd
  const marker = jobLogOmissionLine({
    omittedLines,
    totalBytes: text.length,
    capBytes
  })
  const capped = [...lines.slice(0, headEnd), marker, ...lines.slice(tailStart)].join('\n')
  return { log: capped, truncated: true, omittedLines }
}

/**
 * Line index to cut the log at. A `##[group]` edge wins when it sits within
 * `tolerance` of the target, so surviving sections keep their titles. A distant
 * edge loses to a plain line boundary, because one step often spans most of a
 * log and honoring that edge would waste the budget it was meant to spend.
 */
function cutIndex(input: {
  offsets: readonly number[]
  boundaries: readonly number[]
  target: number
  tolerance: number
  direction: -1 | 1
}): number {
  const { offsets, boundaries, target, tolerance, direction } = input
  let edge: number | null = null
  for (const index of boundaries) {
    if (direction === -1 && offsets[index] > target) break
    if (direction === 1 && offsets[index] >= target) {
      edge = index
      break
    }
    if (direction === -1) edge = index
  }
  const fallback =
    direction === -1 ? lineIndexBefore(offsets, target) : lineIndexAfter(offsets, target)
  if (edge === null) return fallback
  return Math.abs(offsets[edge] - target) <= tolerance ? edge : fallback
}

/** Last line that starts at or before a character offset. */
function lineIndexBefore(offsets: readonly number[], limit: number): number {
  let best = 0
  for (let index = 0; index < offsets.length; index += 1) {
    if (offsets[index] > limit) break
    best = index
  }
  return best
}

/** First line that starts at or after a character offset. */
function lineIndexAfter(offsets: readonly number[], limit: number): number {
  for (let index = 0; index < offsets.length; index += 1) {
    if (offsets[index] >= limit) return index
  }
  return Math.max(0, offsets.length - 1)
}

function stepKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/gu, ' ')
}

/**
 * A step counts as the failed one when GitHub marked an error inside it, or when
 * the job report names it. Step names and group titles agree in practice, but the
 * comparison is tolerant because a job can rename a step after the log is written.
 */
function matchesFailedStep(titleKey: string, failedStepKeys: ReadonlySet<string>): boolean {
  if (failedStepKeys.size === 0 || titleKey === '') return false
  if (failedStepKeys.has(titleKey)) return true
  for (const key of failedStepKeys) {
    if (key.length < 8) continue
    if (titleKey.includes(key) || key.includes(titleKey)) return true
  }
  return false
}

/**
 * Split a raw log into the sections GitHub's UI shows. Lines before the first group
 * become a preamble, and lines that follow a group without one of their own are
 * kept as a continuation rather than folded into a step they do not belong to.
 */
export function parseJobLogSections(
  log: string,
  options: { failedSteps?: readonly string[] } = {}
): JobLogSection[] {
  const failedStepKeys = new Set((options.failedSteps ?? []).map(stepKey).filter(Boolean))
  const sections: JobLogSection[] = []
  let open: JobLogSection | null = null
  let groupIndex = 0

  const currentSection = (): JobLogSection => {
    if (open !== null) return open
    const section: JobLogSection =
      sections.length === 0
        ? {
            id: 'preamble',
            title: 'Before the first step',
            kind: 'preamble',
            lines: [],
            errorCount: 0,
            warningCount: 0,
            failed: false
          }
        : {
            id: `continuation:${sections.length}`,
            title: 'Continued output',
            kind: 'group',
            lines: [],
            errorCount: 0,
            warningCount: 0,
            failed: false
          }
    open = section
    sections.push(section)
    return section
  }

  for (const rawLine of stripJobLogEscapes(log).split('\n')) {
    const unixLine = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const text = unixLine.replace(TIMESTAMP_PREFIX, '')
    if (isJobLogOmissionLine(text)) {
      currentSection().lines.push({ kind: 'omitted', text })
      // Close the section so the dropped middle is never read as part of a step.
      open = null
      continue
    }
    const groupMatch = GROUP_START.exec(text)
    if (groupMatch !== null) {
      groupIndex += 1
      open = {
        id: `group:${groupIndex}`,
        title: groupMatch[1].trim() || `Step ${groupIndex}`,
        kind: 'group',
        lines: [],
        errorCount: 0,
        warningCount: 0,
        failed: false
      }
      sections.push(open)
      continue
    }
    if (text.trim() === GROUP_END) {
      // Stray lines after the end marker still belong to the step that just ended.
      continue
    }
    const errorMatch = ERROR_MARKER.exec(text)
    if (errorMatch !== null) {
      const section = currentSection()
      section.lines.push({ kind: 'error', text: errorMatch[1].trim() })
      section.errorCount += 1
      continue
    }
    const warningMatch = WARNING_MARKER.exec(text)
    if (warningMatch !== null) {
      const section = currentSection()
      section.lines.push({ kind: 'warning', text: warningMatch[1].trim() })
      section.warningCount += 1
      continue
    }
    if (text.trim() === '' && open === null && sections.length === 0) continue
    const otherMatch = OTHER_MARKER.exec(text)
    currentSection().lines.push({ kind: 'output', text: otherMatch?.[1] ?? text })
  }

  for (const section of sections) {
    while (section.lines.length > 0 && section.lines[section.lines.length - 1].text.trim() === '') {
      section.lines.pop()
    }
    section.failed =
      section.errorCount > 0 || matchesFailedStep(stepKey(section.title), failedStepKeys)
  }
  return sections.filter((section) => section.kind !== 'preamble' || section.lines.length > 0)
}

/**
 * The sections worth sending to an agent. GitHub marks the failing step itself, and
 * when the log carries no marker the last step to print anything is the one that
 * died, which is reported as inferred so the prompt can say so.
 */
export function jobLogFailureSections(sections: readonly JobLogSection[]): {
  selected: JobLogSection[]
  inferred: boolean
} {
  const marked = sections.filter(
    (section) => section.failed && section.lines.some((line) => line.kind !== 'omitted')
  )
  if (marked.length > 0) return { selected: marked, inferred: false }
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index]
    if (section.lines.some((line) => line.kind !== 'omitted')) {
      return { selected: [section], inferred: true }
    }
  }
  return { selected: [], inferred: false }
}

/** One outline line naming every step, so an agent sees the job's shape without its text. */
export function jobLogStepOutline(sections: readonly JobLogSection[]): string {
  return sections
    .filter((section) => section.kind === 'group')
    .map((section) => `${section.failed ? 'FAILED' : 'ok'}: ${section.title}`)
    .join(' | ')
}

/**
 * Quote a section for an agent. The window ends at the last line GitHub marked as
 * an error, because that is the failure, and a step can print a lot of trailing
 * noise after it. `droppedLines` lets the caller say what it left out.
 */
export function jobLogExcerpt(
  lines: readonly JobLogLine[],
  maxChars: number
): { text: string; droppedLines: number } {
  const keptSource = lines.filter((line) => line.kind !== 'omitted')
  const rendered = keptSource.map((line) => {
    if (line.kind === 'error') return `##[error]${line.text}`
    if (line.kind === 'warning') return `##[warning]${line.text}`
    return line.text
  })
  let end = rendered.length - 1
  for (let index = keptSource.length - 1; index >= 0; index -= 1) {
    if (keptSource[index].kind === 'error') {
      end = index
      break
    }
  }
  const kept: string[] = []
  let chars = 0
  for (let index = end; index >= 0; index -= 1) {
    const line = rendered[index]
    if (kept.length > 0 && chars + line.length + 1 > maxChars) break
    kept.unshift(line)
    chars += line.length + 1
  }
  return { text: kept.join('\n'), droppedLines: rendered.length - kept.length }
}

/** A job that finished and did not succeed, the only kind worth diagnosing. */
export function isFailedJob(job: GitHubDeploymentJob): boolean {
  return job.status === 'completed' && isFailedConclusion(job.conclusion)
}

/** Names of the steps a job reported as failed, in the order GitHub lists them. */
export function failedJobStepNames(job: GitHubDeploymentJob): string[] {
  return job.steps
    .filter((step) => step.status === 'completed' && isFailedConclusion(step.conclusion))
    .map((step) => step.name)
}

/** How much of each failing step an agent is handed before the attachment takes over. */
const FAILED_STEP_EVIDENCE_CHARS = 4_000
/** Quoting more failing steps than this buries the first one in the prompt. */
const MAX_EVIDENCE_STEPS = 3

/**
 * The evidence one failed job contributes to an agent's first message.
 *
 * Quote the step that failed, not the log. A job log is mostly the steps that
 * worked, installing and caching and checking out, and GitHub names the step that
 * broke. That step is what gets pasted, bounded, with the job's step outline around
 * it so an agent can see the shape of the job without reading it. The caller still
 * hands over the whole log as an attachment; this is the part meant to be read.
 */
export function failedJobLogEvidence(
  job: GitHubDeploymentJob,
  log: GitHubDeploymentJobLog | null
): string[] {
  const failedSteps = failedJobStepNames(job)
  const lines = [
    `Failed job: ${job.name}`,
    `Job ID: ${job.id}`,
    `Job status: ${job.status}${job.conclusion ? ` / ${job.conclusion}` : ''}`,
    `Failed steps: ${failedSteps.length > 0 ? failedSteps.join(', ') : '(not reported)'}`,
    ...(job.url ? [`Job URL: ${job.url}`] : [])
  ]
  if (log === null) {
    return [...lines, 'Job log: unavailable; diagnose from the supplied metadata and local files.']
  }
  const sections = parseJobLogSections(log.log, { failedSteps })
  const { selected, inferred } = jobLogFailureSections(sections)
  if (selected.length === 0) {
    return [
      ...lines,
      'Job log: the log carried no step output, so diagnose from the metadata and the attached log.'
    ]
  }
  const quoted = selected.slice(0, MAX_EVIDENCE_STEPS)
  const evidence: string[] = []
  for (const section of quoted) {
    const excerpt = jobLogExcerpt(section.lines, FAILED_STEP_EVIDENCE_CHARS)
    const shown =
      excerpt.droppedLines > 0
        ? `showing the last ${section.lines.length - excerpt.droppedLines} of ${section.lines.length} lines`
        : `${section.lines.length} lines`
    evidence.push(
      `${inferred ? 'Step that failed last' : 'Failed step'}: ${section.title} (${shown})`,
      '```text',
      excerpt.text,
      '```'
    )
  }
  if (selected.length > quoted.length) {
    evidence.push(
      `${selected.length - quoted.length} more failing step(s) are in the attached log.`
    )
  }
  const outline = jobLogStepOutline(sections)
  return [
    ...lines,
    ...(outline ? ['', `Steps in this job: ${outline}`] : []),
    ...(inferred
      ? [
          '',
          'The log does not mark which step failed, so the step that printed last is quoted below.'
        ]
      : []),
    '',
    'Failed step output (the whole log is attached as "Pasted text.txt"):',
    ...evidence
  ]
}

function isFailedConclusion(conclusion: string | null): boolean {
  return (
    conclusion !== null &&
    conclusion !== 'success' &&
    conclusion !== 'neutral' &&
    conclusion !== 'skipped' &&
    conclusion !== 'cancelled'
  )
}
