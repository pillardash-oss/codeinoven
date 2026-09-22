import type { OpenCodeV2Endpoint } from './opencode-v2-server'

/** Per-request ceiling for one discovery read. */
export const OPENCODE_V2_REQUEST_TIMEOUT_MS = 10_000

/** Basic-auth user OpenCode V2 expects; the password is the server password. */
const BASIC_AUTH_USER = 'opencode'

/**
 * Read one JSON document from a private OpenCode V2 server.
 *
 * Every discovery read uses HTTP Basic auth (`opencode:<server password>`).
 * The password is only ever used to build the auth header; it is never logged
 * and never leaves this module.
 */
export async function fetchOpenCodeV2Json(
  endpoint: OpenCodeV2Endpoint,
  path: string,
  timeoutMs = OPENCODE_V2_REQUEST_TIMEOUT_MS
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const credentials = Buffer.from(`${BASIC_AUTH_USER}:${endpoint.password}`).toString('base64')
    const response = await fetch(new URL(path, endpoint.baseUrl), {
      headers: { authorization: `Basic ${credentials}`, accept: 'application/json' },
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`OpenCode V2 ${path} responded with HTTP ${response.status}`)
    }
    return (await response.json()) as unknown
  } finally {
    clearTimeout(timer)
  }
}
