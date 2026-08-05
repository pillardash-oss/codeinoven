import type { AgentPart, TurnCheckpointFileDiff } from '$shared/types'

export interface ToolDiffLine {
  kind: 'context' | 'added' | 'deleted'
  text: string
  beforeLine?: number
  afterLine?: number
}

export interface ToolFileDiff {
  path: string
  lines: ToolDiffLine[]
  truncated: boolean
}

const MAX_DIFF_LINES = 120
const CONTEXT_LINES = 3

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'string') return record[key]
  }
  return undefined
}

function filePath(record: Record<string, unknown>, fallback = 'Changed file'): string {
  return (
    firstString(record, ['path', 'filePath', 'file_path', 'notebook_path', 'filename']) ?? fallback
  )
}

function bounded(lines: ToolDiffLine[]): Pick<ToolFileDiff, 'lines' | 'truncated'> {
  if (lines.length <= MAX_DIFF_LINES) return { lines, truncated: false }
  return { lines: lines.slice(0, MAX_DIFF_LINES), truncated: true }
}

function compactContext(lines: ToolDiffLine[]): ToolDiffLine[] {
  const changedIndexes = lines
    .map((line, index) => (line.kind === 'context' ? -1 : index))
    .filter((index) => index >= 0)
  if (changedIndexes.length === 0) return []
  const visible = new Set<number>()
  for (const index of changedIndexes) {
    for (
      let candidate = Math.max(0, index - CONTEXT_LINES);
      candidate <= Math.min(lines.length - 1, index + CONTEXT_LINES);
      candidate += 1
    ) {
      visible.add(candidate)
    }
  }
  return lines.filter((_, index) => visible.has(index))
}

function snippetDiff(beforeSource: string, afterSource: string): ToolDiffLine[] {
  const before = beforeSource.split('\n')
  const after = afterSource.split('\n')
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
  const lines: ToolDiffLine[] = [
    ...before.slice(0, prefix).map((text, index): ToolDiffLine => ({
      kind: 'context',
      text,
      beforeLine: index + 1,
      afterLine: index + 1
    })),
    ...before.slice(prefix, before.length - suffix).map((text, index): ToolDiffLine => ({
      kind: 'deleted',
      text,
      beforeLine: prefix + index + 1
    })),
    ...after.slice(prefix, after.length - suffix).map((text, index): ToolDiffLine => ({
      kind: 'added',
      text,
      afterLine: prefix + index + 1
    })),
    ...before.slice(before.length - suffix).map((text, index): ToolDiffLine => ({
      kind: 'context',
      text,
      beforeLine: before.length - suffix + index + 1,
      afterLine: after.length - suffix + index + 1
    }))
  ]
  return compactContext(lines)
}

function fullLineDiff(
  beforeSource: string | undefined,
  afterSource: string | undefined
): ToolDiffLine[] {
  const before = beforeSource?.split('\n') ?? []
  const after = afterSource?.split('\n') ?? []
  if (before.at(-1) === '') before.pop()
  if (after.at(-1) === '') after.pop()
  if (before.length * after.length > 500_000) {
    return snippetDiff(before.join('\n'), after.join('\n'))
  }

  const lengths = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1))
  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      lengths[beforeIndex][afterIndex] =
        before[beforeIndex] === after[afterIndex]
          ? lengths[beforeIndex + 1][afterIndex + 1] + 1
          : Math.max(lengths[beforeIndex + 1][afterIndex], lengths[beforeIndex][afterIndex + 1])
    }
  }

  const lines: ToolDiffLine[] = []
  let beforeIndex = 0
  let afterIndex = 0
  while (beforeIndex < before.length || afterIndex < after.length) {
    if (
      beforeIndex < before.length &&
      afterIndex < after.length &&
      before[beforeIndex] === after[afterIndex]
    ) {
      lines.push({
        kind: 'context',
        text: before[beforeIndex],
        beforeLine: beforeIndex + 1,
        afterLine: afterIndex + 1
      })
      beforeIndex += 1
      afterIndex += 1
    } else if (
      afterIndex < after.length &&
      (beforeIndex >= before.length ||
        lengths[beforeIndex][afterIndex + 1] >= lengths[beforeIndex + 1][afterIndex])
    ) {
      lines.push({
        kind: 'added',
        text: after[afterIndex],
        afterLine: afterIndex + 1
      })
      afterIndex += 1
    } else {
      lines.push({
        kind: 'deleted',
        text: before[beforeIndex],
        beforeLine: beforeIndex + 1
      })
      beforeIndex += 1
    }
  }
  return compactContext(lines)
}

function patchDiffs(source: string, fallbackPath: string): ToolFileDiff[] {
  const files = new Map<string, ToolDiffLine[]>()
  let currentPath = fallbackPath
  let beforeLine: number | undefined
  let afterLine: number | undefined
  let inHunk = false

  const linesForCurrentFile = (): ToolDiffLine[] => {
    const existing = files.get(currentPath)
    if (existing) return existing
    const created: ToolDiffLine[] = []
    files.set(currentPath, created)
    return created
  }

  for (const rawLine of source.split('\n')) {
    const fileHeader = rawLine.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/u)
    const moveHeader = rawLine.match(/^\*\*\* Move to: (.+)$/u)
    const gitHeader = rawLine.match(/^diff --git a\/(.+) b\/(.+)$/u)
    const deletedFileHeader = rawLine.match(/^--- (?:a\/)?(.+)$/u)
    const addedFileHeader = rawLine.match(/^\+\+\+ (?:b\/)?(.+)$/u)
    if (fileHeader || moveHeader || gitHeader || deletedFileHeader || addedFileHeader) {
      const headerPath =
        fileHeader?.[1] ??
        moveHeader?.[1] ??
        gitHeader?.[2] ??
        deletedFileHeader?.[1] ??
        addedFileHeader?.[1]
      if (headerPath && headerPath !== '/dev/null') currentPath = headerPath
      inHunk = Boolean(fileHeader?.[0].includes('Add File'))
      beforeLine = undefined
      afterLine = undefined
      continue
    }

    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u)
    if (rawLine.startsWith('@@')) {
      inHunk = true
      beforeLine = hunk ? Number(hunk[1]) : undefined
      afterLine = hunk ? Number(hunk[2]) : undefined
      continue
    }
    if (!inHunk || rawLine.startsWith('*** End Patch')) continue

    const prefix = rawLine[0]
    if (prefix === '+' && !rawLine.startsWith('+++')) {
      linesForCurrentFile().push({
        kind: 'added',
        text: rawLine.slice(1),
        ...(afterLine === undefined ? {} : { afterLine })
      })
      if (afterLine !== undefined) afterLine += 1
    } else if (prefix === '-' && !rawLine.startsWith('---')) {
      linesForCurrentFile().push({
        kind: 'deleted',
        text: rawLine.slice(1),
        ...(beforeLine === undefined ? {} : { beforeLine })
      })
      if (beforeLine !== undefined) beforeLine += 1
    } else if (prefix === ' ') {
      linesForCurrentFile().push({
        kind: 'context',
        text: rawLine.slice(1),
        ...(beforeLine === undefined ? {} : { beforeLine }),
        ...(afterLine === undefined ? {} : { afterLine })
      })
      if (beforeLine !== undefined) beforeLine += 1
      if (afterLine !== undefined) afterLine += 1
    }
  }

  return [...files.entries()]
    .filter(([, lines]) => lines.some((line) => line.kind !== 'context'))
    .map(([path, lines]) => ({ path, ...bounded(compactContext(lines)) }))
}

function recordDiff(record: Record<string, unknown>, fallbackPath: string): ToolFileDiff[] {
  const path = filePath(record, fallbackPath)
  const patch = firstString(record, ['diff', 'patch'])
  if (patch) return patchDiffs(patch, path)

  const before = firstString(record, ['old_string', 'oldString', 'old_str', 'before', 'oldText'])
  const after = firstString(record, ['new_string', 'newString', 'new_str', 'after', 'newText'])
  if (before !== undefined && after !== undefined) {
    const lines = snippetDiff(before, after)
    return lines.length > 0 ? [{ path, ...bounded(lines) }] : []
  }

  const content = firstString(record, ['content', 'text'])
  if (content !== undefined) {
    const lines = content.split('\n').map((text, index): ToolDiffLine => ({
      kind: 'added',
      text,
      afterLine: index + 1
    }))
    return [{ path, ...bounded(lines) }]
  }
  return []
}

export function toolFileDiffs(part: Extract<AgentPart, { type: 'tool' }>): ToolFileDiff[] {
  const normalizedName = part.tool.toLowerCase().replaceAll(/[^a-z0-9]/gu, '')
  if (
    !normalizedName.includes('edit') &&
    !normalizedName.includes('patch') &&
    !normalizedName.includes('write') &&
    !normalizedName.includes('create') &&
    !normalizedName.includes('filechange')
  ) {
    return []
  }

  const changes = part.state.input['changes']
  if (Array.isArray(changes)) {
    const diffs = changes.flatMap((change) => {
      const record = recordValue(change)
      return record ? recordDiff(record, filePath(part.state.input)) : []
    })
    if (diffs.length > 0) return diffs
  }
  return recordDiff(part.state.input, part.state.title ?? part.tool)
}

export function toolChangePaths(part: Extract<AgentPart, { type: 'tool' }>): string[] {
  const changes = part.state.input['changes']
  const paths = Array.isArray(changes)
    ? changes
        .map((change) => {
          const record = recordValue(change)
          return record ? filePath(record, '') : ''
        })
        .filter(Boolean)
    : []
  const directPath = filePath(part.state.input, '')
  if (directPath) paths.push(directPath)
  return [...new Set(paths)]
}

export function checkpointPathsForTool(
  part: Extract<AgentPart, { type: 'tool' }>,
  checkpointPaths: string[]
): string[] {
  const canonicalPaths = [...new Set(checkpointPaths.map((path) => path.replaceAll('\\', '/')))]
  const longestFirst = [...canonicalPaths].sort((left, right) => right.length - left.length)
  const resolved = toolChangePaths(part).flatMap((toolPath) => {
    const normalized = toolPath.replaceAll('\\', '/').replace(/^\.\//u, '')
    const exact = canonicalPaths.find((path) => path === normalized)
    if (exact) return [exact]

    const absoluteMatch = longestFirst.find((path) => normalized.endsWith(`/${path}`))
    if (absoluteMatch) return [absoluteMatch]

    if (normalized.includes('/')) return []
    const basenameMatches = canonicalPaths.filter((path) => path.split('/').at(-1) === normalized)
    return basenameMatches.length === 1 ? basenameMatches : []
  })
  return [...new Set(resolved)]
}

export function checkpointToolDiff(diff: TurnCheckpointFileDiff): ToolFileDiff | null {
  if (diff.binary) return null
  const lines = fullLineDiff(diff.before, diff.after)
  return lines.length > 0
    ? {
        path: diff.path,
        ...bounded(lines),
        truncated: diff.truncated || lines.length > MAX_DIFF_LINES
      }
    : null
}
