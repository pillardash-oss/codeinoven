import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toPosixPath } from '../src/lib/paths'

/**
 * Copies the pinned pi CLI's compiled bundle into `resources/harnesses/pi`
 * for electron-builder to ship as extraResources. `dist/` ships with EVERY
 * bare runtime import (`@earendil-works/chord`, `typebox`, `jiti`) rewritten
 * to relative paths into vendored copies under `vendor/`, because the
 * packaged app has no `node_modules` to walk up to; pi-ai (loaded in-process
 * by main for OAuth sign-in) is vendored too. The rest of pi's `node_modules`
 * tree is build-time-only.
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
// subpath exports), `typebox` (schema validation, imported via /schema,
// /format, /guard, /system subpaths) and `jiti` (loads the app-owned `.ts`
// extensions). Without them the packaged app fails with
// `ERR_MODULE_NOT_FOUND: Cannot find package '@earendil-works/chord'` or
// `Cannot find module 'jiti'`.
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
// Named "vendor", not "node_modules": the runtime reaches these copies
// through the relative specifiers rewritten below (plus, for code paths that
// still resolve by package name, whatever `node_modules` walk exists on the
// host). electron-builder's extraResources copy of a nested `node_modules`
// tree has been unreliable, so the vendored tree deliberately avoids that
// name.
// `.bin` holds build-time-only symlink shims (e.g. esbuild's CLI link). They
// must not enter the vendored tree: electron-builder's extraResources copy
// recreates symlinks with a bare `fs.symlink` that throws EEXIST if the
// destination already exists, and node's `cp` rewrites relative targets into
// absolute host paths that would be broken links in the packaged app.
const excludeBuildTimeBin = (source: string): boolean =>
  !toPosixPath(source).split('/').includes('.bin')
await cp(jitiPackageDirectory, join(outputDirectory, 'vendor/jiti'), {
  recursive: true,
  filter: excludeBuildTimeBin
})
await cp(chordPackageDirectory, join(outputDirectory, 'vendor/@earendil-works/chord'), {
  recursive: true,
  filter: excludeBuildTimeBin
})
await cp(typeboxPackageDirectory, join(outputDirectory, 'vendor/typebox'), {
  recursive: true,
  filter: excludeBuildTimeBin
})

// Rewrites bare runtime imports that esbuild left unbundled to the vendored
// copies. Per-file relative rewriting is required because the packaged app
// has no upward `node_modules` walk to fall back on: the pi bundle is pure ESM
// (where bare specifiers crash with `ERR_MODULE_NOT_FOUND` before pi prints a
// version line) and its one CJS require (`jiti`, loaded to compile `.ts`
// extensions) runs through `createRequire`, which in an Electron
// `utilityProcess` helper resolves only relative paths and the walk, never
// `NODE_PATH`. Only source text containing a vendored specifier is touched, so
// the rewrite pass stays cheap.
const vendorRoot = join(outputDirectory, 'vendor')

/** Bare specifiers of the packages vendored under `vendor/`, mapped to the
 *  file Node resolves for each one, relative to the vendor root. Every target
 *  mirrors the package's own `import` / `require` export condition so the
 *  rewritten specifier stays valid for both `import` and `createRequire`. */
const VENDORED_IMPORTS: Record<string, string> = {
  '@earendil-works/chord': '@earendil-works/chord/dist/index.js',
  '@earendil-works/chord/context': '@earendil-works/chord/dist/context/index.js',
  '@earendil-works/chord/delta': '@earendil-works/chord/dist/delta/index.js',
  '@earendil-works/chord/bundler': '@earendil-works/chord/dist/bundler.js',
  '@earendil-works/chord/node': '@earendil-works/chord/dist/node.js',
  typebox: 'typebox/build/index.mjs',
  'typebox/schema': 'typebox/build/schema/index.mjs',
  'typebox/system': 'typebox/build/system/index.mjs',
  'typebox/compile': 'typebox/build/compile/index.mjs',
  'typebox/value': 'typebox/build/value/index.mjs',
  'typebox/type': 'typebox/build/type/index.mjs',
  'typebox/error': 'typebox/build/error/index.mjs',
  'typebox/format': 'typebox/build/format/index.mjs',
  'typebox/guard': 'typebox/build/guard/index.mjs',
  // The bundled runtime requires jiti as CJS while pi's unbundled extension
  // loader imports the ESM `jiti/static` entry.
  jiti: 'jiti/lib/jiti.cjs',
  'jiti/static': 'jiti/lib/jiti-static.mjs'
}
const VENDORED_SPECIFIERS = Object.keys(VENDORED_IMPORTS)

/** Matches one vendored specifier as a complete quoted string literal. */
function quotedSpecifierPattern(specifier: string): RegExp {
  return new RegExp(`(["'])${specifier.replaceAll('/', '\\/')}(\\1)`, 'gu')
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
    if (!VENDORED_SPECIFIERS.some((specifier) => source.includes(specifier))) continue
    let rewritten = source
    for (const [specifier, target] of Object.entries(VENDORED_IMPORTS)) {
      const resolvedFile = join(vendorRoot, target)
      // Import specifiers must use POSIX separators: `relative()` returns
      // backslash-separated paths on Windows, and inside a JS string literal
      // each `\.` collapses to `.` (legacy escape), mangling the specifier
      // into something like `......vendor@earendil-workschorddistindex.js`,
      // which crashes ESM resolution with ERR_INVALID_MODULE_SPECIFIER.
      const rel = toPosixPath(relative(dirname(path), resolvedFile))
      rewritten = rewritten.replaceAll(
        quotedSpecifierPattern(specifier),
        (_match, quote: string) => `${quote}${rel}${quote}`
      )
    }
    if (rewritten !== source) await writeFile(path, rewritten)
  }
}
await rewriteVendorImports(join(outputDirectory, 'dist'))

/**
 * Fails the build when a vendored library is still reached through its bare
 * specifier under `dist/`. Bare specifiers only resolve via an upward
 * `node_modules` walk, which exists on a dev checkout but not in the packaged
 * app, and Electron's `utilityProcess` helpers ignore `NODE_PATH`, so a
 * leftover specifier surfaces only in production, as a Pi session that cannot
 * load a single extension. Guard it at build time instead.
 */
async function assertVendoredImportsRewritten(directory: string): Promise<void> {
  const { readdir } = await import('node:fs/promises')
  const leftovers: string[] = []
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.name.endsWith('.js')) continue
      const source = await readFile(path, 'utf8')
      for (const specifier of VENDORED_SPECIFIERS) {
        if (quotedSpecifierPattern(specifier).test(source)) {
          leftovers.push(`${toPosixPath(relative(projectRoot, path))}: ${specifier}`)
        }
      }
    }
  }
  await walk(directory)
  if (leftovers.length > 0) {
    throw new Error(`Vendored imports were not rewritten:\n${leftovers.join('\n')}`)
  }
}
await assertVendoredImportsRewritten(join(outputDirectory, 'dist'))
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
