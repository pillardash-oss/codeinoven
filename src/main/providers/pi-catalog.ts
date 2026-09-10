import type { OfferedProvider } from '../../lib/types'
import { importPiAiProvidersRegistry } from './pi-ai-registry'

/**
 * Enumerate every provider in Pi's built-in model registry — the full catalog
 * (Anthropic, Amazon Bedrock, Azure, Baseten, …), not just the providers that
 * currently hold credentials. `get_available_models` over RPC only reports
 * usable providers, so the connect flow's searchable set reads the same
 * `@earendil-works/pi-ai` registry Pi itself ships.
 *
 * The module is loaded by `importPiAiProvidersRegistry` — see
 * `pi-ai-registry.ts` for the resolution strategy and fallbacks.
 */

interface RegistryModule {
  getBuiltinProviders(): string[]
  getBuiltinModels(provider: string): Record<string, unknown>
  builtinProviders(): Array<{ id: string; name?: string }>
}

let registryModulePromise: Promise<RegistryModule> | null = null

async function registryModule(): Promise<RegistryModule> {
  // A failed import must never be cached: one transient failure (file lock,
  // antivirus scan, first-launch timing) would otherwise disable the whole
  // provider catalog until the app is restarted.
  registryModulePromise ??= importPiAiProvidersRegistry(
    'The Pi provider catalog'
  ) as Promise<RegistryModule>
  try {
    return await registryModulePromise
  } catch (error) {
    registryModulePromise = null
    throw error
  }
}

export async function listPiCatalogProviders(_projectPath?: string): Promise<OfferedProvider[]> {
  void _projectPath
  const registry = await registryModule()
  const names = new Map<string, string>()
  try {
    for (const provider of registry.builtinProviders()) {
      if (typeof provider?.name === 'string' && provider.name.length > 0) {
        names.set(provider.id, provider.name)
      }
    }
  } catch {
    // Display names are optional; ids remain usable labels.
  }
  return registry.getBuiltinProviders().map((id) => {
    let modelCount = 0
    try {
      modelCount = Object.keys(registry.getBuiltinModels(id) ?? {}).length
    } catch {
      // A provider without a generated catalog still stays searchable.
    }
    return {
      id,
      name: names.get(id) ?? id,
      modelCount,
      authenticated: false
    }
  })
}
