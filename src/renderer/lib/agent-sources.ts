import type { AgentMessage, AgentPart } from '$shared/types'
import { extractCitations, normalizeCitationPath } from '$lib/agent-source-citations'

interface BaseAgentSource {
  id: string
  title: string
  messageId: string
  createdAt: number
}

export interface FileAgentSource extends BaseAgentSource {
  kind: 'attachment' | 'generated-image'
  url: string
  mime: string
}

export interface WebAgentSource extends BaseAgentSource {
  kind: 'web'
  url?: string
  detail?: string
}

export interface FileCitationAgentSource extends BaseAgentSource {
  kind: 'file-citation'
  path: string
  line?: number
  lineEnd?: number
}

export type AgentSource = FileAgentSource | WebAgentSource | FileCitationAgentSource

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]}]+/gu
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gu
const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)\s]+)\)/gu
const IMAGE_EXTENSION_PATTERN = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)(?:[?#].*)?$/iu

function sourceId(kind: AgentSource['kind'], value: string): string {
  const normalized =
    kind === 'web'
      ? cleanUrl(value.replaceAll('\\/', '/'))
      : kind === 'file-citation' || value.startsWith('file://')
        ? normalizeCitationPath(value)
        : value
  return `${kind}:${normalized}`
}

function fileName(part: Extract<AgentPart, { type: 'file' }>): string {
  const pathTail = part.url.split(/[\\/]/u).at(-1)?.split(/[?#]/u)[0]
  return part.filename ?? pathTail ?? 'File'
}

function isImage(mime: string, url: string): boolean {
  return mime.startsWith('image/') || IMAGE_EXTENSION_PATTERN.test(url)
}

function isWebTool(tool: string): boolean {
  const name = tool.toLowerCase().replace(/[^a-z0-9]/gu, '')
  return (
    name.includes('websearch') ||
    name.includes('webfetch') ||
    name === 'webrun' ||
    name.startsWith('browseropen')
  )
}

function cleanUrl(value: string): string {
  return value.replace(/[.,;:!?]+$/gu, '')
}

function urlsFromText(value: string): Array<{ url: string; title?: string }> {
  const links = new Map<string, string | undefined>()
  const normalizedValue = value.replaceAll('\\/', '/')
  for (const match of normalizedValue.matchAll(MARKDOWN_LINK_PATTERN)) {
    const url = cleanUrl(match[2])
    links.set(url, match[1].trim())
  }
  for (const match of normalizedValue.matchAll(URL_PATTERN)) {
    const url = cleanUrl(match[0])
    if (!links.has(url)) links.set(url, undefined)
  }
  return [...links].map(([url, title]) => ({ url, title }))
}

function textFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function webQuery(input: Record<string, unknown>): string | undefined {
  for (const key of ['q', 'query', 'url']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  const searchQueries = input['search_query']
  if (!Array.isArray(searchQueries)) return undefined
  const queries = searchQueries
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return ''
      const query = (entry as Record<string, unknown>)['q']
      return typeof query === 'string' ? query.trim() : ''
    })
    .filter(Boolean)
  return queries.length > 0 ? queries.join(' · ') : undefined
}

function webTitle(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.hostname.replace(/^www\./u, '')
  } catch {
    return url
  }
}

function addSource(sources: Map<string, AgentSource>, source: AgentSource): void {
  const existing = sources.get(source.id)
  if (!existing) {
    sources.set(source.id, source)
    return
  }
  if (
    existing.kind === 'web' &&
    source.kind === 'web' &&
    existing.title === webTitle(existing.url ?? '') &&
    source.title !== existing.title
  ) {
    sources.set(source.id, { ...existing, title: source.title })
    return
  }
  if (
    existing.kind === 'file-citation' &&
    source.kind === 'file-citation' &&
    existing.line === undefined &&
    source.line !== undefined
  ) {
    sources.set(source.id, {
      ...existing,
      title: source.title,
      line: source.line,
      lineEnd: source.lineEnd
    })
  }
}

function addFilePart(
  sources: Map<string, AgentSource>,
  message: AgentMessage,
  part: Extract<AgentPart, { type: 'file' }>
): void {
  const kind = message.role === 'user' ? 'attachment' : 'generated-image'
  if (kind === 'generated-image' && !isImage(part.mime, part.url)) return
  addSource(sources, {
    id: sourceId(kind, part.url),
    kind,
    title: fileName(part),
    url: part.url,
    mime: part.mime,
    messageId: message.id,
    createdAt: message.createdAt
  })
}

function addMarkdownImages(
  sources: Map<string, AgentSource>,
  message: AgentMessage,
  text: string
): void {
  if (message.role !== 'assistant') return
  for (const match of text.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    const url = match[2]
    if (!url.startsWith('data:image/') && !isImage('', url)) continue
    addSource(sources, {
      id: sourceId('generated-image', url),
      kind: 'generated-image',
      title: match[1].trim() || url.split(/[\\/]/u).at(-1) || 'Generated image',
      url,
      mime: url.startsWith('data:image/') ? url.slice(5, url.indexOf(';')) : '',
      messageId: message.id,
      createdAt: message.createdAt
    })
  }
}

function addWebLinks(
  sources: Map<string, AgentSource>,
  message: AgentMessage,
  text: string,
  detail?: string
): number {
  let count = 0
  for (const link of urlsFromText(text)) {
    addSource(sources, {
      id: sourceId('web', link.url),
      kind: 'web',
      title: link.title ?? webTitle(link.url),
      url: link.url,
      detail,
      messageId: message.id,
      createdAt: message.createdAt
    })
    count += 1
  }
  return count
}

function addWebTool(
  sources: Map<string, AgentSource>,
  message: AgentMessage,
  part: Extract<AgentPart, { type: 'tool' }>
): void {
  if (part.state.status !== 'completed' || !isWebTool(part.tool)) return
  const query = webQuery(part.state.input)
  const text = [
    textFromUnknown(part.state.input),
    part.state.output ?? '',
    textFromUnknown(part.state.metadata)
  ].join('\n')
  if (addWebLinks(sources, message, text, query) > 0) return

  const title = query ? `Web search: ${query}` : (part.state.title ?? 'Web research')
  addSource(sources, {
    id: sourceId('web', part.callID || part.id),
    kind: 'web',
    title,
    detail: part.state.output?.trim().slice(0, 240),
    messageId: message.id,
    createdAt: message.createdAt
  })
}

/** Build the unique, inspectable sources used throughout one persisted conversation. */
export function collectAgentSources(messages: AgentMessage[]): AgentSource[] {
  const sources = new Map<string, AgentSource>()

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'file') {
        addFilePart(sources, message, part)
        continue
      }
      if (part.type === 'tool') {
        addWebTool(sources, message, part)
        continue
      }
      if (part.type === 'text' && message.role === 'assistant') {
        addMarkdownImages(sources, message, part.text)
        addWebLinks(
          sources,
          message,
          part.text.replace(MARKDOWN_IMAGE_PATTERN, ''),
          'Cited by the agent'
        )
        const cleanText = part.text.replace(MARKDOWN_IMAGE_PATTERN, '')
        for (const citation of extractCitations(cleanText)) {
          if (citation.kind !== 'file') continue
          const id = sourceId('file-citation', citation.path)
          addSource(sources, {
            id,
            kind: 'file-citation',
            title: citation.line ? `${citation.path}:${citation.line}` : citation.path,
            path: citation.path,
            line: citation.line,
            lineEnd: citation.lineEnd,
            messageId: message.id,
            createdAt: message.createdAt
          })
        }
      }
    }
  }

  return [...sources.values()].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  )
}
