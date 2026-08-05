import type { ThinkingLevel } from './types'

/** Versioned clipboard envelopes for copying custom base-URL models/providers. */

export const PROVIDER_CLIPBOARD_KIND = 'codeinoven.customBaseUrlProvider'
export const MODEL_CLIPBOARD_KIND = 'codeinoven.customBaseUrlModel'
export const CLIPBOARD_VERSION = 1

/** Draft-style model fields, matching the BaseUrlProviderEditor form. */
export interface BaseUrlProviderModelClipboardData {
  id: string
  name: string
  contextWindow: string
  maxOutputTokens: string
  reasoning: boolean
  defaultThinkingLevel: ThinkingLevel | ''
}

/** Draft-style provider fields, matching the BaseUrlProviderEditor form. */
export interface BaseUrlProviderClipboardData {
  harnessId: string
  npm: string
  name: string
  baseURL: string
  apiKey: string
  headers: string
  models: BaseUrlProviderModelClipboardData[]
  enabled: boolean
}

interface ModelEnvelope {
  codeinoven: typeof MODEL_CLIPBOARD_KIND
  version: typeof CLIPBOARD_VERSION
  model: BaseUrlProviderModelClipboardData
}

interface ProviderEnvelope {
  codeinoven: typeof PROVIDER_CLIPBOARD_KIND
  version: typeof CLIPBOARD_VERSION
  provider: BaseUrlProviderClipboardData
}

export function serializeModelClipboard(model: BaseUrlProviderModelClipboardData): string {
  const envelope: ModelEnvelope = {
    codeinoven: MODEL_CLIPBOARD_KIND,
    version: CLIPBOARD_VERSION,
    model
  }
  return JSON.stringify(envelope)
}

export function serializeProviderClipboard(provider: BaseUrlProviderClipboardData): string {
  const envelope: ProviderEnvelope = {
    codeinoven: PROVIDER_CLIPBOARD_KIND,
    version: CLIPBOARD_VERSION,
    provider
  }
  return JSON.stringify(envelope)
}

/** Parse a copied model from clipboard text. Throws on malformed/foreign content. */
export function parseModelClipboard(text: string): BaseUrlProviderModelClipboardData {
  const raw = parseEnvelope<BaseUrlProviderModelClipboardData>(text, MODEL_CLIPBOARD_KIND, 'model')
  return parseModel(raw)
}

/** Parse a copied provider from clipboard text. Throws on malformed/foreign content. */
export function parseProviderClipboard(text: string): BaseUrlProviderClipboardData {
  const raw = parseEnvelope<BaseUrlProviderClipboardData>(text, PROVIDER_CLIPBOARD_KIND, 'provider')
  return parseProvider(raw)
}

function parseEnvelope<T>(text: string, kind: string, dataKey: string): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new TypeError('The clipboard does not contain a copied item.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('The clipboard does not contain a copied item.')
  }
  const envelope = parsed as Record<string, unknown>
  if (envelope['codeinoven'] !== kind || envelope['version'] !== CLIPBOARD_VERSION) {
    throw new TypeError('The clipboard does not contain a copied item from this app.')
  }
  if (typeof envelope[dataKey] !== 'object' || envelope[dataKey] === null) {
    throw new TypeError('The copied item is missing its contents.')
  }
  return envelope[dataKey] as T
}

function parseModel(raw: unknown): BaseUrlProviderModelClipboardData {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('The copied model is malformed.')
  }
  const model = raw as Record<string, unknown>
  return {
    id: requiredString(model['id'], 'model ID'),
    name: requiredString(model['name'], 'model name'),
    contextWindow: optionalString(model['contextWindow']),
    maxOutputTokens: optionalString(model['maxOutputTokens']),
    reasoning: model['reasoning'] === true,
    defaultThinkingLevel: thinkingLevel(model['defaultThinkingLevel'])
  }
}

function parseProvider(raw: unknown): BaseUrlProviderClipboardData {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('The copied provider is malformed.')
  }
  const provider = raw as Record<string, unknown>
  if (!Array.isArray(provider['models'])) {
    throw new TypeError('The copied provider is missing its models.')
  }
  return {
    harnessId: requiredString(provider['harnessId'], 'provider harness'),
    npm: requiredString(provider['npm'], 'provider SDK package'),
    name: requiredString(provider['name'], 'provider name'),
    baseURL: requiredString(provider['baseURL'], 'provider base URL'),
    apiKey: optionalString(provider['apiKey']),
    headers: optionalString(provider['headers']),
    models: provider['models'].map(parseModel),
    enabled: provider['enabled'] !== false
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`The copied item is missing its ${label}.`)
  }
  return value
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
]

function thinkingLevel(value: unknown): ThinkingLevel | '' {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : ''
}
