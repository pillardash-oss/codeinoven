import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bundledPiVendorDir } from '../drivers/harness-runtime'

/**
 * Headless sign-in for any provider in Pi's built-in registry, running the
 * exact `login()` implementations the pinned `@earendil-works/pi-ai` ships —
 * the same code Pi's TUI executes. Multi-field flows (Cloudflare's key +
 * account id + gateway id, Bedrock's AWS inputs, …), OAuth browser/device
 * flows, and select prompts all come from Pi itself, so an in-app login
 * produces credentials byte-compatible with what Pi's own TUI writes.
 *
 * The library is resolved from dev node_modules first, then from the vendored
 * copy shipped next to the bundled Pi harness — the packaged app does not
 * contain pi-ai in its own node_modules.
 */

/** Events surfaced to the UI while a sign-in flow runs. */
export type PiLoginEvent =
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string }
  | { type: 'progress'; message: string }
  | { type: 'info'; message: string }

/** A question the flow needs answered before it can continue. */
export interface PiLoginPrompt {
  type: 'text' | 'secret' | 'select' | 'manual_code'
  message: string
  placeholder?: string
  options?: Array<{ id: string; label: string }>
}

export interface PiLoginHandlers {
  onEvent(event: PiLoginEvent): void
  prompt(prompt: PiLoginPrompt): Promise<string>
  signal: AbortSignal
}

/** Credential returned by a completed sign-in, ready for Pi's auth store. */
export type PiLoginCredential =
  | ({ type: 'api_key'; key?: string; env?: Record<string, string> } & Record<string, unknown>)
  | ({ type: 'oauth'; refresh: string; access: string; expires: number } & Record<string, unknown>)

interface ProviderAuthFlow {
  login(interaction: {
    signal: AbortSignal
    prompt(prompt: unknown): Promise<string>
    notify(event: unknown): void
  }): Promise<Record<string, unknown>>
}

interface PiProvider {
  id: string
  name?: string
  auth?: {
    apiKey?: { name?: string; login?: ProviderAuthFlow['login'] }
    oauth?: ProviderAuthFlow
  }
}

interface RegistryModule {
  builtinProviders(): PiProvider[]
}

let registryModulePromise: Promise<RegistryModule> | null = null

async function registryModule(): Promise<RegistryModule> {
  registryModulePromise ??= (async () => {
    const require = createRequire(import.meta.url)
    const candidates: string[] = []
    try {
      candidates.push(require.resolve('@earendil-works/pi-ai/dist/providers/all.js'))
    } catch {
      // Not installed in this context — fall through to the vendored copy.
    }
    const vendor = bundledPiVendorDir()
    if (vendor) {
      const vendored = join(vendor, 'pi-ai/dist/providers/all.js')
      if (existsSync(vendored)) candidates.push(vendored)
    }
    const resolved = candidates[0]
    if (!resolved) {
      throw new Error('Pi sign-in flows are unavailable in this installation.')
    }
    return (await import(pathToFileURL(resolved).href)) as RegistryModule
  })()
  return registryModulePromise
}

/** Which sign-in methods Pi defines for a catalog provider. */
export interface PiProviderAuthInfo {
  oauth: boolean
  apiKeyLogin: boolean
}

/** Read the sign-in methods Pi itself declares for every catalog provider. */
export async function listPiProviderAuthInfo(): Promise<Map<string, PiProviderAuthInfo>> {
  const registry = await registryModule()
  const info = new Map<string, PiProviderAuthInfo>()
  for (const provider of registry.builtinProviders()) {
    info.set(provider.id, {
      oauth: provider.auth?.oauth !== undefined,
      apiKeyLogin: provider.auth?.apiKey?.login !== undefined
    })
  }
  return info
}

async function findPiProvider(providerId: string): Promise<PiProvider | undefined> {
  const registry = await registryModule()
  return registry.builtinProviders().find((provider) => provider.id === providerId)
}

/**
 * Run one provider's sign-in to completion — Pi's own `login()` for the
 * provider, OAuth flow or multi-field API-key flow alike. Emits browser URLs,
 * device codes and progress through `handlers`, and awaits prompts (paste-
 * the-code, account ids, selects) through `handlers.prompt`. Resolves with
 * the credential to store.
 */
export async function runPiLogin(
  providerId: string,
  handlers: PiLoginHandlers
): Promise<PiLoginCredential> {
  const provider = await findPiProvider(providerId)
  const login = provider?.auth?.oauth?.login ?? provider?.auth?.apiKey?.login
  if (!login) {
    throw new Error(`"${providerId}" does not expose a sign-in flow in this Pi version.`)
  }
  const credential = (await login({
    signal: handlers.signal,
    prompt: (raw: unknown) => handlers.prompt(normalizePrompt(raw)),
    notify: (raw: unknown) => handlers.onEvent(normalizeEvent(raw))
  })) as PiLoginCredential
  if (credential.type !== 'api_key' && credential.type !== 'oauth') {
    throw new Error(`"${providerId}'s sign-in returned an unrecognized credential.`)
  }
  return credential
}

const PROMPT_TYPES = new Set(['text', 'secret', 'select', 'manual_code'])

function normalizePrompt(raw: unknown): PiLoginPrompt {
  const prompt = raw as Record<string, unknown>
  const rawType = typeof prompt['type'] === 'string' ? prompt['type'] : 'text'
  const type = PROMPT_TYPES.has(rawType) ? (rawType as PiLoginPrompt['type']) : 'text'
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

function normalizeEvent(raw: unknown): PiLoginEvent {
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
