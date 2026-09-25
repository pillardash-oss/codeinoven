import type { OpenCodeV2Endpoint } from './opencode-v2-server'

/** Per-request ceiling for one read. */
export const OPENCODE_V2_REQUEST_TIMEOUT_MS = 15_000
/** Basic-auth user OpenCode V2 expects; the password is the server password. */
const BASIC_AUTH_USER = 'opencode'

/** One SDK-shaped error response: `{_tag, message, ...}` with an HTTP status. */
export class OpenCodeV2RequestError extends Error {
  constructor(
    readonly status: number,
    readonly tag: string | undefined,
    message: string
  ) {
    super(message)
    this.name = 'OpenCodeV2RequestError'
  }
}

/** Narrow an unknown JSON value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Read the `_tag` discriminator (V2 errors) or `name` (WorktreeError) of a body. */
function errorTag(body: Record<string, unknown> | null): string | undefined {
  const tag = body?.['_tag'] ?? body?.['name']
  return typeof tag === 'string' ? tag : undefined
}

/**
 * HTTP client for one running OpenCode V2 server.
 *
 * Every `/api/*` route requires HTTP Basic auth (`opencode:<server password>`),
 * including the event stream. The password is only ever used to build the auth
 * header: it is never logged and never leaves this module.
 */
export class OpenCodeV2Client {
  constructor(private readonly endpoint: OpenCodeV2Endpoint) {}

  get baseUrl(): string {
    return this.endpoint.baseUrl
  }

  /** Build a location-scoped query so catalog reads match the project asked for. */
  locationQuery(directory: string): string {
    return new URLSearchParams({ 'location[directory]': directory }).toString()
  }

  private headers(headers?: Record<string, string>): Record<string, string> {
    const credentials = Buffer.from(`${BASIC_AUTH_USER}:${this.endpoint.password}`).toString(
      'base64'
    )
    return { authorization: `Basic ${credentials}`, ...headers }
  }

  /** Issue one authenticated request. The caller owns the response body. */
  async request(
    path: string,
    init: {
      method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
      body?: unknown
      /** `0` disables the timeout entirely, for a long-lived stream. */
      timeoutMs?: number
      signal?: AbortSignal
      accept?: string
    } = {}
  ): Promise<Response> {
    const controller = new AbortController()
    const timeout = init.timeoutMs ?? OPENCODE_V2_REQUEST_TIMEOUT_MS
    const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null
    const onOuterAbort = (): void => controller.abort()
    init.signal?.addEventListener('abort', onOuterAbort, { once: true })
    try {
      const response = await fetch(new URL(path, this.endpoint.baseUrl), {
        method: init.method ?? 'GET',
        headers: this.headers({
          accept: init.accept ?? 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' })
        }),
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal
      })
      return response
    } finally {
      if (timer) clearTimeout(timer)
      init.signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  /**
   * Issue one authenticated request and decode its JSON body, throwing a typed
   * error for any non-2xx response. A bodyless success decodes to `undefined`.
   */
  async json<T>(path: string, init: Parameters<OpenCodeV2Client['request']>[1] = {}): Promise<T> {
    const response = await this.request(path, init)
    if (!response.ok) throw await OpenCodeV2Client.errorFromResponse(response, path)
    if (response.status === 204) return undefined as T
    const text = await response.text()
    if (text.trim().length === 0) return undefined as T
    return JSON.parse(text) as T
  }

  /** Read a response body into the structured error V2 failed requests carry. */
  static async errorFromResponse(
    response: Response,
    path: string
  ): Promise<OpenCodeV2RequestError> {
    // A 401 (and any other empty-bodied failure) must not be parsed: V2 sends
    // no body at all for an unauthenticated request.
    const text = await response.text().catch(() => '')
    let body: Record<string, unknown> | null = null
    if (text.trim().length > 0) {
      try {
        body = asRecord(JSON.parse(text) as unknown)
      } catch {
        body = null
      }
    }
    const message =
      (typeof body?.['message'] === 'string' ? body['message'] : undefined) ??
      (text.trim().length > 0 ? text.trim().slice(0, 500) : `${path} failed`)
    return new OpenCodeV2RequestError(response.status, errorTag(body), message)
  }
}

/** One parsed SSE frame already decoded from its `data:` envelope. */
export interface OpenCodeV2SseEvent {
  /** Event name, e.g. `session.text.delta`. */
  type: string
  /** Event payload. Never `null`: an absent payload decodes to `{}`. */
  data: Record<string, unknown>
  /** Full envelope, for fields the mapper does not model (`durable`, `location`). */
  envelope: Record<string, unknown>
}

/**
 * Split a raw SSE buffer into complete `data:` frames plus the leftover tail.
 *
 * V2 frames are `data: <one-line JSON>\n\n` with `: heartbeat` comments in
 * between; there is no `event:` or `id:` line. A frame that is not the last one
 * in the buffer is complete by definition, so a partial tail is returned
 * untouched for the next read.
 */
export function splitOpenCodeV2SseBuffer(buffer: string): {
  frames: string[]
  rest: string
} {
  const frames: string[] = []
  let rest = buffer
  for (;;) {
    const separator = rest.indexOf('\n\n')
    if (separator === -1) break
    frames.push(rest.slice(0, separator))
    rest = rest.slice(separator + 2)
  }
  return { frames, rest }
}

/** Decode one complete SSE frame into an event, or `null` for comments/blanks. */
export function parseOpenCodeV2SseFrame(frame: string): OpenCodeV2SseEvent | null {
  const payload = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('')
  if (payload.length === 0) return null
  let envelope: unknown
  try {
    envelope = JSON.parse(payload) as unknown
  } catch {
    return null
  }
  const record = asRecord(envelope)
  const type = record?.['type']
  if (!record || typeof type !== 'string') return null
  return { type, data: asRecord(record['data']) ?? {}, envelope: record }
}
