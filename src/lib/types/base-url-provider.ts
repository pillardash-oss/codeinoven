import type { ThinkingLevel } from './common'
import type { ThinkingPreset } from './agent'

/**
 * How CodeInOven reads a custom provider's usage route.
 *
 * `auto` walks whatever JSON the endpoint returns and maps every object that
 * looks like a quota. The named formats are presets for providers whose
 * response shape is idiosyncratic; each one falls back to `auto` when it
 * recognizes nothing, so a wrong pick degrades instead of showing no bars.
 */
export type BaseUrlProviderUsageFormat =
  'auto' | 'openai' | 'new-api' | 'command-code' | 'open-design' | 'zai' | 'kimi'

/** A model exposed by a custom base-URL provider. */
export interface BaseUrlProviderModel {
  id: string
  /** Owning provider, used to resolve env vars and context. */
  providerId: string
  name: string
  /** Maximum tokens the model accepts in its context window. */
  contextWindow?: number
  /** Maximum tokens the model can generate in one response. */
  maxOutputTokens?: number
  /** Whether the model supports reasoning/thinking. */
  reasoning: boolean
  /** Thinking presets this model supports. When absent or empty, thinking controls are hidden. */
  thinkingPresets?: ThinkingPreset[]
  /** Default thinking level applied when this model is first selected. */
  defaultThinkingLevel?: ThinkingLevel
  /** Whether the model can see images. Unspecified is treated as vision-capable
   *  so a custom model is never wrongly hidden or gated. */
  vision?: boolean
}

/** A custom provider defined by base URL, stored and vaulted by CodeInOven. */
export interface BaseUrlProvider {
  id: string
  /** Harness this provider applies to (e.g. 'opencode'). */
  harnessId: string
  /** AI SDK npm package to use (e.g. '@ai-sdk/openai-compatible', '@ai-sdk/openai', or '@ai-sdk/anthropic'). */
  npm: string
  /** Display name shown in the model picker. */
  name: string
  /** API endpoint URL. */
  baseURL: string
  /** Opaque SecretVault reference for the API key, when set. */
  apiKeyRef?: string
  /** Deterministic environment variable name that carries the resolved API key. */
  apiKeyEnvVar?: string
  /** Whether a harness-native provider has an API key configured, without exposing its value. */
  apiKeyConfigured?: boolean
  /** Custom HTTP headers sent with each request. */
  headers?: Record<string, string>
  /** Models this provider exposes. */
  models: BaseUrlProviderModel[]
  /**
   * Optional usage route, relative to `baseURL` (e.g. `/status`, `/usage`) or an
   * absolute URL with a query string. Providers backed by a subscription often
   * expose one; when set, CodeInOven reads it for the quota windows shown on the
   * battery hover and the Accounts table. Empty means the provider reports no
   * usage.
   */
  usagePath?: string
  /**
   * Response format of `usagePath`. Omitted means `auto`.
   */
  usageFormat?: BaseUrlProviderUsageFormat
  /**
   * Optional model-list route relative to `baseURL` (defaults to `/models`) or
   * an absolute URL. Used when discovering/refreshing this provider's models.
   */
  modelsPath?: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** Renderer-safe create request. Plaintext API key is vaulted by main before persistence. */
export interface BaseUrlProviderCreateRequest {
  harnessId: string
  npm: string
  name: string
  baseURL: string
  /** Plaintext API key; vaulted by main. Omit when the provider needs no key. */
  apiKey?: string
  headers?: Record<string, string>
  models: Array<Omit<BaseUrlProviderModel, 'id' | 'providerId'> & { id?: string }>
  /** Optional usage route relative to `baseURL`, or an absolute URL. */
  usagePath?: string
  /** Response format of `usagePath`; omitted means `auto`. */
  usageFormat?: BaseUrlProviderUsageFormat
  /** Optional model-list route relative to `baseURL` (default `/models`), or an absolute URL. */
  modelsPath?: string
  enabled?: boolean
  /**
   * Reuse this id instead of generating one. Lets the renderer link the same
   * logical provider across multiple harnesses: every record sharing an id
   * (regardless of harnessId) is treated as one linked provider.
   */
  id?: string
}

/** Renderer-safe update request. Omitted API key retains the current value. */
export interface BaseUrlProviderUpdateRequest {
  npm?: string
  name?: string
  baseURL?: string
  /** Plaintext API key; vaulted by main. Omit to keep the existing key. */
  apiKey?: string
  /** When true, removes the stored API key reference. */
  removeApiKey?: boolean
  headers?: Record<string, string>
  models?: Array<Omit<BaseUrlProviderModel, 'id' | 'providerId'> & { id?: string }>
  /** Optional usage route; empty string clears it. */
  usagePath?: string
  /** Response format of `usagePath`; empty string clears it (falls back to `auto`). */
  usageFormat?: BaseUrlProviderUsageFormat | ''
  /** Optional model-list route; empty string clears it (falls back to `/models`). */
  modelsPath?: string
  enabled?: boolean
}

/** Draft-shaped provider payload used to copy a custom provider to the clipboard.
 *  The API key is resolved from the vault in main when an existing `id` is given. */
export interface BaseUrlProviderCopyClipboardRequest {
  harnessId: string
  /** Existing provider id; main resolves the stored key when `apiKey` is empty. */
  id?: string
  npm: string
  name: string
  baseURL: string
  apiKey?: string
  headers?: string
  /** Usage route carried through copy/paste. */
  usagePath?: string
  /** Usage response format carried through copy/paste; empty means auto. */
  usageFormat?: BaseUrlProviderUsageFormat | ''
  /** Model-list route carried through copy/paste. */
  modelsPath?: string
  models: Array<{
    id: string
    name: string
    contextWindow: string
    maxOutputTokens: string
    reasoning: boolean
    defaultThinkingLevel: ThinkingLevel | ''
  }>
  enabled: boolean
}

/** Request to discover models from `${baseURL}/models`. Pass `harnessId`+`id`
 *  for a saved provider so main can resolve its vaulted API key when `apiKey`
 *  is omitted; set `force` to bypass the 24h cache. */
export interface BaseUrlProviderFetchModelsRequest {
  harnessId?: string
  id?: string
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
  /** Model-list route override; omitted resolves the provider's saved route (default `/models`). */
  modelsPath?: string
  force?: boolean
}

/** Request to read a usage route while the provider is still a draft. Pass
 *  `harnessId`+`id` for a saved provider so main can resolve its vaulted API key
 *  when `apiKey` is omitted. */
export interface BaseUrlProviderUsagePreviewRequest {
  harnessId?: string
  id?: string
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
  usagePath: string
  usageFormat?: BaseUrlProviderUsageFormat
}

/** Result of a draft usage preview. `usage` is null when the route answered no
 *  recognizable quota; `message` explains why so the editor can show it. */
export interface BaseUrlProviderUsagePreview {
  usage: import('./usage').CustomProviderUsage | null
  message?: string
}

/** A model entry discovered from an OpenAI-compatible `/models` endpoint. */
export interface DiscoveredBaseUrlModel {
  id: string
  name: string
  /** Context window in tokens, when the endpoint reports one (e.g. `context_length`). */
  contextWindow?: number
}
