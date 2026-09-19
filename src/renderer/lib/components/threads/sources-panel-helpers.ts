import type { AgentCapabilityEntry, AgentCapabilityOrigin, MemoryEntry } from '$shared/types'
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
  return new Date(startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function memoryScopeLabel(entry: MemoryEntry): string {
  if (entry.scope === 'global') return 'Global'
  if (entry.scope === 'thread') return 'Thread'
  if (entry.scope === 'chat') return 'Chat'
  if (entry.scope === 'project') return 'Project'
  return 'Projects'
}

export function originLabel(entry: AgentCapabilityEntry): string {
  if (entry.origin === 'application') return 'CodeInOven'
  if (entry.origin === 'global') return 'Global'
  return 'Harness'
}
