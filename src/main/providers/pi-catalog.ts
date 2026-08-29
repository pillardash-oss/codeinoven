import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { OfferedProvider } from '../../lib/types'
import { bundledPiVendorDir } from '../drivers/harness-runtime'

/**
 * Enumerate every provider in Pi's built-in model registry — the full catalog
 * (Anthropic, Amazon Bedrock, Azure, Baseten, …), not just the providers that
 * currently hold credentials. `get_available_models` over RPC only reports
 * usable providers, so the connect flow's searchable set reads the same
 * `@earendil-works/pi-ai` registry Pi itself ships.
 *
 * The library is resolved from dev node_modules first, then from the vendored
 * copy shipped next to the bundled Pi harness — the packaged app does not
 * contain pi-ai in its own node_modules.
 */

interface RegistryModule {
  getBuiltinProviders(): string[]
  getBuiltinModels(provider: string): Record<string, unknown>
  builtinProviders(): Array<{ id: string; name?: string }>
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
      throw new Error('The Pi provider catalog is unavailable in this installation.')
    }
    return (await import(pathToFileURL(resolved).href)) as RegistryModule
  })()
  return registryModulePromise
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
