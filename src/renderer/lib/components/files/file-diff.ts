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
 * headers and expandable context.
 */
function lineDiff(before: string | undefined, after: string | undefined): DiffLine[] {
  const beforeLines = sourceLines(before)
  const afterLines = sourceLines(after)
  if (beforeLines.length * afterLines.length > 500_000) {
    return fallbackDiff(beforeLines, afterLines)
  }

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
      lines.push({ kind: 'added', text: afterLines[afterIndex], afterLine: afterIndex + 1 })
      afterIndex += 1
    } else {
      lines.push({ kind: 'deleted', text: beforeLines[beforeIndex], beforeLine: beforeIndex + 1 })
      beforeIndex += 1
    }
  }
  return lines
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
  const lines = lineDiff(before, after)
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
