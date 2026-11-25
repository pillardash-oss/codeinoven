/**
 * The tiny HTTP contract shared by an Oven's utility host and a turn's relay.
 *
 * Both ends are loopback servers that speak JSON in, JSON out, and both settle a
 * call with the same envelope, so the wire shape lives here once instead of
 * being restated on each side:
 *
 *     request   -> the call input, as JSON
 *     answer    -> { ok: true, value } | { ok: false, error }
 *
 * The host's own routes and a relay's ask listener use this module verbatim, so
 * a call forwarded through a relay is the same envelope the client reads back
 * from the host. Nothing here imports Electron or SvelteKit: the service bundle
 * carries it to the Oven.
 */
import {
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import type { OvenUtilityJson } from '../../../lib/oven-utility-host'

/**
 * Most one call body or one call answer may carry.
 *
 * A forwarded call is a tool input (an invocation, a batch of inputs, a
 * diagnostics query), never a file, so this bound only exists to stop a broken
 * client from making the host buffer without limit.
 */
export const OVEN_UTILITY_MAX_BODY_BYTES = 4 * 1024 * 1024

/** What a host route and a relay listener answer one call with. */
export type OvenUtilityEnvelope =
  { ok: true; value: OvenUtilityJson } | { ok: false; error: string }

/**
 * One failure that already knows the status code it deserves.
 *
 * The host answers auth, grant, and routing failures with a real HTTP status as
 * well as the envelope, because "not your turn" and "the tool failed" are
 * different things to whoever reads the client's logs.
 */
export class OvenUtilityHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'OvenUtilityHttpError'
  }
}

/** Read any JSON value off the wire, or null when it is not an envelope. */
export function ovenUtilityEnvelope(value: unknown): OvenUtilityEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record['ok'] === true)
    return { ok: true, value: (record['value'] ?? null) as OvenUtilityJson }
  if (record['ok'] === false) {
    const error = record['error']
    return {
      ok: false,
      error: typeof error === 'string' && error.length > 0 ? error : 'The call failed.'
    }
  }
  return null
}

/** Answer one HTTP request with an envelope. */
export function sendOvenUtilityEnvelope(
  response: ServerResponse,
  status: number,
  envelope: OvenUtilityEnvelope
): void {
  const body = JSON.stringify(envelope)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  })
  response.end(body)
}

/**
 * The JSON body of one request.
 *
 * `undefined` means the caller sent no body at all, which a few routes allow and
 * every other route rejects through its own validation.
 */
export async function readOvenUtilityJson(
  request: IncomingMessage
): Promise<OvenUtilityJson | undefined> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += buffer.byteLength
    if (bytes > OVEN_UTILITY_MAX_BODY_BYTES)
      throw new OvenUtilityHttpError(413, 'The call body exceeds its size limit.')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return undefined
  try {
    return JSON.parse(text) as OvenUtilityJson
  } catch {
    throw new OvenUtilityHttpError(400, 'The call body is not valid JSON.')
  }
}

export interface OvenUtilityPostOptions {
  /** `DELETE` carries a body too: retiring a turn names it. */
  method?: 'POST' | 'DELETE'
  /** Bearer the receiver requires, when it requires one. */
  token?: string
  timeoutMs: number
}

export interface OvenUtilityPostResult {
  status: number
  /** null when the receiver answered something that is not an envelope. */
  envelope: OvenUtilityEnvelope | null
}

/**
 * POST (or DELETE) one JSON body to a loopback endpoint and read its envelope.
 *
 * The body is typed `unknown` because it is serialized, not inspected: a turn
 * crosses this way and is a fixed interface rather than an open JSON value.
 *
 * A network failure is thrown; an answered request, whatever its status, is
 * returned so the caller can report the other side's own words instead of a
 * generic "the call failed".
 */
export async function postOvenUtilityJson(
  url: string,
  body: unknown,
  options: OvenUtilityPostOptions
): Promise<OvenUtilityPostResult> {
  const target = new URL(url)
  const payload = Buffer.from(JSON.stringify(body))
  return await new Promise<OvenUtilityPostResult>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port.length > 0 ? Number(target.port) : 80,
        path: `${target.pathname}${target.search}`,
        method: options.method ?? 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': payload.byteLength,
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
        },
        timeout: options.timeoutMs
      },
      (response) => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength
          if (bytes > OVEN_UTILITY_MAX_BODY_BYTES) {
            request.destroy(new Error('The answer exceeds its size limit.'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8').trim()
          let envelope: OvenUtilityEnvelope | null
          try {
            envelope = text ? ovenUtilityEnvelope(JSON.parse(text) as unknown) : null
          } catch {
            envelope = null
          }
          resolve({ status: response.statusCode ?? 0, envelope })
        })
      }
    )
    request.on('timeout', () =>
      request.destroy(new Error(`No answer from ${target.origin} in time.`))
    )
    request.on('error', reject)
    request.end(payload)
  })
}

/**
 * Stop listening at once, including any connection a caller left open.
 *
 * `server.close()` alone waits for idle keep-alive sockets to time out, which
 * would keep a relay alive long after its turn is over.
 */
export async function closeOvenUtilityServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

/** The loopback base URL of a host or relay listener on one port. */
export function ovenUtilityUrl(port: number): string {
  return `http://127.0.0.1:${port}`
}

/** Parse one request pathname without trusting the request line. */
export function ovenUtilityPath(url: string | undefined): string {
  try {
    return new URL(url ?? '/', 'http://127.0.0.1').pathname
  } catch {
    throw new OvenUtilityHttpError(400, 'The request path is not valid.')
  }
}
