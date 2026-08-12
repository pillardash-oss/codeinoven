import type { WebUtilityConfig, WebToolProviderId } from '../lib/types'

export type WebToolKind = 'web_search' | 'web_fetch'
export type WebToolFormat = 'markdown' | 'text' | 'html'

const WEB_TIMEOUT_MS = 30_000
const WEB_MAX_RESULT_TEXT = 100_000
const WEB_MAX_URLS = 5

export interface WebSearchResult {
  title: string
  url: string
  description: string
  publishedDate?: string
  content?: string
}

export interface WebSearchOutput {
  query: string
  results: WebSearchResult[]
}

export interface WebFetchPage {
  url: string
  title?: string
  content: string
  statusCode?: number
}

export interface WebFetchOutput {
  pages: WebFetchPage[]
}

interface WebSearchInput {
  query: string
  count: number
  country?: string
  language?: string
  startDate?: string
  endDate?: string
}

interface WebFetchInput {
  urls: string[]
  format: WebToolFormat
}

type WebToolInput = WebSearchInput | WebFetchInput

export interface WebToolRequest {
  method: 'GET' | 'POST'
  endpoint: string
  headers: Record<string, string>
  query?: Record<string, string>
  body?: unknown
}

interface WebToolResponse {
  rawText: string
  json: Record<string, unknown> | null
}

/**
 * JSON schemas describing the provider-neutral web tool contract. Exposed to
 * models when a web utility is activated so input and output stay predictable
 * regardless of which backend (Exa, Firecrawl, Brave, or a custom endpoint)
 * actually handles the call.
 */
export const WEB_TOOL_INPUT_SCHEMAS: Record<WebToolKind, Record<string, unknown>> = {
  web_search: {
    type: 'object',
    additionalProperties: false,
    description: 'Search the web. Provide a query; everything else is an optional bias.',
    properties: {
      query: { type: 'string', description: 'The search query.', minLength: 1, maxLength: 500 },
      count: {
        type: 'number',
        description: 'How many results to return (1-20).',
        minimum: 1,
        maximum: 20,
        default: 5
      },
      country: {
        type: 'string',
        description: 'Two-letter ISO 3166-1 country code to bias results, e.g. "US".',
        minLength: 2,
        maxLength: 2
      },
      language: {
        type: 'string',
        description: 'Two-letter ISO 639-1 language code to bias results, e.g. "en".',
        minLength: 2,
        maxLength: 2
      },
      startDate: {
        type: 'string',
        description: 'Only results published on or after this date (ISO 8601, e.g. 2025-01-01).'
      },
      endDate: {
        type: 'string',
        description: 'Only results published on or before this date (ISO 8601, e.g. 2025-12-31).'
      }
    },
    required: ['query']
  },
  web_fetch: {
    type: 'object',
    additionalProperties: false,
    description: 'Retrieve the content of one or more web pages.',
    properties: {
      urls: {
        type: 'array',
        description: 'Absolute http(s) page URLs to retrieve.',
        minItems: 1,
        maxItems: WEB_MAX_URLS,
        items: { type: 'string' }
      },
      format: {
        type: 'string',
        enum: ['markdown', 'text', 'html'],
        default: 'markdown',
        description: 'Content format to return.'
      }
    },
    required: ['urls']
  }
}

export const WEB_TOOL_OUTPUT_SCHEMAS: Record<WebToolKind, Record<string, unknown>> = {
  web_search: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            url: { type: 'string' },
            description: { type: 'string' },
            publishedDate: { type: 'string' },
            content: { type: 'string', description: 'Snippet or extracted text when available.' }
          },
          required: ['title', 'url', 'description']
        }
      }
    },
    required: ['query', 'results']
  },
  web_fetch: {
    type: 'object',
    properties: {
      pages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            title: { type: 'string' },
            content: { type: 'string', description: 'Page content in the requested format.' },
            statusCode: { type: 'number' }
          },
          required: ['url', 'content']
        }
      }
    },
    required: ['pages']
  }
}

interface BuiltInWebToolAdapter {
  execute(
    kind: WebToolKind,
    input: WebToolInput,
    environment: Record<string, string>
  ): Promise<WebSearchOutput | WebFetchOutput>
}

/**
 * Validates the model-provided input against the normalized contract, then
 * dispatches to the configured backend. Built-in providers translate the
 * contract into their native payload and normalize responses back to the
 * documented output shape; custom providers POST the validated contract as-is
 * and return the raw response text.
 */
export async function executeWebTool(
  kind: WebToolKind,
  provider: WebToolProviderId,
  input: unknown,
  config: WebUtilityConfig,
  environment: Record<string, string>
): Promise<string> {
  const normalized = parseWebToolInput(kind, input)
  if (provider === 'custom') {
    const response = await fetchWebRequest(customWebToolRequest(normalized, config, environment))
    return response.rawText
  }
  const adapter = BUILT_IN_ADAPTERS[provider]
  if (!adapter) throw new Error(`Unsupported web tool provider: ${provider}`)
  const output = await adapter.execute(kind, normalized, environment)
  return serializeBoundedWebOutput(output)
}

export function webSourceIndex(text: string): string {
  const parsed = parseJsonObject(text)
  if (!parsed) return ''
  const results = asRecordArray(parsed['results'])
  const pages = asRecordArray(parsed['pages'])
  const sources = (results.length > 0 ? results : pages)
    .map((entry, index) => {
      const url = asString(entry['url'])
      if (!url) return ''
      const title = asString(entry['title'])
      return `${index + 1}. ${title ? `${title} — ` : ''}${url}`
    })
    .filter(Boolean)
  return sources.length > 0 ? `Sources:\n${sources.join('\n')}` : ''
}

function serializeBoundedWebOutput(output: WebSearchOutput | WebFetchOutput): string {
  const serialized = JSON.stringify(output, null, 2)
  if (serialized.length <= WEB_MAX_RESULT_TEXT) return serialized
  let lower = 0
  let upper = WEB_MAX_RESULT_TEXT
  let bounded = serializeWebOutputWithPerSourceLimit(output, lower)
  while (lower <= upper) {
    const candidateLimit = Math.floor((lower + upper) / 2)
    const candidate = serializeWebOutputWithPerSourceLimit(output, candidateLimit)
    if (candidate.length <= WEB_MAX_RESULT_TEXT) {
      bounded = candidate
      lower = candidateLimit + 1
    } else {
      upper = candidateLimit - 1
    }
  }
  return bounded
}

function serializeWebOutputWithPerSourceLimit(
  output: WebSearchOutput | WebFetchOutput,
  perSourceLimit: number
): string {
  if ('results' in output) {
    return JSON.stringify(
      {
        query: output.query,
        results: output.results.map((result) => {
          const description = result.description.slice(0, perSourceLimit)
          const contentAllowance = Math.max(0, perSourceLimit - description.length)
          return {
            ...result,
            description,
            ...(result.content ? { content: result.content.slice(0, contentAllowance) } : {})
          }
        })
      },
      null,
      2
    )
  }
  return JSON.stringify(
    {
      pages: output.pages.map((page) => ({
        ...page,
        content: page.content.slice(0, perSourceLimit)
      }))
    },
    null,
    2
  )
}

function customWebToolRequest(
  input: WebToolInput,
  config: WebUtilityConfig,
  environment: Record<string, string>
): WebToolRequest {
  if (!config.endpoint) throw new Error('Web utility endpoint is not configured')
  return {
    method: 'POST',
    endpoint: config.endpoint,
    headers: {
      'Content-Type': 'application/json',
      ...resolveEnvironmentReferences(config.headers ?? {}, environment)
    },
    body: input
  }
}

const exaAdapter: BuiltInWebToolAdapter = {
  async execute(kind, input, environment) {
    const headers = {
      'content-type': 'application/json',
      'x-api-key': requireEnvironment(environment, 'EXA_API_KEY', 'Exa')
    }
    if (kind === 'web_search') {
      const search = input as WebSearchInput
      const body: Record<string, unknown> = {
        query: search.query,
        numResults: search.count,
        contents: { text: { includeHtmlTags: false } },
        ...(search.country ? { country: search.country } : {}),
        ...(search.startDate ? { startPublishedDate: search.startDate } : {}),
        ...(search.endDate ? { endPublishedDate: search.endDate } : {})
      }
      const response = await fetchWebRequest({
        method: 'POST',
        endpoint: 'https://api.exa.ai/search',
        headers,
        body
      })
      return { query: search.query, results: exaSearchResults(response) }
    }
    const fetchInput = input as WebFetchInput
    const response = await fetchWebRequest({
      method: 'POST',
      endpoint: 'https://api.exa.ai/contents',
      headers,
      body: { urls: fetchInput.urls, type: 'text', text: { includeHtmlTags: false } }
    })
    return { pages: exaContentsPages(response) }
  }
}

const firecrawlAdapter: BuiltInWebToolAdapter = {
  async execute(kind, input, environment) {
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${requireEnvironment(environment, 'FIRECRAWL_API_KEY', 'Firecrawl')}`
    }
    if (kind === 'web_search') {
      const search = input as WebSearchInput
      const response = await fetchWebRequest({
        method: 'POST',
        endpoint: 'https://api.firecrawl.dev/v1/search',
        headers,
        body: { query: search.query, limit: search.count }
      })
      return { query: search.query, results: firecrawlSearchResults(response) }
    }
    const fetchInput = input as WebFetchInput
    const pages: WebFetchPage[] = []
    for (const url of fetchInput.urls) {
      const response = await fetchWebRequest({
        method: 'POST',
        endpoint: 'https://api.firecrawl.dev/v1/scrape',
        headers,
        body: { url, formats: firecrawlFormats(fetchInput.format) }
      })
      pages.push(firecrawlScrapePage(response, url))
    }
    return { pages }
  }
}

const braveAdapter: BuiltInWebToolAdapter = {
  async execute(kind, input, environment) {
    if (kind !== 'web_search') {
      throw new Error('The Brave web tool provider only supports search')
    }
    const search = input as WebSearchInput
    const query: Record<string, string> = {
      q: search.query,
      count: String(search.count),
      ...(search.country ? { country: search.country } : {}),
      ...(search.language ? { search_lang: search.language } : {})
    }
    const response = await fetchWebRequest({
      method: 'GET',
      endpoint: 'https://api.search.brave.com/res/v1/web/search',
      headers: {
        accept: 'application/json',
        'x-subscription-token': requireEnvironment(environment, 'BRAVE_API_KEY', 'Brave')
      },
      query
    })
    return { query: search.query, results: braveSearchResults(response) }
  }
}

const BUILT_IN_ADAPTERS: Record<Exclude<WebToolProviderId, 'custom'>, BuiltInWebToolAdapter> = {
  exa: exaAdapter,
  firecrawl: firecrawlAdapter,
  brave: braveAdapter
}

function exaSearchResults(response: WebToolResponse): WebSearchResult[] {
  const results = response.json ? asRecordArray(response.json['results']) : []
  return results.map((entry) => {
    const snippet = firstString(entry['highlights']) ?? asString(entry['text'])
    const text = asString(entry['text'])
    return {
      title: asString(entry['title']) ?? '',
      url: asString(entry['url']) ?? '',
      description: snippet ? snippet.slice(0, 1_000) : '',
      ...(asString(entry['publishedDate'])
        ? { publishedDate: asString(entry['publishedDate']) }
        : {}),
      ...(text ? { content: text } : {})
    }
  })
}

function exaContentsPages(response: WebToolResponse): WebFetchPage[] {
  const results = response.json ? asRecordArray(response.json['results']) : []
  return results.map((entry) => ({
    url: asString(entry['url']) ?? '',
    ...(asString(entry['title']) ? { title: asString(entry['title']) } : {}),
    content: asString(entry['text']) ?? '',
    statusCode: 200
  }))
}

function firecrawlSearchResults(response: WebToolResponse): WebSearchResult[] {
  const data = response.json ? asRecordArray(response.json['data']) : []
  return data.map((entry) => {
    const metadata = isRecord(entry['metadata']) ? entry['metadata'] : undefined
    const publishedDate =
      asString(entry['publishedDate']) ?? (metadata ? asString(metadata['date']) : undefined)
    return {
      title: asString(entry['title']) ?? '',
      url: asString(entry['url']) ?? '',
      description: asString(entry['description']) ?? '',
      ...(publishedDate ? { publishedDate } : {})
    }
  })
}

function firecrawlScrapePage(response: WebToolResponse, requestedUrl: string): WebFetchPage {
  const data = response.json && isRecord(response.json['data']) ? response.json['data'] : undefined
  const metadata = data && isRecord(data['metadata']) ? data['metadata'] : undefined
  const title = asString(metadata?.['title'])
  const rawStatusCode = metadata?.['statusCode']
  const statusCode = typeof rawStatusCode === 'number' ? rawStatusCode : undefined
  return {
    url: asString(metadata?.['url']) ?? requestedUrl,
    ...(title ? { title } : {}),
    content:
      asString(data?.['markdown']) ?? asString(data?.['text']) ?? asString(data?.['html']) ?? '',
    ...(statusCode !== undefined ? { statusCode } : {})
  }
}

function braveSearchResults(response: WebToolResponse): WebSearchResult[] {
  const web = response.json && isRecord(response.json['web']) ? response.json['web'] : undefined
  const results = web ? asRecordArray(web['results']) : []
  return results.map((entry) => {
    const publishedDate = asString(entry['published_date'])
    return {
      title: asString(entry['title']) ?? '',
      url: asString(entry['url']) ?? '',
      description: asString(entry['description']) ?? '',
      ...(publishedDate ? { publishedDate } : {})
    }
  })
}

function firecrawlFormats(format: WebToolFormat): string[] {
  return format === 'html' ? ['html'] : ['markdown']
}

function parseWebToolInput(kind: WebToolKind, value: unknown): WebToolInput {
  if (!isRecord(value)) throw new TypeError('Web tool input must be an object')
  if (kind === 'web_search') {
    rejectUnknownKeys(value, kind, [
      'query',
      'count',
      'country',
      'language',
      'startDate',
      'endDate'
    ])
    return {
      query: requiredString(value['query'], 'query', 500),
      count: optionalBoundedNumber(value['count'], 1, 20, 5),
      ...(optionalCode(value['country'], 'country', 2)
        ? { country: optionalCode(value['country'], 'country', 2) }
        : {}),
      ...(optionalCode(value['language'], 'language', 2)
        ? { language: optionalCode(value['language'], 'language', 2) }
        : {}),
      ...(optionalDate(value['startDate'], 'startDate')
        ? { startDate: optionalDate(value['startDate'], 'startDate') }
        : {}),
      ...(optionalDate(value['endDate'], 'endDate')
        ? { endDate: optionalDate(value['endDate'], 'endDate') }
        : {})
    }
  }
  rejectUnknownKeys(value, kind, ['urls', 'format'])
  return {
    urls: requiredUrlArray(value['urls'], WEB_MAX_URLS),
    format: optionalFormat(value['format'])
  }
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  kind: WebToolKind,
  allowed: readonly string[]
): void {
  const allowedKeys = new Set(allowed)
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key))
  if (unknown.length > 0) {
    throw new TypeError(`Web tool ${kind} input contains unsupported fields: ${unknown.join(', ')}`)
  }
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new TypeError(`Web tool input "${label}" must be a non-empty string`)
  }
  return value.trim()
}

function optionalBoundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('Web tool input "count" must be a number')
  }
  return Math.min(Math.max(value, minimum), maximum)
}

function optionalCode(value: unknown, label: string, length: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new TypeError(`Web tool input "${label}" must be a ${length}-character code`)
  }
  const text = value.trim()
  if (text.length !== length) {
    throw new TypeError(`Web tool input "${label}" must be a ${length}-character code`)
  }
  return text
}

function optionalDate(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 64 || value.includes('\0')) {
    throw new TypeError(`Web tool input "${label}" must be an ISO 8601 date string`)
  }
  const text = value.trim()
  if (!text) throw new TypeError(`Web tool input "${label}" must be an ISO 8601 date string`)
  return text
}

function optionalFormat(value: unknown): WebToolFormat {
  if (value === undefined) return 'markdown'
  if (typeof value !== 'string' || (value !== 'markdown' && value !== 'text' && value !== 'html')) {
    throw new TypeError('Web tool input "format" must be one of: markdown, text, html')
  }
  return value
}

function requiredUrlArray(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new TypeError(`Web tool input "urls" must contain between 1 and ${maximum} URLs`)
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new TypeError(`Web tool input "urls[${index}]" must be a URL string`)
    }
    const url = entry.trim()
    if (!url || url.length > 2_000 || url.includes('\0')) {
      throw new TypeError(`Web tool input "urls[${index}]" is invalid`)
    }
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('unsupported protocol')
      }
    } catch {
      throw new TypeError(`Web tool input "urls[${index}]" must be an absolute http(s) URL`)
    }
    return url
  })
}

async function fetchWebRequest(request: WebToolRequest): Promise<WebToolResponse> {
  const endpoint = request.query
    ? `${request.endpoint}?${new URLSearchParams(request.query).toString()}`
    : request.endpoint
  const response = await fetch(endpoint, {
    method: request.method,
    headers: request.headers,
    ...(request.method === 'POST' ? { body: JSON.stringify(request.body ?? {}) } : {}),
    signal: AbortSignal.timeout(WEB_TIMEOUT_MS)
  })
  const rawText = (await response.text()).slice(0, WEB_MAX_RESULT_TEXT)
  if (!response.ok) {
    throw new Error(`Web utility failed (${response.status}): ${rawText}`)
  }
  return { rawText, json: parseJsonObject(rawText) }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function requireEnvironment(
  environment: Record<string, string>,
  variable: string,
  label: string
): string {
  const value = environment[variable]
  if (!value) throw new Error(`${label} API key is not configured (${variable})`)
  return value
}

function resolveEnvironmentReferences(
  values: Record<string, string>,
  environment: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_, name: string) => {
        const resolved = environment[name]
        if (resolved === undefined)
          throw new Error(`Credential environment is unavailable: ${name}`)
        return resolved
      })
    ])
  )
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const first = value[0]
    return typeof first === 'string' && first ? first : undefined
  }
  return undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
