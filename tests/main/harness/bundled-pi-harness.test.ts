import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildBundledPiHarness,
  PI_HARNESS_RPC_ENTRY,
  PI_HARNESS_VENDORED_IMPORTS
} from '../../../scripts/pi-harness-bundle'

/**
 * Guards the bundled Pi harness against the one failure mode that stays
 * invisible everywhere except in a packaged app: a library reached by package
 * name instead of by a relative path into `vendor/`.
 *
 * A bare specifier still resolves in a dev checkout through the repository's
 * own `node_modules`, so `harness:build-pi` succeeding proves nothing about the
 * packaged app. The faithful check is to boot the built harness from a tree
 * with no `node_modules` above it, which is what this file does:
 *
 * 1. build the real harness into a sandbox under the OS temp directory,
 * 2. boot it through Electron's own Node runtime with a TypeScript extension,
 *    the way `bundledPiEnv` launches a Pi session in production,
 * 3. boot it again with a vendored require deliberately turned back into a bare
 *    specifier, and require that boot to fail.
 *
 * Step 3 is what keeps the guard honest: it proves step 2 would catch the
 * regression instead of passing on a technicality. History: a bare `jiti`
 * require resolved through `NODE_PATH` (which Electron `utilityProcess` helpers
 * ignore) killed every Pi session in the packaged app with
 * `Cannot find module 'jiti'`.
 */
const BOOT_TIMEOUT_MS = 120_000
/** Boots plus, for the regression case, a full copy of the built harness. */
const TEST_TIMEOUT_MS = 180_000

/** Written to stderr once pi compiles the probe extension with vendored jiti. */
const PROBE_MODULE_MARKER = 'cio-bundled-pi-probe:module'
const PROBE_FACTORY_MARKER = 'cio-bundled-pi-probe:factory'

/**
 * Extension pi compiles during boot. Its shape mirrors the app-owned extension
 * (`src/main/drivers/pi-cio-core-tools-extension.ts`): TypeScript syntax, a bare
 * `typebox` import that pi's loader aliases into the vendored copy, and a
 * default-exported factory.
 */
const PROBE_EXTENSION_SOURCE = `import { Type } from 'typebox'

const probeSchema = Type.Object({ ok: Type.Boolean() })
process.stderr.write('${PROBE_MODULE_MARKER} ' + JSON.stringify(probeSchema.type) + '\\n')

export default function probe(): void {
  process.stderr.write('${PROBE_FACTORY_MARKER}\\n')
}
`

/** First ancestor of `start` that holds a `node_modules` directory. */
function findAncestorNodeModules(start: string): string | undefined {
  let current = start
  for (;;) {
    if (existsSync(join(current, 'node_modules'))) return join(current, 'node_modules')
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** Electron's own binary, the runtime production launches the harness with. */
async function resolveElectronBinary(): Promise<string> {
  const require = createRequire(import.meta.url)
  const packageDirectory = dirname(require.resolve('electron'))
  const binaryPath = (await readFile(join(packageDirectory, 'path.txt'), 'utf8')).trim()
  return join(packageDirectory, 'dist', binaryPath)
}

interface HarnessBoot {
  status: number | null
  stderr: string
}

/**
 * Boots `dist/bundle/rpc-entry.js` the way a Pi session runs in the packaged
 * app: Electron's binary acting as plain Node, `NODE_PATH` empty (Electron's
 * `utilityProcess` helpers never honor it) and a fresh `--extension` module.
 * Closed stdin lets the RPC loop finish and exit once boot is complete.
 */
function bootHarness(
  electronBinaryPath: string,
  harnessDirectory: string,
  extensionPath: string
): HarnessBoot {
  const result = spawnSync(
    electronBinaryPath,
    [join(harnessDirectory, PI_HARNESS_RPC_ENTRY), '--extension', extensionPath],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: BOOT_TIMEOUT_MS
    }
  )
  return { status: result.status, stderr: result.stderr ?? '' }
}

/**
 * Turns every relative require of the vendored jiti back into the bare
 * specifier that broke production, returning the files it changed.
 */
async function unwrapVendoredJitiRequires(root: string): Promise<string[]> {
  const vendoredJiti = /(["'])[^"'\n]*vendor\/jiti\/lib\/jiti\.cjs\1/gu
  const changed: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
      if (!entry.name.endsWith('.js')) continue
      const source = await readFile(path, 'utf8')
      if (!vendoredJiti.test(source)) continue
      vendoredJiti.lastIndex = 0
      await writeFile(path, source.replaceAll(vendoredJiti, 'jiti'))
      changed.push(path)
    }
  }
  await visit(join(root, 'dist'))
  return changed
}

describe('bundled Pi harness', () => {
  let sandbox = ''
  let harnessDirectory = ''
  let probeExtensionPath = ''
  let electronBinaryPath = ''
  let rewrittenFiles: string[] = []

  beforeAll(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'cio-bundled-pi-harness-'))
    harnessDirectory = join(sandbox, 'pi')
    // The point of the sandbox: with no `node_modules` anywhere above it, a
    // left-over bare specifier cannot resolve, so a broken harness fails here
    // exactly like it fails for a user.
    expect(findAncestorNodeModules(sandbox)).toBeUndefined()
    rewrittenFiles = (await buildBundledPiHarness(harnessDirectory)).rewrittenFiles
    electronBinaryPath = await resolveElectronBinary()
    expect(existsSync(electronBinaryPath)).toBe(true)
    probeExtensionPath = join(sandbox, 'probe-extension.ts')
    await writeFile(probeExtensionPath, PROBE_EXTENSION_SOURCE)
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    if (sandbox) await rm(sandbox, { recursive: true, force: true })
  })

  it(
    'ships the runtime entry and every library the packaged app resolves by name',
    async () => {
      expect(existsSync(join(harnessDirectory, PI_HARNESS_RPC_ENTRY))).toBe(true)

      const missing = Object.values(PI_HARNESS_VENDORED_IMPORTS).filter(
        (target) => !existsSync(join(harnessDirectory, 'vendor', target))
      )
      expect(missing).toEqual([])

      // A rewrite that touched nothing means pi stopped importing the vendored
      // libraries: the mapping and this whole file need a fresh look rather
      // than a silent pass.
      expect(rewrittenFiles.length).toBeGreaterThan(0)
      const sources = await Promise.all(
        rewrittenFiles.map((file) => readFile(join(harnessDirectory, file), 'utf8'))
      )
      expect(sources.some((source) => source.includes('vendor/jiti/lib/jiti.cjs'))).toBe(true)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'boots and loads a TypeScript extension with no node_modules above the harness',
    () => {
      const boot = bootHarness(electronBinaryPath, harnessDirectory, probeExtensionPath)

      expect(boot.stderr).toContain(`${PROBE_MODULE_MARKER} "object"`)
      expect(boot.stderr).toContain(PROBE_FACTORY_MARKER)
      expect(boot.stderr).not.toMatch(
        /Cannot find module|ERR_MODULE_NOT_FOUND|Failed to load extension/u
      )
      expect(boot.status).toBe(0)
    },
    TEST_TIMEOUT_MS
  )

  it(
    'fails that same boot when a vendored require is left bare',
    async () => {
      const regressedDirectory = join(sandbox, 'pi-regressed')
      await cp(harnessDirectory, regressedDirectory, { recursive: true })
      const unwrapped = await unwrapVendoredJitiRequires(regressedDirectory)
      expect(unwrapped.length).toBeGreaterThan(0)

      const regressed = bootHarness(electronBinaryPath, regressedDirectory, probeExtensionPath)

      expect(regressed.status).not.toBe(0)
      expect(regressed.stderr).toMatch(/Cannot find module 'jiti'|Failed to load extension/u)
      expect(regressed.stderr).not.toContain(PROBE_FACTORY_MARKER)
    },
    TEST_TIMEOUT_MS
  )
})
