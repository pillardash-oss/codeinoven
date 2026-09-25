import type { ChangeTrackingService, CheckpointChange } from '../../git/change-tracking-service'

export interface CheckpointLineStats {
  additions?: number
  deletions?: number
  truncated?: boolean
}

const MAX_LINE_DIFF_BYTES = 1024 * 1024
const MAX_LINE_DIFF_LINES = 20_000
const MAX_LINE_DIFF_DISTANCE = 4_000
const MAX_LINE_DIFF_WORK = 4_000_000

/** Byte window returned for a per-file diff. Kept small to bound IPC payloads. */
export const MAX_DIFF_WINDOW_BYTES = 64 * 1024
/** Context bytes kept around the changed region so the diff reads naturally. */
export const DIFF_WINDOW_CONTEXT_BYTES = 8 * 1024

export async function calculateLineStats(
  tracker: ChangeTrackingService,
  changes: CheckpointChange[]
): Promise<{
  stats: Record<string, CheckpointLineStats>
  unavailablePaths: string[]
}> {
  const stats: Record<string, CheckpointLineStats> = {}
  const unavailablePaths: string[] = []
  for (const change of changes) {
    if (change.before?.binary ?? change.after?.binary ?? false) continue
    let before: Uint8Array | null
    let after: Uint8Array | null
    try {
      before = change.before ? await tracker.readBlob(change.before.hash) : new Uint8Array()
      after = change.after ? await tracker.readBlob(change.after.hash) : new Uint8Array()
    } catch {
      stats[change.path] = { truncated: true }
      unavailablePaths.push(change.path)
      continue
    }
    if ((change.before && !before) || (change.after && !after)) {
      stats[change.path] = { truncated: true }
      unavailablePaths.push(change.path)
      continue
    }
    stats[change.path] = calculateBoundedLineStats(
      before ?? new Uint8Array(),
      after ?? new Uint8Array()
    )
  }
  return { stats, unavailablePaths }
}

export function captureWarning(paths: string[]): string | undefined {
  const unique = [...new Set(paths)].sort()
  if (unique.length === 0) return undefined
  const visible = unique.slice(0, 5)
  const remainder = unique.length - visible.length
  return (
    `File paths were recorded, but checkpoint content is unavailable for ${unique.length} ` +
    `${unique.length === 1 ? 'file' : 'files'}; diffs, line counts, and undo may be incomplete: ` +
    `${visible.join(', ')}${remainder > 0 ? ` (+${remainder} more)` : ''}.`
  )
}

function calculateBoundedLineStats(
  beforeContent: Uint8Array,
  afterContent: Uint8Array
): CheckpointLineStats {
  if (
    beforeContent.byteLength > MAX_LINE_DIFF_BYTES ||
    afterContent.byteLength > MAX_LINE_DIFF_BYTES
  ) {
    return { truncated: true }
  }

  let before: string[]
  let after: string[]
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    before = splitLines(decoder.decode(beforeContent))
    after = splitLines(decoder.decode(afterContent))
  } catch {
    return { truncated: true }
  }

  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1
  }
  let beforeEnd = before.length
  let afterEnd = after.length
  while (beforeEnd > prefix && afterEnd > prefix && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1
    afterEnd -= 1
  }

  const oldLines = before.slice(prefix, beforeEnd)
  const newLines = after.slice(prefix, afterEnd)
  // The line budget guards the expensive alignment below, which only ever sees
  // the trimmed changed region   never the full files. Gating on whole-file
  // line counts here would reject large files with small edits (the common
  // case) even though computing their exact stats is cheap.
  if (oldLines.length + newLines.length > MAX_LINE_DIFF_LINES) {
    return { truncated: true }
  }
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 }
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length }

  const distance = boundedEditDistance(oldLines, newLines)
  if (distance === null) return { truncated: true }
  const delta = newLines.length - oldLines.length
  return {
    additions: (distance + delta) / 2,
    deletions: (distance - delta) / 2
  }
}

function boundedEditDistance(before: string[], after: string[]): number | null {
  const maximumDistance = Math.min(before.length + after.length, MAX_LINE_DIFF_DISTANCE)
  const offset = maximumDistance + 1
  const frontier = new Int32Array(maximumDistance * 2 + 3)
  frontier.fill(-1)
  frontier[offset + 1] = 0
  let work = 0

  for (let distance = 0; distance <= maximumDistance; distance += 1) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      work += 1
      if (work > MAX_LINE_DIFF_WORK) return null
      const index = offset + diagonal
      let oldIndex =
        diagonal === -distance ||
        (diagonal !== distance && frontier[index - 1] < frontier[index + 1])
          ? frontier[index + 1]
          : frontier[index - 1] + 1
      let newIndex = oldIndex - diagonal
      while (
        oldIndex < before.length &&
        newIndex < after.length &&
        before[oldIndex] === after[newIndex]
      ) {
        oldIndex += 1
        newIndex += 1
        work += 1
        if (work > MAX_LINE_DIFF_WORK) return null
      }
      frontier[index] = oldIndex
      if (oldIndex >= before.length && newIndex >= after.length) return distance
    }
  }
  return null
}

function splitLines(content: string): string[] {
  if (!content) return []
  const lines = content.split(/\r?\n/u)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

interface DecodedDiffWindow {
  before: string | undefined
  after: string | undefined
  truncated: boolean
}

/**
 * Returns a bounded text window around the changed region of a file instead of
 * always the head. Without this, an edit sitting past the first `maxBytes` of a
 * large file made the diff look empty ("No textual changes"). For created or
 * deleted files the existing side is shown from its head.
 */
export function decodeDiffWindow(
  before: Uint8Array | null,
  after: Uint8Array | null,
  maxBytes: number,
  contextBytes: number
): DecodedDiffWindow {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

  if (!before || !after) {
    const content = before ?? after
    if (!content) return { before: undefined, after: undefined, truncated: false }
    const truncated = content.length > maxBytes
    const text = decoder.decode(content.subarray(0, maxBytes))
    return before
      ? { before: text, after: undefined, truncated }
      : { before: undefined, after: text, truncated }
  }

  const minLength = Math.min(before.length, after.length)
  let prefix = 0
  while (prefix < minLength && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < minLength - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const changeEnd = Math.max(before.length - suffix, after.length - suffix)
  const changeSize = changeEnd - prefix

  const fitsWithContext = changeSize + contextBytes * 2 <= maxBytes
  let start = fitsWithContext
    ? Math.max(0, prefix - contextBytes)
    : Math.max(0, prefix + Math.floor(changeSize / 2) - Math.floor(maxBytes / 2))

  const snapped = lineStartIndex(before, start)
  if (snapped + maxBytes >= changeEnd) start = snapped

  const end = Math.min(start + maxBytes, Math.max(before.length, after.length))
  const beforeText = decoder.decode(before.subarray(start, Math.min(end, before.length)))
  const afterText = decoder.decode(after.subarray(start, Math.min(end, after.length)))
  const truncated = start > 0 || before.length > end || after.length > end
  return { before: beforeText, after: afterText, truncated }
}

/** Index just after the last newline at or before `index`, or 0. */
function lineStartIndex(data: Uint8Array, index: number): number {
  if (index <= 0) return 0
  let current = index
  while (current > 0 && data[current - 1] !== 0x0a) current -= 1
  return current
}
