/**
 * The base URL a harness needs for the SDK its provider entry names.
 *
 * The provider editor stores one URL per provider, and every URL is written the
 * way the app's own discovery reads it: `<host>/v1`, because model discovery asks
 * for `<base>/models`. The SDKs do not agree on that shape, so the harness entry
 * cannot simply carry the same string.
 *
 * Measured against the bundled Pi harness, with `baseUrl` set to
 * `http://127.0.0.1:9401/v1`:
 *
 * - `openai-completions` posts `/v1/chat/completions`, and `openai-responses`
 *   posts `/v1/responses`, so both take the stored URL unchanged.
 * - `anthropic-messages` posts `/v1/messages` relative to the base, so the stored
 *   URL makes it post `/v1/v1/messages`, which every local server answers with 404.
 *
 * That last case is what this function exists for: the Anthropic SDK's own
 * convention is a base URL with no version segment.
 */
const ANTHROPIC_NPM = '@ai-sdk/anthropic'

/** A base URL without the trailing slashes that would double a joined path. */
function trimmedBaseUrl(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/u, '')
}

/**
 * The URL to write into a harness's own provider config, for the SDK it will use.
 *
 * Only the Anthropic SDK needs a different shape; everything else is the stored
 * URL with its trailing slashes removed, which is the same request either way.
 */
export function harnessBaseUrl(baseURL: string, npm: string): string {
  const trimmed = trimmedBaseUrl(baseURL)
  if (npm !== ANTHROPIC_NPM) return trimmed
  return trimmed.replace(/\/v1$/iu, '')
}
