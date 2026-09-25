import { createHash } from 'node:crypto'
import type {
  GitConflictAnalysis,
  GitConflictHunk,
  GitConflictWorkHunkState
} from '../../../lib/types'

export interface ConflictWorkMetadata {
  version: 1
  sourceHash: string
  draftSaved: boolean
  hunks: GitConflictWorkHunkState[]
}

/**
 * True when a text file still contains git conflict markers. A resolved file
 * has none of the `<<<<<<<`, `=======`, or `>>>>>>>` marker lines, so presence
 * of any of them means resolution is not complete.
 */
export function conflictSourceHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function lineStartOffsets(content: string): number[] {
  const offsets = [0]
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') offsets.push(index + 1)
  }
  return offsets
}

export function buildInitialConflictWorkFile(analysis: GitConflictAnalysis): {
  content: string
  hunks: GitConflictWorkHunkState[]
} {
  const offsets = lineStartOffsets(analysis.content)
  const parts: string[] = []
  const hunks: GitConflictWorkHunkState[] = []
  let sourceCursor = 0
  let outputLength = 0
  for (let index = 0; index < analysis.hunks.length; index += 1) {
    const hunk = analysis.hunks[index]
    if (!hunk) continue
    const sourceFrom = offsets[hunk.startLine - 1] ?? analysis.content.length
    const sourceTo = offsets[hunk.endLine] ?? analysis.content.length
    const before = analysis.content.slice(sourceCursor, sourceFrom)
    parts.push(before)
    outputLength += before.length
    const from = outputLength
    parts.push(hunk.ours)
    outputLength += hunk.ours.length
    const to = outputLength
    if (sourceTo < analysis.content.length && !hunk.ours.endsWith('\n')) {
      parts.push('\n')
      outputLength += 1
    }
    hunks.push({
      index,
      from,
      to,
      acceptedIncoming: false,
      acceptedCurrent: false,
      edited: false
    })
    sourceCursor = sourceTo
  }
  parts.push(analysis.content.slice(sourceCursor))
  return { content: parts.join(''), hunks }
}

function isConflictWorkHunkState(
  value: unknown,
  contentLength: number
): value is GitConflictWorkHunkState {
  if (!value || typeof value !== 'object') return false
  const state = value as Record<string, unknown>
  return (
    Number.isInteger(state.index) &&
    typeof state.index === 'number' &&
    state.index >= 0 &&
    Number.isInteger(state.from) &&
    typeof state.from === 'number' &&
    state.from >= 0 &&
    Number.isInteger(state.to) &&
    typeof state.to === 'number' &&
    state.to >= state.from &&
    state.to <= contentLength &&
    typeof state.acceptedIncoming === 'boolean' &&
    typeof state.acceptedCurrent === 'boolean' &&
    typeof state.edited === 'boolean'
  )
}

export function parseConflictWorkState(
  stateJson: string,
  contentLength: number
): GitConflictWorkHunkState[] {
  const parsed: unknown = JSON.parse(stateJson)
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => isConflictWorkHunkState(item, contentLength))
  ) {
    throw new TypeError('Conflict work state is invalid')
  }
  return parsed
}

export function parseConflictWorkMetadata(
  metadataText: string,
  sourceHash: string,
  hunkCount: number,
  contentLength: number
): ConflictWorkMetadata | null {
  const parsed: unknown = JSON.parse(metadataText)
  if (!parsed || typeof parsed !== 'object') return null
  const metadata = parsed as Record<string, unknown>
  if (
    metadata.version !== 1 ||
    metadata.sourceHash !== sourceHash ||
    metadata.draftSaved !== true ||
    !Array.isArray(metadata.hunks) ||
    metadata.hunks.length !== hunkCount ||
    !metadata.hunks.every((item) => isConflictWorkHunkState(item, contentLength))
  ) {
    return null
  }
  return {
    version: 1,
    sourceHash,
    draftSaved: true,
    hunks: metadata.hunks
  }
}

export function hasConflictMarkers(content: string): boolean {
  return /^(?:<<<<<<<[ \t].*|=======$|>>>>>>>[ \t].*)$/mu.test(content)
}

/**
 * Parse the well-formed conflict blocks (`<<<<<<<` … `>>>>>>>`) out of a
 * working file so the resolution panel can render each one. Handles both the
 * classic two-way shape and the diff3 shape (a `|||||||` base block between
 * ours and theirs). Returns hunks with 1-based inclusive line spans covering
 * the whole block including its markers.
 */
export function parseConflictHunks(content: string): GitConflictHunk[] {
  const lines = content.split('\n')
  const hunks: GitConflictHunk[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (!line.startsWith('<<<<<<<')) {
      i += 1
      continue
    }
    const startLine = i + 1
    const oursLabel = line.replace(/^<{7,}(?: |$)/u, '') || 'ours'
    const ours: string[] = []
    let base: string[] | null = null
    const theirs: string[] = []
    let j = i + 1
    // Ours side: everything up to `=======` or a diff3 `|||||||` base marker.
    while (
      j < lines.length &&
      !(lines[j] ?? '').startsWith('=======') &&
      !(lines[j] ?? '').startsWith('|||||||')
    ) {
      ours.push(lines[j] ?? '')
      j += 1
    }
    // Diff3 base: between `|||||||` and `=======`.
    if (j < lines.length && (lines[j] ?? '') !== '=======') {
      j += 1
      const baseLines: string[] = []
      while (j < lines.length && !(lines[j] ?? '').startsWith('=======')) {
        baseLines.push(lines[j] ?? '')
        j += 1
      }
      base = baseLines
    }
    if (j >= lines.length) {
      i = startLine
      continue // Malformed block   skip forward so we never loop forever.
    }
    j += 1 // consume `=======`
    while (j < lines.length && !(lines[j] ?? '').startsWith('>>>>>>>')) {
      theirs.push(lines[j] ?? '')
      j += 1
    }
    if (j >= lines.length) {
      i = startLine
      continue // Unclosed block   not a usable hunk.
    }
    const endLine = j + 1
    const theirsLabel = (lines[j] ?? '').replace(/^>{7,}(?: |$)/u, '') || 'theirs'
    hunks.push({
      startLine,
      endLine,
      oursLabel,
      theirsLabel,
      ours: ours.join('\n'),
      theirs: theirs.join('\n'),
      base: base === null ? null : base.join('\n')
    })
    i = j + 1
  }
  return hunks
}
