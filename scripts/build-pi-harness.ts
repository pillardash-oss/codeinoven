import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Copies the pinned pi CLI's compiled bundle into `resources/harnesses/pi`
 * for electron-builder to ship as extraResources. `dist/` ships with its bare
 * runtime imports (`@earendil-works/chord`, `typebox`) rewritten to vendored
 * copies under `vendor/`; `jiti` (the one remaining runtime dependency, used
 * to load `.ts` extensions, resolved via NODE_PATH) and pi-ai (loaded
 * in-process by main for OAuth sign-in) are vendored too. The rest of pi's
 * `node_modules` tree is build-time-only.
 */

const projectRoot = join(fileURLToPath(new URL('..', import.meta.url)))
const outputDirectory = join(projectRoot, 'resources/harnesses/pi')
const require = createRequire(import.meta.url)

const piPackageJsonPath = require.resolve('@earendil-works/pi-coding-agent/package.json')
const piPackageDirectory = dirname(piPackageJsonPath)
const jitiPackageJsonPath = require.resolve('jiti/package.json', { paths: [piPackageDirectory] })
const jitiPackageDirectory = dirname(jitiPackageJsonPath)
// esbuild does not inline these runtime imports of pi's compiled bundle:
// `@earendil-works/chord` (RPC protocol, incl. /context, /bundler, /node
// subpath exports) and `typebox` (schema validation, imported via /schema,
// /format, /guard, /system subpaths). Without them the packaged app fails
// with `ERR_MODULE_NOT_FOUND: Cannot find package '@earendil-works/chord'`.
const chordPackageJsonPath = require.resolve('@earendil-works/chord/package.json', {
  paths: [piPackageDirectory]
})
const chordPackageDirectory = dirname(chordPackageJsonPath)
const typeboxPackageJsonPath = require.resolve('typebox/package.json', {
  paths: [piPackageDirectory]
})
const typeboxPackageDirectory = dirname(typeboxPackageJsonPath)

const piPackageJson = await import(piPackageJsonPath, { with: { type: 'json' } })
const version: string = piPackageJson.default.version

await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })

await cp(join(piPackageDirectory, 'dist'), join(outputDirectory, 'dist'), { recursive: true })
await cp(piPackageJsonPath, join(outputDirectory, 'package.json'))
// Named "vendor", not "node_modules" — electron-builder's extraResources copy
// silently drops nested `node_modules` directories, so the runtime resolves
// these via NODE_PATH / direct paths instead of Node's standard walk.
await cp(jitiPackageDirectory, join(outputDirectory, 'vendor/jiti'), { recursive: true })
await cp(chordPackageDirectory, join(outputDirectory, 'vendor/@earendil-works/chord'), {
  recursive: true
})
await cp(typeboxPackageDirectory, join(outputDirectory, 'vendor/typebox'), { recursive: true })

// Rewrites bare runtime imports that esbuild left unbundled to the vendored
// copies. Per-file relative rewriting is required because the pi bundle is
// pure ESM: ESM resolution ignores NODE_PATH entirely, so in the packaged app
// — where no upward `node_modules` walk exists — bare specifiers crash with
// `ERR_MODULE_NOT_FOUND` before pi ever prints a version line. Only source
// text containing the bare specifiers is touched, so the rewrite pass stays
// cheap.
const vendorRoot = join(outputDirectory, 'vendor')

/** `exports` "import" targets for the two unbundled packages, relative to
 *  each package root — mirrors Node's own `"import"` condition resolution. */
const EXPORT_TARGETS: Record<string, string> = {
  '@earendil-works/chord': 'dist/index.js',
  '@earendil-works/chord/context': 'dist/context/index.js',
  '@earendil-works/chord/delta': 'dist/delta/index.js',
  '@earendil-works/chord/bundler': 'dist/bundler.js',
  '@earendil-works/chord/node': 'dist/node.js',
  typebox: 'build/index.mjs',
  'typebox/schema': 'build/schema/index.mjs',
  'typebox/system': 'build/system/index.mjs',
  'typebox/compile': 'build/compile/index.mjs',
  'typebox/value': 'build/value/index.mjs',
  'typebox/type': 'build/type/index.mjs',
  'typebox/error': 'build/error/index.mjs',
  'typebox/format': 'build/format/index.mjs',
  'typebox/guard': 'build/guard/index.mjs'
}

async function rewriteVendorImports(directory: string): Promise<void> {
  const { readdir } = await import('node:fs/promises')
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await rewriteVendorImports(path)
      continue
    }
    if (!entry.name.endsWith('.js')) continue
    const source = await readFile(path, 'utf8')
    if (!source.includes('@earendil-works/chord') && !source.includes('typebox')) continue
    let rewritten = source
    for (const [specifier, target] of Object.entries(EXPORT_TARGETS)) {
      const resolvedFile = join(
        vendorRoot,
        specifier === 'typebox' || specifier.startsWith('typebox/')
          ? join('typebox', target)
          : join('@earendil-works/chord', target)
      )
      const rel = relative(dirname(path), resolvedFile)
      rewritten = rewritten.replaceAll(
        new RegExp(`(["'])${specifier.replaceAll('/', '\\/')}(\\1)`, 'gu'),
        (_match, quote: string) => `${quote}${rel}${quote}`
      )
    }
    if (rewritten !== source) await writeFile(path, rewritten)
  }
}
await rewriteVendorImports(join(outputDirectory, 'dist'))
// pi-ai's dist is self-contained relative imports; vendored so main-process
// features (in-app OAuth sign-in) can load its flow implementations in the
// packaged app, where pi-ai is not part of CodeInOven's own node_modules.
const piAiPackageJsonPath = require.resolve('@earendil-works/pi-ai/package.json', {
  paths: [piPackageDirectory]
})
const piAiPackageDirectory = dirname(piAiPackageJsonPath)
await cp(join(piAiPackageDirectory, 'dist'), join(outputDirectory, 'vendor/pi-ai/dist'), {
  recursive: true
})
await writeFile(join(outputDirectory, '.version'), `${version}\n`)

// eslint-disable-next-line no-console
console.log(`bundled pi ${version} -> resources/harnesses/pi`)
