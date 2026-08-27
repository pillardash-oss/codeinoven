import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bundledPiVendorDir } from '../drivers/harness-runtime'

/**
 * Headless drivers for the OAuth providers Pi supports, reusing the exact flow
 * implementations the pinned `@earendil-works/pi-ai` ships (browser URL,
 * device codes, PKCE exchanges) so an in-app login produces credentials byte-
 * compatible with what Pi's own TUI writes.
 *
 * The library is resolved from dev node_modules first, then from the vendored
 * copy shipped next to the bundled Pi harness — the packaged app does not
 * contain pi-ai in its own node_modules.
 */

/** Events surfaced to the UI while a login flow runs. */
export type PiOAuthEvent =
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string }
  | { type: 'progress'; message: string }
  | { type: 'info'; message: string }

/** A question the flow needs answered before it can continue. */
export interface PiOAuthPrompt {
  type: 'text' | 'secret' | 'select' | 'manual_code'
  message: string
  placeholder?: string
  options?: Array<{ id: string; label: string }>
}

export interface PiOAuthHandlers {
  onEvent(event: PiOAuthEvent): void
  prompt(prompt: PiOAuthPrompt): Promise<string>
  signal: AbortSignal
}

export type PiOAuthCredential = Record<string, unknown> & { type: 'oauth' }

interface OAuthFlow {
  name: string
  login(interaction: {
    signal: AbortSignal
    prompt(prompt: unknown): Promise<string>
    notify(event: unknown): void
  }): Promise<PiOAuthCredential>
}

interface LoaderModule {
  loadAnthropicOAuth(): Promise<OAuthFlow>
  loadOpenAICodexOAuth(): Promise<OAuthFlow>
  loadGitHubCopilotOAuth(): Promise<OAuthFlow>
  loadOpenRouterOAuth(): Promise<OAuthFlow>
  loadKimiCodingOAuth(): Promise<OAuthFlow>
  loadXaiOAuth(): Promise<OAuthFlow>
}

/** Catalog provider id → headless OAuth flow loader name. */
const PI_OAUTH_LOADERS: Record<string, keyof Omit<LoaderModule, never>> = {
  anthropic: 'loadAnthropicOAuth',
  'openai-codex': 'loadOpenAICodexOAuth',
  'github-copilot': 'loadGitHubCopilotOAuth',
  openrouter: 'loadOpenRouterOAuth',
  'kimi-coding': 'loadKimiCodingOAuth',
  xai: 'loadXaiOAuth'
}

/** True when the provider can be signed in to entirely in-app. */
export function isPiOAuthProvider(providerId: string): boolean {
  return providerId in PI_OAUTH_LOADERS
}

let loaderModulePromise: Promise<LoaderModule> | null = null

async function loaderModule(): Promise<LoaderModule> {
  loaderModulePromise ??= (async () => {
    const require = createRequire(import.meta.url)
    const candidates: string[] = []
    try {
      candidates.push(require.resolve('@earendil-works/pi-ai/dist/auth/oauth/load.js'))
    } catch {
      // Not installed in this context — fall through to the vendored copy.
    }
    const vendor = bundledPiVendorDir()
    if (vendor) {
      const vendored = join(vendor, 'pi-ai/dist/auth/oauth/load.js')
      if (existsSync(vendored)) candidates.push(vendored)
    }
    const resolved = candidates[0]
    if (!resolved) {
      throw new Error('Pi OAuth flows are unavailable in this installation.')
    }
    return (await import(pathToFileURL(resolved).href)) as LoaderModule
  })()
  return loaderModulePromise
}

/**
 * Run one provider's OAuth login to completion. Emits browser URLs, device
 * codes and progress through `handlers`, and awaits prompts (paste-the-code,
 * selects) through `handlers.prompt`. Resolves with the credential to store.
 */
export async function runPiOAuthLogin(
  providerId: string,
  handlers: PiOAuthHandlers
): Promise<PiOAuthCredential> {
  const loaderName = PI_OAUTH_LOADERS[providerId]
  if (!loaderName) {
    throw new Error(`Provider "${providerId}" does not support OAuth sign-in.`)
  }
  const module = await loaderModule()
  const flow = await module[loaderName]()
  return flow.login({
    signal: handlers.signal,
    prompt: (raw: unknown) => handlers.prompt(normalizePrompt(raw)),
    notify: (raw: unknown) => handlers.onEvent(normalizeEvent(raw))
  })
}

const PROMPT_TYPES = new Set(['text', 'secret', 'select', 'manual_code'])

function normalizePrompt(raw: unknown): PiOAuthPrompt {
  const prompt = raw as Record<string, unknown>
  const rawType = typeof prompt['type'] === 'string' ? prompt['type'] : 'text'
  const type = PROMPT_TYPES.has(rawType) ? (rawType as PiOAuthPrompt['type']) : 'text'
  const options = Array.isArray(prompt['options'])
    ? (prompt['options'] as Array<Record<string, unknown>>).map((option) => ({
        id: String(option['id']),
        label: String(option['label'])
      }))
    : undefined
  return {
    type,
    message: typeof prompt['message'] === 'string' ? prompt['message'] : 'Sign-in',
    ...(typeof prompt['placeholder'] === 'string' ? { placeholder: prompt['placeholder'] } : {}),
    ...(options ? { options } : {})
  }
}

function normalizeEvent(raw: unknown): PiOAuthEvent {
  const event = raw as Record<string, unknown>
  switch (event['type']) {
    case 'auth_url':
      return {
        type: 'auth_url',
        url: String(event['url']),
        ...(typeof event['instructions'] === 'string'
          ? { instructions: event['instructions'] }
          : {})
      }
    case 'device_code':
      return {
        type: 'device_code',
        userCode: String(event['userCode']),
        verificationUri: String(event['verificationUri'])
      }
    case 'progress':
      return { type: 'progress', message: String(event['message']) }
    default:
      return { type: 'info', message: String(event['message'] ?? '') }
  }
}
