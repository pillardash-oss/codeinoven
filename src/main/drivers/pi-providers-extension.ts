import type { BaseUrlProvider } from '../../lib/types'

/**
 * Build an ephemeral Pi extension that registers every enabled custom base-URL
 * provider via `pi.registerProvider(...)`. Loaded through the per-turn runtime
 * overlay's `--extension` flag, so the user's real `~/.pi` config is never
 * touched and the providers stay visible to `pi --list-models`.
 *
 * Keys are referenced as `$ENV_VAR` (resolved by Pi at request time) and
 * injected on the spawned process environment by the driver; keyless local
 * servers get a literal dummy so their models remain selectable.
 */
export function piCustomProvidersExtension(providers: BaseUrlProvider[]): string {
  const registrations = providers
    .map((provider) => {
      const apiKey =
        provider.apiKeyRef && provider.apiKeyEnvVar
          ? `apiKey: ${json(envRef(provider.apiKeyEnvVar))},`
          : 'apiKey: "local",'
      const api =
        provider.npm === '@ai-sdk/openai'
          ? 'openai-responses'
          : provider.npm === '@ai-sdk/anthropic'
            ? 'anthropic-messages'
            : 'openai-completions'
      const headers = provider.headers ? `headers: ${json(provider.headers)},\n    ` : ''
      const models = provider.models
        .map((model) => {
          const fields: Record<string, unknown> = {
            id: model.id,
            name: model.name || model.id,
            reasoning: model.reasoning,
            // Unset `vision` is treated as capable everywhere else in this
            // codebase — this was hardcoded to text-only regardless, silently
            // dropping image attachments for every vision-capable model.
            input: model.vision === false ? ['text'] : ['text', 'image'],
            contextWindow: model.contextWindow ?? 128000,
            maxTokens: model.maxOutputTokens ?? 16384,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          }
          return `      ${json(fields)}`
        })
        .join(',\n')
      return `  pi.registerProvider(${json(provider.id)}, {
    name: ${json(provider.name)},
    baseUrl: ${json(provider.baseURL)},
    ${apiKey}
    api: ${json(api)},
    ${headers}models: [
${models}
    ]
  })`
    })
    .join('\n\n')
  return `import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function codeInOvenProviders(pi: ExtensionAPI): void {
${registrations}
}
`
}

/** Deterministic env var name carrying a provider's resolved API key. */
function envRef(apiKeyEnvVar: string): string {
  return apiKeyEnvVar.replace(/[^a-zA-Z0-9]/gu, '_')
}

function json(value: unknown): string {
  return JSON.stringify(value)
}
