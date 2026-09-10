import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bundledPiVendorDir } from '../drivers/harness-runtime'
import { Logger } from '../system/logger'

/**
 * Locate and import the ESM `@earendil-works/pi-ai` providers registry — the
 * full provider/model catalog (`dist/providers/all.js`) that Pi itself ships.
 *
 * Resolution order:
 *  1. `import.meta.resolve('@earendil-works/pi-ai')` — respects the package's
 *     real `exports` map, so it works in any checkout that has node_modules,
 *     including ones without the gitignored bundled-Pi build
 *     (`resources/harnesses/pi`, produced by `scripts/build-pi-harness.ts`).
 *  2. The vendored copy shipped next to the bundled Pi harness — required in
 *     the packaged app, where pi-ai is not part of CodeInOven's node_modules.
 *
 * Note: `require.resolve('@earendil-works/pi-ai/dist/providers/all.js')` can
 * NOT be used — the exports map only exposes `./providers/*`, so deep `dist/`
 * specifiers always throw ERR_PACKAGE_PATH_NOT_EXPORTED.
 */

/**
 * Import the pi-ai providers registry module. The result is cast by the
 * caller (pi-catalog.ts and pi-login.ts use different slices of the module).
 * Throws when the registry is unavailable in this installation; failures are
 * logged with the attempted path so packaged-environment problems are
 * diagnosable.
 */
export async function importPiAiProvidersRegistry(scope: string): Promise<unknown> {
  const candidates: string[] = []
  try {
    // Resolves `…/node_modules/@earendil-works/pi-ai/dist/index.js`; the
    // package root sits two directories up.
    const entry = import.meta.resolve('@earendil-works/pi-ai')
    const packageRoot = dirname(dirname(fileURLToPath(entry)))
    const registry = join(packageRoot, 'dist/providers/all.js')
    if (existsSync(registry)) candidates.push(registry)
  } catch {
    // pi-ai is not installed in this checkout — fall through to the vendor.
  }
  const vendor = bundledPiVendorDir()
  if (vendor) {
    const vendored = join(vendor, 'pi-ai/dist/providers/all.js')
    if (existsSync(vendored)) candidates.push(vendored)
  }
  const resolved = candidates[0]
  if (!resolved) {
    throw new Error(`${scope} is unavailable: the Pi provider registry could not be located.`)
  }
  try {
    return await import(pathToFileURL(resolved).href)
  } catch (error) {
    Logger.error(`[pi-ai] Failed to load the Pi provider registry from ${resolved}:`, error)
    throw error instanceof Error ? error : new Error(String(error))
  }
}
