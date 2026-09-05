/** Re-fetches every enabled custom base-URL provider's model list from its
 *  model endpoint (default `${baseURL}/models`, or the provider's saved
 *  `modelsPath`) when the model picker forces a catalog refresh.
 *
 *  Semantics: a successful, non-empty endpoint response replaces the stored
 *  model list; an error — or an empty response — preserves the existing list
 *  so a flaky endpoint can never wipe a working provider. Linked records that
 *  share a provider id across harnesses are refreshed once and applied to all
 *  of them. Failures are per-provider and never abort the sweep. */
import type { BaseUrlProvider, BaseUrlProviderModel } from '../../lib/types'
import { discoverBaseUrlModels } from './base-url-model-discovery'
import type { BaseUrlProviderService } from './base-url-provider-service'
import type { SecretVault } from '../storage/secret-vault'

/** Model IDs routinely include slashes/at-signs (LM Studio `org/model`,
 *  HF `org/model@precision`) — anything else cannot be persisted. */
const SAFE_MODEL_ID = /^[a-zA-Z0-9@][a-zA-Z0-9._:/@+-]*$/u
/** Matches the service's per-provider persistence cap. */
const MAX_MODELS = 128
/** Concurrent endpoint probes — bounded so a sweep never hammers the machine. */
const REFRESH_CONCURRENCY = 4

/**
 * Probe every distinct custom provider's model endpoint and persist the fresh
 * list when it changed. Returns the number of providers whose stored models
 * were updated.
 */
export async function refreshCustomProviderModels(
  providers: BaseUrlProviderService,
  vault: SecretVault
): Promise<number> {
  const all = await providers.listProviders()
  // Linked harness records share an id (and baseURL) — refresh each once.
  const distinct = new Map<string, BaseUrlProvider>()
  for (const provider of all) {
    if (!provider.enabled) continue
    if (!distinct.has(provider.id)) distinct.set(provider.id, provider)
  }
  if (distinct.size === 0) return 0

  const targets = [...distinct.values()]
  let updated = 0
  // Simple bounded-concurrency pool over the probe tasks.
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(REFRESH_CONCURRENCY, targets.length) },
    async () => {
      while (cursor < targets.length) {
        const provider = targets[cursor++]
        if (await refreshOne(providers, vault, provider)) updated++
      }
    }
  )
  await Promise.all(workers)
  return updated
}

/** Refresh one provider. True when the stored model list was replaced. */
async function refreshOne(
  providers: BaseUrlProviderService,
  vault: SecretVault,
  provider: BaseUrlProvider
): Promise<boolean> {
  try {
    const apiKey = provider.apiKeyRef ? await vault.resolve(provider.apiKeyRef) : undefined
    const discovered = await discoverBaseUrlModels(provider.baseURL, {
      ...(apiKey ? { apiKey } : {}),
      ...(provider.headers ? { headers: provider.headers } : {}),
      ...(provider.modelsPath ? { modelsPath: provider.modelsPath } : {}),
      force: true
    })
    // An empty response is treated like an error: the endpoint answered but
    // offered nothing usable, and wiping the provider's models would leave it
    // unusable until the next successful probe.
    if (discovered.length === 0) return false
    const models = discovered
      .filter((model) => SAFE_MODEL_ID.test(model.id))
      .slice(0, MAX_MODELS)
      .map((model): Omit<BaseUrlProviderModel, 'id' | 'providerId'> & { id: string } => ({
        id: model.id,
        name: (model.name || model.id).slice(0, 256),
        // Most current models can reason; a missing flag isn't evidence
        // they can't — matches the editor's save behavior.
        reasoning: true,
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {})
      }))
    if (sameModels(provider.models, models)) return false
    // Apply to every linked harness record sharing this provider id.
    for (const linked of await providers.listProviders()) {
      if (linked.id !== provider.id) continue
      if (sameModels(linked.models, models)) continue
      await providers.updateProvider(linked.harnessId, linked.id, { models })
    }
    return true
  } catch {
    // Endpoint unreachable or malformed — the old list stays in place.
    return false
  }
}

/** Compare stored vs freshly discovered models by the fields we persist. */
function sameModels(
  current: BaseUrlProviderModel[],
  next: Array<Omit<BaseUrlProviderModel, 'id' | 'providerId'> & { id: string }>
): boolean {
  if (current.length !== next.length) return false
  const key = (m: { id: string; name: string; contextWindow?: number }) =>
    `${m.id}\u0000${m.name}\u0000${m.contextWindow ?? ''}`
  const nextKeys = new Set(next.map(key))
  return current.every((model) => nextKeys.has(key(model)))
}
