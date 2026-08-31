/**
 * Generated TypeScript source for the app-owned Pi usage extension.
 *
 * The PiDriver launches `pi --mode rpc --extension <this file>` for every
 * session. The extension subscribes to `after_provider_response` — fired with
 * the raw HTTP response headers of every provider call — extracts the known
 * rate-limit/quota header families, and forwards them to the driver through
 * `ctx.ui.setStatus(key, JSON)`, the same fire-and-forget
 * `extension_ui_request` channel the status extension uses. `PiRpcClient`
 * surfaces those records so the driver can map them into display-ready
 * `AgentRateLimitWindow[]` usage bars (5-hour/7-day subscription windows,
 * per-minute request/token buckets). The extension is inert outside RPC mode:
 * a footer status entry is harmless in the TUI.
 *
 * Every payload is prefixed with the app marker so the driver can ignore
 * `setStatus` entries from the user's own extensions.
 */

export const PI_USAGE_EXTENSION_KEY = 'codeinoven-usage'

/** Rate-limit headers forwarded to the driver, grouped by family. */
export const PI_RATE_LIMIT_HEADERS: readonly string[] = [
  // Anthropic subscription (Claude Pro/Max) unified quota windows.
  'anthropic-ratelimit-unified-5h-remaining',
  'anthropic-ratelimit-unified-5h-limit',
  'anthropic-ratelimit-unified-5h-reset',
  'anthropic-ratelimit-unified-5h-status',
  'anthropic-ratelimit-unified-7d-remaining',
  'anthropic-ratelimit-unified-7d-limit',
  'anthropic-ratelimit-unified-7d-reset',
  'anthropic-ratelimit-unified-7d-status',
  'anthropic-ratelimit-unified-overage-status',
  'anthropic-ratelimit-unified-overage-disabled-reason',
  // Anthropic per-request / per-token buckets.
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-input-tokens-remaining',
  'anthropic-ratelimit-input-tokens-limit',
  'anthropic-ratelimit-input-tokens-reset',
  // OpenAI / OpenAI-compatible (OpenRouter, base-URL providers).
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-tokens'
]

export function piUsageExtension(): string {
  return `import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const KEY = '${PI_USAGE_EXTENSION_KEY}'
const HEADERS = new Set(${JSON.stringify(PI_RATE_LIMIT_HEADERS)})

export default function (pi: ExtensionAPI) {
  pi.on('after_provider_response', (event, ctx) => {
    const headers = event?.headers
    if (!headers || typeof headers !== 'object') return
    const picked: Record<string, string> = {}
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase()
      if (!HEADERS.has(lower)) continue
      if (typeof value === 'string' && value.length > 0) picked[lower] = value
    }
    if (Object.keys(picked).length === 0) return
    const model = ctx?.model
    const payload = JSON.stringify({
      provider: typeof model?.provider === 'string' ? model.provider : undefined,
      model: typeof model?.id === 'string' ? model.id : undefined,
      headers: picked
    })
    ctx?.ui?.setStatus(KEY, payload)
  })
}
`
}
