import { diffLines } from 'diff'

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
 * Line-by-line diff using the battle-tested Myers algorithm from the `diff`
 * package. Tracks before/after line numbers so hunks can be rendered with
 * accurate headers and expandable context.
 */
function lineDiff(before: string | undefined, after: string | undefined): DiffLine[] {
  const parts = diffLines(before ?? '', after ?? '')
  const lines: DiffLine[] = []
  let beforeLine = 1
  let afterLine = 1
  for (const part of parts) {
    const partLines = part.value.split('\n')
    if (partLines.at(-1) === '') partLines.pop()
    if (part.removed) {
      for (const text of partLines) {
        lines.push({ kind: 'deleted', text, beforeLine: beforeLine })
        beforeLine += 1
      }
    } else if (part.added) {
      for (const text of partLines) {
        lines.push({ kind: 'added', text, afterLine: afterLine })
        afterLine += 1
      }
    } else {
      for (const text of partLines) {
        lines.push({ kind: 'context', text, beforeLine: beforeLine, afterLine: afterLine })
        beforeLine += 1
        afterLine += 1
      }
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
