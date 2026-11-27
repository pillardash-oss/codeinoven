import type {
  AgentCapabilityEntry,
  AgentCapabilityOrigin,
  AgentRunningProcess,
  MemoryEntry
} from '$shared/types'
import { formatTime } from '$shared/date-time-format'
import { memoryScopeSummary } from '$shared/memory/memory-scopes'
import type { AgentSource, FileAgentSource, FileCitationAgentSource } from '$lib/agent-sources'

export type SourcesSection = 'sources' | 'processes' | 'artifacts' | 'contexts'
export type ContextSection = 'mcps' | 'skills' | 'memory'
export type OriginFilter = 'all' | AgentCapabilityOrigin
export type SourceFilter = 'all' | AgentSource['kind']

export function isImageSource(source: FileAgentSource): boolean {
  return (
    source.mime.startsWith('image/') ||
    /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)(?:[?#].*)?$/iu.test(source.url)
  )
}

/** A source the panel can open as a picture in the media lightbox: an
 *  attachment or a generated image whose bytes render as an image. */
export function isPreviewableImageSource(source: AgentSource): source is FileAgentSource {
  return (
    (source.kind === 'attachment' || source.kind === 'generated-image') && isImageSource(source)
  )
}

export function sourceLabel(source: AgentSource): string {
  if (source.kind === 'attachment') return 'Attachment'
  if (source.kind === 'generated-image') return 'Generated image'
  if (source.kind === 'file-citation') return 'File cited'
  if (source.kind === 'section') return 'Section'
  return 'Website'
}

export function sourceFilterLabel(kind: SourceFilter): string {
  switch (kind) {
    case 'all':
      return 'source'
    case 'attachment':
      return 'attachment'
    case 'web':
      return 'web'
    case 'generated-image':
      return 'image'
    case 'file-citation':
      return 'cited-file'
    case 'section':
      return 'section'
  }
}

/** Citation text shown in the panel: the project-relative path when the file
 *  lives in the project (the full absolute path stays in the tooltip and on
 *  the click target). Long paths are middle-ellipsized so the tail   the
 *  filename   is never cut off by the narrow sidebar. */
export function citationDisplayText(source: FileCitationAgentSource): string {
  const path = source.displayPath ?? source.path
  if (path.length <= 48) return path
  return `${path.slice(0, 12)}…${path.slice(-34)}`
}

export function processName(command: string): string {
  const executable = command.trim().split(/\s+/u)[0] ?? command
  return executable.split(/[\\/]/u).at(-1) || 'Process'
}

export function processStartedAt(startedAt: number): string {
  return formatTime(startedAt)
}

/**
 * The words a running-process row can be found by: the executable name, the pid,
 * the whole command line, every port it listens on, and the directory it runs
 * in. Every field is joined into one lowercase haystack so a query token only
 * has to appear somewhere in the row.
 */
export function processSearchText(process: AgentRunningProcess): string {
  return [
    processName(process.command),
    String(process.pid),
    process.command,
    (process.ports ?? []).join(' '),
    process.cwd ?? ''
  ]
    .join('\n')
    .toLowerCase()
}

/** A query split into lowercase tokens, so "3000 pnpm" narrows to the row whose
 *  port and executable both match. */
export function processSearchTokens(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter((token) => token.length > 0)
}

/** True when every token appears in the row's searchable text. */
export function processMatchesSearch(
  process: AgentRunningProcess,
  tokens: readonly string[]
): boolean {
  if (tokens.length === 0) return true
  const text = processSearchText(process)
  return tokens.every((token) => text.includes(token))
}

export function memoryScopeLabel(entry: MemoryEntry): string {
  return memoryScopeSummary(entry.scopes)
}

export function originLabel(entry: AgentCapabilityEntry): string {
  if (entry.origin === 'application') return 'CodeInOven'
  if (entry.origin === 'global') return 'Global'
  return 'Harness'
}
