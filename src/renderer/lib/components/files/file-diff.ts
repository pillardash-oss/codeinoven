export interface DiffLine {
  kind: 'context' | 'added' | 'deleted'
  text: string
  beforeLine?: number
  afterLine?: number
}

export interface DiffHunk {
  /** Stable identifier for this change block (index of its first changed line). */
  id: string
  /** Inclusive indexes into the full diff `lines` array for the changed region. */
  changeStart: number
  changeEnd: number
  /** Context lines available strictly before the first changed line. */
  contextBefore: number
  /** Context lines available strictly after the last changed line. */
  contextAfter: number
}

export interface DiffDetails {
  /** Every line of the diff, in source order. */
  lines: DiffLine[]
  /** The change blocks, ordered by position in the file (deterministic). */
  hunks: DiffHunk[]
  additions: number
  deletions: number
}

export interface SplitRow {
  before: DiffLine | null
  after: DiffLine | null
}

/** Number of context lines shown around a change block before expanding. */
export const DEFAULT_CONTEXT_LINES = 3

/**
 * The exact LCS DP table is used only while it fits this many cells; larger
 * files switch to the bounded Myers diff so line-shifted edits stay exact.
 */
const LCS_CELL_LIMIT = 500_000
/** Hard cap on the Myers trace snapshots so pathological diffs stay bounded. */
const MAX_MYERS_TRACE_BYTES = 32 * 1024 * 1024
/** Absolute cap on the Myers edit-distance budget before the naive fallback. */
const MAX_MYERS_DISTANCE = 2_000

function sourceLines(source: string | undefined): string[] {
  if (source === undefined) return []
  const lines = source.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function fallbackDiff(before: string[], after: string[]): DiffLine[] {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix += 1
  }
  return [
    ...before.slice(0, prefix).map((text, index): DiffLine => ({
      kind: 'context',
      text,
      beforeLine: index + 1,
      afterLine: index + 1
    })),
    ...before.slice(prefix, before.length - suffix).map((text, index): DiffLine => ({
      kind: 'deleted',
      text,
      beforeLine: prefix + index + 1
    })),
    ...after.slice(prefix, after.length - suffix).map((text, index): DiffLine => ({
      kind: 'added',
      text,
      afterLine: prefix + index + 1
    })),
    ...before.slice(before.length - suffix).map((text, index): DiffLine => ({
      kind: 'context',
      text,
      beforeLine: before.length - suffix + index + 1,
      afterLine: after.length - suffix + index + 1
    }))
  ]
}

/**
 * Line-by-line diff (longest common subsequence) computed entirely in-house.
 * Tracks before/after line numbers so hunks can be rendered with accurate
 * headers and expandable context. Small inputs use the exact LCS table; large
 * inputs use a bounded Myers diff so a small edit in a big file does not render
 * as a whole-file rewrite (the naive prefix/suffix fallback cannot handle line
 * shifts). The naive fallback only survives for genuine large rewrites.
 */
export function computeDiffLines(
  before: string | undefined,
  after: string | undefined
): DiffLine[] {
  const beforeLines = sourceLines(before)
  const afterLines = sourceLines(after)
  if (beforeLines.length * afterLines.length <= LCS_CELL_LIMIT) {
    return exactLineDiff(beforeLines, afterLines)
  }
  return largeLineDiff(beforeLines, afterLines)
}

function exactLineDiff(beforeLines: string[], afterLines: string[]): DiffLine[] {
  const lengths = Array.from(
    { length: beforeLines.length + 1 },
    () => new Uint32Array(afterLines.length + 1)
  )
  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      lengths[beforeIndex][afterIndex] =
        beforeLines[beforeIndex] === afterLines[afterIndex]
          ? lengths[beforeIndex + 1][afterIndex + 1] + 1
          : Math.max(lengths[beforeIndex + 1][afterIndex], lengths[beforeIndex][afterIndex + 1])
    }
  }

  const lines: DiffLine[] = []
  let beforeIndex = 0
  let afterIndex = 0
  while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    if (
      beforeIndex < beforeLines.length &&
      afterIndex < afterLines.length &&
      beforeLines[beforeIndex] === afterLines[afterIndex]
    ) {
      lines.push({
        kind: 'context',
        text: beforeLines[beforeIndex],
        beforeLine: beforeIndex + 1,
        afterLine: afterIndex + 1
      })
      beforeIndex += 1
      afterIndex += 1
    } else if (
      afterIndex < afterLines.length &&
      (beforeIndex >= beforeLines.length ||
        lengths[beforeIndex][afterIndex + 1] >= lengths[beforeIndex + 1][afterIndex])
    ) {
      lines.push({
        kind: 'added',
        text: afterLines[afterIndex],
        afterLine: afterIndex + 1
      })
      afterIndex += 1
    } else {
      lines.push({
        kind: 'deleted',
        text: beforeLines[beforeIndex],
        beforeLine: beforeIndex + 1
      })
      beforeIndex += 1
    }
  }
  return lines
}

function largeLineDiff(beforeLines: string[], afterLines: string[]): DiffLine[] {
  const trace = myersTrace(beforeLines, afterLines)
  if (trace) return myersBacktrack(beforeLines, afterLines, trace)
  return fallbackDiff(beforeLines, afterLines)
}

/**
 * Myers O(ND) forward pass. Returns the per-distance V snapshots needed to
 * backtrack the exact edit script, or null when the edit is too large for the
 * trace memory budget (a genuine rewrite — the caller falls back to the naive
 * diff then).
 */
function myersTrace(beforeLines: string[], afterLines: string[]): Int32Array[] | null {
  const n = beforeLines.length
  const m = afterLines.length
  const size = 2 * (n + m) + 3
  const offset = n + m + 1
  const maxSnapshots = Math.max(1, Math.floor(MAX_MYERS_TRACE_BYTES / (4 * size)))
  const budget = Math.min(n + m, MAX_MYERS_DISTANCE, maxSnapshots)
  const v = new Int32Array(size)
  v[offset + 1] = 0
  const trace: Int32Array[] = []
  for (let distance = 0; distance <= budget; distance += 1) {
    trace.push(v.slice())
    for (let k = -distance; k <= distance; k += 2) {
      const index = offset + k
      let x =
        k === -distance || (k !== distance && v[index - 1] < v[index + 1])
          ? v[index + 1]
          : v[index - 1] + 1
      let y = x - k
      while (x < n && y < m && beforeLines[x] === afterLines[y]) {
        x += 1
        y += 1
      }
      v[index] = x
      if (x >= n && y >= m) return trace
    }
  }
  return null
}

/** Reconstruct the edit script (as DiffLine[]) from Myers trace snapshots. */
function myersBacktrack(
  beforeLines: string[],
  afterLines: string[],
  trace: Int32Array[]
): DiffLine[] {
  const offset = beforeLines.length + afterLines.length + 1
  const lines: DiffLine[] = []
  let x = beforeLines.length
  let y = afterLines.length
  for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
    const v = trace[distance]
    const k = x - y
    const previousK =
      k === -distance || (k !== distance && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1
    const previousX = v[offset + previousK]
    const previousY = previousX - previousK
    while (x > previousX && y > previousY) {
      lines.push({
        kind: 'context',
        text: beforeLines[x - 1],
        beforeLine: x,
        afterLine: y
      })
      x -= 1
      y -= 1
    }
    if (distance > 0) {
      if (x === previousX) {
        y -= 1
        lines.push({ kind: 'added', text: afterLines[y], afterLine: y + 1 })
      } else {
        x -= 1
        lines.push({ kind: 'deleted', text: beforeLines[x], beforeLine: x + 1 })
      }
    }
  }
  return lines.reverse()
}

/** Group contiguous changed lines into change blocks with available context. */
function diffHunks(lines: DiffLine[]): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let index = 0
  while (index < lines.length) {
    if (lines[index].kind === 'context') {
      index += 1
      continue
    }
    const changeStart = index
    while (index < lines.length && lines[index].kind !== 'context') {
      index += 1
    }
    const changeEnd = index - 1
    const previous = hunks.at(-1)
    const contextBefore = changeStart - (previous ? previous.changeEnd + 1 : 0)
    const contextAfter = lines.length - 1 - changeEnd
    hunks.push({
      id: `change:${changeStart}`,
      changeStart,
      changeEnd,
      contextBefore,
      contextAfter
    })
  }
  return hunks
}

export function diffDetails(before: string | undefined, after: string | undefined): DiffDetails {
  const lines = computeDiffLines(before, after)
  return {
    lines,
    hunks: diffHunks(lines),
    additions: lines.filter((line) => line.kind === 'added').length,
    deletions: lines.filter((line) => line.kind === 'deleted').length
  }
}

/** Pair deleted lines with the added lines that follow them so the split
 *  (horizontal) view can render before and after side by side. */
export function splitRows(hunkLines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  for (const line of hunkLines) {
    if (line.kind === 'context') {
      rows.push({ before: line, after: line })
    } else if (line.kind === 'deleted') {
      rows.push({ before: line, after: null })
    } else {
      const previous = rows.at(-1)
      if (previous && previous.before && !previous.after && previous.before.kind === 'deleted') {
        previous.after = line
      } else {
        rows.push({ before: null, after: line })
      }
    }
  }
  return rows
}
