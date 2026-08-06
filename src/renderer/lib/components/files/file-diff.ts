export interface DiffLine {
  kind: 'context' | 'added' | 'deleted'
  text: string
  beforeLine?: number
  afterLine?: number
}

export interface DiffHunk {
  startIndex: number
  lines: DiffLine[]
  beforeStart: number
  beforeCount: number
  afterStart: number
  afterCount: number
}

export interface SplitRow {
  before: DiffLine | null
  after: DiffLine | null
}

const CONTEXT_LINES = 3

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

function diffHunks(lines: DiffLine[]): DiffHunk[] {
  const changedIndexes = lines
    .map((line, index) => (line.kind === 'context' ? -1 : index))
    .filter((index) => index >= 0)
  if (changedIndexes.length === 0) return []

  const ranges: Array<{ start: number; end: number }> = []
  for (const changedIndex of changedIndexes) {
    const start = Math.max(0, changedIndex - CONTEXT_LINES)
    const end = Math.min(lines.length - 1, changedIndex + CONTEXT_LINES)
    const previous = ranges.at(-1)
    if (previous && start <= previous.end + 1) {
      previous.end = Math.max(previous.end, end)
    } else {
      ranges.push({ start, end })
    }
  }

  return ranges.map(({ start, end }) => {
    const hunkLines = lines.slice(start, end + 1)
    const beforeLines = hunkLines.flatMap((line) =>
      line.beforeLine === undefined ? [] : [line.beforeLine]
    )
    const afterLines = hunkLines.flatMap((line) =>
      line.afterLine === undefined ? [] : [line.afterLine]
    )
    return {
      startIndex: start,
      lines: hunkLines,
      beforeStart: beforeLines[0] ?? 0,
      beforeCount: beforeLines.length,
      afterStart: afterLines[0] ?? 0,
      afterCount: afterLines.length
    }
  })
}

export function diffDetails(
  before: string | undefined,
  after: string | undefined
): { hunks: DiffHunk[]; additions: number; deletions: number } {
  const lines = lineDiff(before, after)
  return {
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
