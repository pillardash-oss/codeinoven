import type { AgentMessage, AgentPart } from '$shared/types'
import {
  extractCitations,
  extractSectionReferences,
  normalizeCitationPath
} from '$lib/agent-source-citations'

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
  /**
   * Project-relative form of `path` for display when the cited file lives
   * inside the current project — lets the sources panel show the tail of the
   * path instead of a truncated absolute path. Clicking always uses `path`.
   */
  displayPath?: string
  line?: number
  lineEnd?: number
}

export interface SectionAgentSource extends BaseAgentSource {
  kind: 'section'
  section: string
}

export type AgentSource =
  FileAgentSource | WebAgentSource | FileCitationAgentSource | SectionAgentSource

const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gu
const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)\s]+)\)/gu
const IMAGE_EXTENSION_PATTERN = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)(?:[?#].*)?$/iu
/** Query parameters that carry tracking state rather than content. Stripped
 *  only when deriving the dedup identity of a web source. */
const TRACKING_PARAMETER_PATTERN = /^(?:utm_|fbclid|gclid|yclid|igshid|mc_)/iu

function sourceId(kind: AgentSource['kind'], value: string): string {
  const normalized =
    kind === 'web'
      ? normalizeWebUrl(value)
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

/** Classify a web tool by what its completion proves the agent did:
 *  `fetch` means pages were actually retrieved, `search` means the agent only
 *  received result candidates it may not have opened. */
function webToolKind(tool: string): 'search' | 'fetch' | null {
  const name = tool.toLowerCase().replace(/[^a-z0-9]/gu, '')
  if (name.includes('websearch')) return 'search'
  if (name.includes('webfetch') || name === 'webrun' || name.startsWith('browseropen')) {
    return 'fetch'
  }
  return null
}

function cleanUrl(value: string): string {
  return value.replace(/[.,;:!?]+$/gu, '')
}

/** Canonical identity of a web source for deduplication: protocol+host
 *  lowercased, tracking parameters and fragment dropped, trailing slash on an
 *  empty path collapsed. The original URL is preserved for display. */
function normalizeWebUrl(value: string): string {
  const cleaned = cleanUrl(value.replaceAll('\\/', '/'))
  try {
    const parsed = new URL(cleaned)
    parsed.hash = ''
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMETER_PATTERN.test(key)) parsed.searchParams.delete(key)
    }
    const href = parsed.href
    return href.length > 1 && href.endsWith('/') ? href.slice(0, -1) : href
  } catch {
    return cleaned.toLowerCase()
  }
}

/** Only explicit Markdown links (`[label](https://…)`) in assistant prose are
 *  treated as cited sources. Bare URLs are the agent thinking out loud — never
 *  surfaced to the user. */
function urlsFromText(value: string): Array<{ url: string; title?: string }> {
  const links = new Map<string, string | undefined>()
  const normalizedValue = value.replaceAll('\\/', '/')
  for (const match of normalizedValue.matchAll(MARKDOWN_LINK_PATTERN)) {
    const url = cleanUrl(match[2])
    links.set(url, match[1].trim())
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

/** Fetched pages reported by a completed web-fetch tool. The output contract is
 *  `{"pages":[{"url","title?","content?","statusCode?"}]}` — possibly bounded to
 *  fit the model context, but always JSON. Empty when output is not parseable
 *  or does not carry a `pages` array. */
function parseFetchedPages(output: string): Array<{ url: string; title?: string }> {
  try {
    const value: unknown = JSON.parse(output)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const pages = (value as Record<string, unknown>)['pages']
    if (!Array.isArray(pages)) return []
    return pages.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const url = (entry as Record<string, unknown>)['url']
      const title = (entry as Record<string, unknown>)['title']
      if (typeof url !== 'string' || !url) return []
      return [{ url, ...(typeof title === 'string' && title ? { title } : {}) }]
    })
  } catch {
    return []
  }
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

/**
 * Record web sources from a completed web tool.
 *
 * Only fetched pages are real sources: the agent retrieved and read them.
 * Search results are candidates the agent may not have opened — they stay out
 * of the sources list and only surface when the agent later fetches one or
 * cites it as a Markdown link in its answer.
 */
function addWebTool(
  sources: Map<string, AgentSource>,
  message: AgentMessage,
  part: Extract<AgentPart, { type: 'tool' }>
): void {
  if (part.state.status !== 'completed') return
  const kind = webToolKind(part.tool)
  if (kind === null) return
  const input = textFromUnknown(part.state.input)
  if (kind === 'search') return

  const output = textFromUnknown(part.state.output)
  const pages = parseFetchedPages(output)
  if (pages.length > 0) {
    for (const page of pages) {
      addSource(sources, {
        id: sourceId('web', page.url),
        kind: 'web',
        title: page.title ?? webTitle(page.url),
        url: page.url,
        detail: 'Fetched by the agent',
        messageId: message.id,
        createdAt: message.createdAt
      })
    }
    return
  }

  for (const url of requestedWebUrls(input)) {
    addSource(sources, {
      id: sourceId('web', url),
      kind: 'web',
      title: webTitle(url),
      url,
      detail: 'Fetched by the agent',
      messageId: message.id,
      createdAt: message.createdAt
    })
  }
}

/** Requested fetch URLs recovered from the tool input JSON (`{"urls":[…]}`) —
 *  the fallback identity when the output carries no `pages` array. */
function requestedWebUrls(input: string): string[] {
  try {
    const value: unknown = JSON.parse(input)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const urls = (value as Record<string, unknown>)['urls']
    if (!Array.isArray(urls)) return []
    return urls.filter((entry): entry is string => typeof entry === 'string' && !!entry)
  } catch {
    return []
  }
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
        for (const section of extractSectionReferences(cleanText)) {
          addSource(sources, {
            id: sourceId('section', section),
            kind: 'section',
            title: `Section ${section}`,
            section,
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
