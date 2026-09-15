import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toPosixPath } from '../src/lib/paths'

/**
 * Build logic behind `bun run harness:build-pi`: copies the pinned pi CLI's
 * compiled bundle into a harness directory for electron-builder to ship as
 * extraResources.
 *
 * Deliberately side-effect free (the CLI wrapper is `scripts/build-pi-harness.ts`)
 * so `tests/main/harness/bundled-pi-harness.test.ts` can build the real harness
 * into a throwaway directory and boot it there. Booting outside the repository
 * is the only way to observe the breakage this module protects against: a bare
 * specifier still resolves in a dev checkout through the repo's own
 * `node_modules`, so a missing rewrite is invisible until the app is packaged.
 */

const projectRoot = join(fileURLToPath(new URL('..', import.meta.url)))

/** `start` and every ancestor directory, closest first (Node's lookup order). */
function ancestorDirectories(start: string): string[] {
  const directories: string[] = []
  let current = start
  for (;;) {
    directories.push(current)
    const parent = dirname(current)
    if (parent === current) return directories
    current = parent
  }
}

/**
 * Directory of an installed dependency, found the way Node finds it: a
 * `node_modules` folder in one of `fromDirectories` or in any of their
 * ancestors (pi's own directory comes first, so a nested layout is found too).
 *
 * Deliberately not `require.resolve('<package>/package.json')`: pi's package
 * `exports` does not list `./package.json`, so that call throws under Node
 * while quietly succeeding under Bun.
 */
function installedPackageDirectory(name: string, fromDirectories: string[]): string {
  for (const from of fromDirectories) {
    for (const directory of ancestorDirectories(from)) {
      const candidate = join(directory, 'node_modules', name)
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
  }
  throw new Error(`Cannot find installed package ${name}: run bun install first`)
}

/** `version` of a package manifest, without trusting the parsed JSON. */
function readPackageVersion(source: string): string {
  const parsed: unknown = JSON.parse(source)
  const version =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)['version']
      : undefined
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('The pinned pi package manifest has no version')
  }
  return version
}

/** RPC entry the packaged app spawns (see `bundledPiRuntime` in
 *  `src/main/drivers/harness-runtime.ts`). A harness without it is unused. */
export const PI_HARNESS_RPC_ENTRY = 'dist/bundle/rpc-entry.js'

/**
 * `dist/` files the packaged runtime reads by path instead of through an
 * import, so pruning must keep them:
 *
 *  - `theme/{dark,light}.json` are what `getBuiltinThemes()` loads on the first
 *    theme lookup of a session (pi resolves them through `getThemesDir()`, which
 *    lands on `<package>/dist/modes/interactive/theme`).
 *  - `core/export-html/template.{html,css,js}` are what pi's `generateHtml()`
 *    reads when a session is exported to HTML. They are template assets, not
 *    compiled modules: the `*.js` next to them is pi's own compiled copy of the
 *    same helpers, which the bundle already inlines.
 */
export const PI_HARNESS_KEPT_DIST_FILES: readonly string[] = [
  'dist/modes/interactive/theme/dark.json',
  'dist/modes/interactive/theme/light.json',
  'dist/core/export-html/template.html',
  'dist/core/export-html/template.css',
  'dist/core/export-html/template.js'
]

/**
 * Directories the prune walk descends into because a kept file lives under
 * them. `dist/bundle` is matched by prefix: its whole chunk graph ships.
 */
const KEPT_DIST_DIRECTORIES: ReadonlySet<string> = new Set([
  'dist',
  'dist/bundle',
  'dist/modes',
  'dist/modes/interactive',
  'dist/modes/interactive/theme',
  'dist/core',
  'dist/core/export-html'
])

/**
 * Files the packaged runtime loads, checked after pruning. Every entry is backed
 * by an observation of the shipped code, so a pruning rule can never silently
 * remove something a Pi session needs:
 *
 *  - `dist/bundle/cli.js` and `dist/bundle/coordinator.js` are the internal
 *    process entrypoints pi spawns; in the bundled runtime `defaultEntryUrl()`
 *    maps every role to a file in `dist/bundle`.
 *  - `vendor/jiti/dist/{jiti.cjs,babel.cjs}` are required by
 *    `vendor/jiti/lib/jiti.cjs`, which is what the bundle requires to compile
 *    the app-owned `.ts` extensions.
 *  - `chord/dist/node/bundle.js` is statically imported by `chord/bundler.js`,
 *    which the bundle imports, and it in turn imports the `esbuild` package, so
 *    that package's JS entry must stay resolvable from
 *    `vendor/@earendil-works/chord/node_modules`.
 *  - `pi-ai` is imported in-process by the main process
 *    (see `src/main/providers/pi-ai-registry.ts`).
 */
export const PI_HARNESS_REQUIRED_RUNTIME_FILES: readonly string[] = [
  'package.json',
  PI_HARNESS_RPC_ENTRY,
  'dist/bundle/cli.js',
  'dist/bundle/coordinator.js',
  'dist/bundle/index.js',
  ...PI_HARNESS_KEPT_DIST_FILES,
  'vendor/jiti/dist/jiti.cjs',
  'vendor/jiti/dist/babel.cjs',
  'vendor/@earendil-works/chord/dist/node/bundle.js',
  'vendor/@earendil-works/chord/node_modules/esbuild/lib/main.js',
  'vendor/pi-ai/dist/index.js',
  'vendor/pi-ai/dist/providers/all.js'
]

const DECLARATION_FILE_PATTERN = /\.d\.(?:ts|mts|cts)$/u

/**
 * Why a build artifact is dropped, or `undefined` to keep it (and descend into
 * it when it is a directory). Rules are stated as what pi publishes, each backed
 * by what the runtime does:
 *
 *  - pi's compiled modules outside `dist/bundle/` are its package-internal
 *    entrypoints (`dist/index.js`, `dist/core/*`, `dist/modes/*`,
 *    `dist/experimental/*`, `dist/bun/*`). The bundle never imports them, and
 *    pi's extension loader resolves `@earendil-works/pi-coding-agent` from its
 *    in-memory virtual modules (`isBundledNode` is hardcoded true in the
 *    bundle), not from disk.
 *  - source maps and type declarations are read by editors and debuggers, never
 *    by Node at run time.
 *  - chord's `src/` is TypeScript source for chord's own build.
 *  - `esbuild/node_modules/` holds the 10MB platform binary (`@esbuild/<os>-<arch>`)
 *    that only chord's facet bundler spawns. That bundler is reachable solely
 *    from pi's server-mode plugin packages, and "facet" appears nowhere in this
 *    app: the driver always launches `--mode rpc`. esbuild's JS entry still
 *    ships, so the module graph loads exactly as before.
 */
export function piHarnessPruneReason(relativePath: string): string | undefined {
  if (KEPT_DIST_DIRECTORIES.has(relativePath)) return undefined
  if (relativePath.startsWith('dist/bundle/')) return undefined
  if (PI_HARNESS_KEPT_DIST_FILES.includes(relativePath)) return undefined
  if (relativePath === 'dist' || relativePath.startsWith('dist/')) {
    return "compiled output only pi's own package entrypoints import"
  }
  if (relativePath === 'vendor/@earendil-works/chord/src') return 'TypeScript sources'
  if (relativePath === 'vendor/@earendil-works/chord/node_modules/esbuild/node_modules') {
    return 'esbuild platform binary for facet bundling'
  }
  if (relativePath === 'vendor/@earendil-works/chord/node_modules/esbuild/install.js') {
    return 'npm install script'
  }
  if (relativePath === 'vendor/@earendil-works/chord/node_modules/esbuild/README.md') {
    return 'package docs'
  }
  if (relativePath.endsWith('.map')) return 'source map'
  if (DECLARATION_FILE_PATTERN.test(relativePath)) return 'type declaration'
  // TypeBox ships a `.mjs` runtime build next to parallel `.mts` declarations.
  if (relativePath.endsWith('.mts') || relativePath.endsWith('.cts')) return 'type declaration'
  return undefined
}

/**
 * Drops every copied artifact `piHarnessPruneReason` rejects. pi publishes its
 * whole compiled tree plus source maps, declarations and a platform-specific
 * esbuild binary for its own CLI/plugin tooling, none of which a headless
 * `--mode rpc` session touches: pruning takes the shipped harness from pi's
 * complete 3319 files (36MB) down to the 1007 files (12MB) a session loads.
 */
async function pruneBuildOnlyFiles(directory: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      const relativePath = toPosixPath(relative(directory, path))
      if (piHarnessPruneReason(relativePath) === undefined) {
        if (entry.isDirectory()) await walk(path)
        continue
      }
      // Counted recursively: a dropped directory takes its whole subtree with
      // it, and that subtree is usually most of what a rule removes.
      const dropped = await fileTotals(path)
      files += dropped.files
      bytes += dropped.bytes
      await rm(path, { recursive: true, force: true })
    }
  }
  await walk(directory)
  return { files, bytes }
}

/** Files and bytes under `start`, counted for the build log. */
async function fileTotals(start: string): Promise<{ files: number; bytes: number }> {
  const info = await stat(start)
  if (!info.isDirectory()) return { files: 1, bytes: info.size }
  let files = 0
  let bytes = 0
  for (const entry of await readdir(start, { withFileTypes: true })) {
    const inner = await fileTotals(join(start, entry.name))
    files += inner.files
    bytes += inner.bytes
  }
  return { files, bytes }
}

/** Total bytes shipped in the harness directory, for the build log. */
export async function bundledPiHarnessSizeBytes(directory: string): Promise<number> {
  return (await fileTotals(directory)).bytes
}

/**
 * Fails the build when a file the packaged runtime loads is missing. Pruning is
 * the only step that can remove something pi needs, so it is verified against an
 * explicit list instead of trusting the rules to stay correct.
 */
function assertRuntimeFilesPresent(directory: string): void {
  const missing = PI_HARNESS_REQUIRED_RUNTIME_FILES.filter(
    (relativePath) => !existsSync(join(directory, relativePath))
  )
  if (missing.length > 0) {
    throw new Error(
      'The pruned pi harness is missing files the packaged app loads. Either a pruning rule in ' +
        'piHarnessPruneReason is too aggressive or pi moved a file:\n' +
        missing.join('\n')
    )
  }
}

/** Default harness output directory, relative to the repository root. */
export function defaultBundledPiHarnessDirectory(): string {
  return join(projectRoot, 'resources/harnesses/pi')
}

/**
 * Bare specifiers of the packages vendored under `vendor/`, mapped to the file
 * Node resolves for each one, relative to the vendor root. Every target mirrors
 * the package's own `import` / `require` export condition so the rewritten
 * specifier stays valid for both `import` and `createRequire`.
 *
 * esbuild does not inline these runtime imports of pi's compiled bundle:
 * `@earendil-works/chord` (RPC protocol, incl. /context, /bundler, /node
 * subpath exports), `typebox` (schema validation, imported via /schema,
 * /format, /guard, /system subpaths) and `jiti` (loads the app-owned `.ts`
 * extensions). Without them the packaged app fails with
 * `ERR_MODULE_NOT_FOUND: Cannot find package '@earendil-works/chord'` or
 * `Cannot find module 'jiti'`, and every Pi session dies at boot.
 */
export const PI_HARNESS_VENDORED_IMPORTS: Record<string, string> = {
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

export const PI_HARNESS_VENDORED_SPECIFIERS: string[] = Object.keys(PI_HARNESS_VENDORED_IMPORTS)

/**
 * Packages the harness must never reach by package name, whatever the mapping
 * above says.
 *
 * The rewrite can only rewrite what it is told about, so without this list
 * deleting a single mapping would quietly ship a bare specifier again, and the
 * leftover check below would happily agree with itself. Pinned as names rather
 * than derived from the mapping, precisely so the mapping cannot shrink
 * unnoticed.
 */
export const PI_HARNESS_VENDORED_PACKAGES: string[] = ['@earendil-works/chord', 'typebox', 'jiti']

export interface BundledPiHarnessBuild {
  /** pi version the harness was built from. */
  version: string
  /** Absolute harness directory that was written. */
  directory: string
  /** `dist/` files the vendoring rewrite touched, relative to the harness
   *  directory. Empty means pi stopped needing every vendored library, which
   *  means this build's assumptions are stale and someone must look. */
  rewrittenFiles: string[]
  /** Build-only files pruned after copying, and the bytes they occupied. */
  prunedFiles: number
  prunedBytes: number
  /** Total bytes the harness ships, after pruning. */
  shippedBytes: number
}

/** Matches one vendored specifier as a complete quoted string literal. */
function quotedSpecifierPattern(specifier: string): RegExp {
  return new RegExp(`(["'])${specifier.replaceAll('/', '\\/')}(\\1)`, 'gu')
}

/** Matches `pkg` or `pkg/subpath` as a complete quoted string literal. */
function quotedPackagePattern(packageName: string): RegExp {
  return new RegExp(`(["'])${packageName.replaceAll('/', '\\/')}(?:\\/[^"'\n]*)?\\1`, 'gu')
}

async function listJavaScriptFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listJavaScriptFiles(path)))
      continue
    }
    if (entry.name.endsWith('.js')) files.push(path)
  }
  return files
}

/**
 * Rewrites bare runtime imports that esbuild left unbundled to the vendored
 * copies. Per-file relative rewriting is required because the packaged app has
 * no upward `node_modules` walk to fall back on: the pi bundle is pure ESM
 * (where bare specifiers crash with `ERR_MODULE_NOT_FOUND` before pi prints a
 * version line) and its one CJS require (`jiti`, loaded to compile `.ts`
 * extensions) runs through `createRequire`, which in an Electron
 * `utilityProcess` helper resolves only relative paths and the walk, never
 * `NODE_PATH`. Only source text containing a vendored specifier is touched, so
 * the rewrite pass stays cheap.
 */
async function rewriteVendorImports(distDirectory: string, vendorRoot: string): Promise<string[]> {
  const rewritten: string[] = []
  for (const path of await listJavaScriptFiles(distDirectory)) {
    const source = await readFile(path, 'utf8')
    if (!PI_HARNESS_VENDORED_SPECIFIERS.some((specifier) => source.includes(specifier))) continue
    let updated = source
    for (const [specifier, target] of Object.entries(PI_HARNESS_VENDORED_IMPORTS)) {
      const resolvedFile = join(vendorRoot, target)
      // Import specifiers must use POSIX separators: `relative()` returns
      // backslash-separated paths on Windows, and inside a JS string literal
      // each `\.` collapses to `.` (legacy escape), mangling the specifier
      // into something like `......vendor@earendil-workschorddistindex.js`,
      // which crashes ESM resolution with ERR_INVALID_MODULE_SPECIFIER.
      const rel = toPosixPath(relative(dirname(path), resolvedFile))
      updated = updated.replaceAll(
        quotedSpecifierPattern(specifier),
        (_match, quote: string) => `${quote}${rel}${quote}`
      )
    }
    if (updated === source) continue
    await writeFile(path, updated)
    rewritten.push(toPosixPath(relative(dirname(distDirectory), path)))
  }
  return rewritten
}

/**
 * Fails the build when a vendored library is still reached by package name
 * under `dist/`. Bare specifiers only resolve via an upward `node_modules`
 * walk, which exists on a dev checkout but not in the packaged app, and
 * Electron's `utilityProcess` helpers ignore `NODE_PATH`, so a leftover
 * specifier surfaces only in production, as a Pi session that cannot load a
 * single extension. Guard it at build time instead.
 *
 * Checked twice over: every mapped specifier must be gone, and no package in
 * `PI_HARNESS_VENDORED_PACKAGES` may still be referenced by name even when the
 * mapping no longer mentions it.
 */
async function assertVendoredImportsRewritten(distDirectory: string): Promise<void> {
  const leftovers: string[] = []
  for (const path of await listJavaScriptFiles(distDirectory)) {
    const where = toPosixPath(relative(projectRoot, path))
    const source = await readFile(path, 'utf8')
    for (const specifier of PI_HARNESS_VENDORED_SPECIFIERS) {
      if (quotedSpecifierPattern(specifier).test(source)) {
        leftovers.push(`${where}: ${specifier}`)
      }
    }
    for (const packageName of PI_HARNESS_VENDORED_PACKAGES) {
      const match = quotedPackagePattern(packageName).exec(source)
      if (match) leftovers.push(`${where}: ${match[0]}`)
    }
  }
  if (leftovers.length > 0) {
    throw new Error(
      'The bundled harness would not resolve in the packaged app: these vendored libraries are ' +
        'still reached by package name, which only resolves through a node_modules walk the ' +
        'packaged app does not have.\n' +
        'Add the missing entry to PI_HARNESS_VENDORED_IMPORTS in scripts/pi-harness-bundle.ts ' +
        'instead of removing it:\n' +
        leftovers.join('\n')
    )
  }
}

/**
 * Fails the build when a mapped vendored target is missing from the vendored
 * tree. The rewrite turns a mapping into a relative specifier blindly, so a
 * typo (or an upstream file move) would ship a path that cannot resolve and
 * would only surface as a dead Pi session in the packaged app.
 */
function assertVendoredTargetsExist(vendorRoot: string): void {
  const missing = Object.values(PI_HARNESS_VENDORED_IMPORTS)
    .filter((target) => !existsSync(join(vendorRoot, target)))
    .map((target) => `vendor/${target}`)
  if (missing.length > 0) {
    throw new Error(`Vendored targets are missing from the harness:\n${missing.join('\n')}`)
  }
}

/**
 * Materializes the bundled Pi runtime at `directory`, rewriting every vendored
 * bare import to a relative path into the vendored copies. Throws (never warns)
 * when the result could not resolve in the packaged app.
 */
export async function buildBundledPiHarness(directory: string): Promise<BundledPiHarnessBuild> {
  const piPackageDirectory = installedPackageDirectory('@earendil-works/pi-coding-agent', [
    projectRoot
  ])
  const piPackageJsonPath = join(piPackageDirectory, 'package.json')
  // esbuild does not inline these runtime imports of pi's compiled bundle:
  // `@earendil-works/chord` (RPC protocol, incl. /context, /bundler, /node
  // subpath exports), `typebox` (schema validation, imported via /schema,
  // /format, /guard, /system subpaths) and `jiti` (loads the app-owned `.ts`
  // extensions). Without them the packaged app fails with
  // `ERR_MODULE_NOT_FOUND: Cannot find package '@earendil-works/chord'` or
  // `Cannot find module 'jiti'`.
  const chordPackageDirectory = installedPackageDirectory('@earendil-works/chord', [
    piPackageDirectory,
    projectRoot
  ])
  const typeboxPackageDirectory = installedPackageDirectory('typebox', [
    piPackageDirectory,
    projectRoot
  ])
  const jitiPackageDirectory = installedPackageDirectory('jiti', [
    piPackageDirectory,
    chordPackageDirectory,
    projectRoot
  ])

  const version = readPackageVersion(await readFile(piPackageJsonPath, 'utf8'))

  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })

  await cp(join(piPackageDirectory, 'dist'), join(directory, 'dist'), { recursive: true })
  await cp(piPackageJsonPath, join(directory, 'package.json'))
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
  await cp(jitiPackageDirectory, join(directory, 'vendor/jiti'), {
    recursive: true,
    filter: excludeBuildTimeBin
  })
  await cp(chordPackageDirectory, join(directory, 'vendor/@earendil-works/chord'), {
    recursive: true,
    filter: excludeBuildTimeBin
  })
  await cp(typeboxPackageDirectory, join(directory, 'vendor/typebox'), {
    recursive: true,
    filter: excludeBuildTimeBin
  })
  // pi-ai's dist is self-contained relative imports; vendored so main-process
  // features (in-app OAuth sign-in) can load its flow implementations in the
  // packaged app, where pi-ai is not part of CodeInOven's own node_modules.
  const piAiPackageDirectory = installedPackageDirectory('@earendil-works/pi-ai', [
    piPackageDirectory,
    projectRoot
  ])
  await cp(join(piAiPackageDirectory, 'dist'), join(directory, 'vendor/pi-ai/dist'), {
    recursive: true
  })
  // Pruned after every copy so the rules see the whole tree, and before the
  // rewrite pass so the vendoring checks below cover exactly the files that
  // ship: a bare specifier in a dropped module cannot break a packaged app, and
  // auditing it would only cost build time.
  const vendorRoot = join(directory, 'vendor')
  const pruned = await pruneBuildOnlyFiles(directory)
  const rewrittenFiles = await rewriteVendorImports(join(directory, 'dist'), vendorRoot)
  assertVendoredTargetsExist(vendorRoot)
  await assertVendoredImportsRewritten(join(directory, 'dist'))

  if (!existsSync(join(directory, PI_HARNESS_RPC_ENTRY))) {
    throw new Error(
      `Bundled pi ${version} has no ${PI_HARNESS_RPC_ENTRY}: the harness installs nothing`
    )
  }

  assertRuntimeFilesPresent(directory)
  await writeFile(join(directory, '.version'), `${version}\n`)

  return {
    version,
    directory,
    rewrittenFiles,
    prunedFiles: pruned.files,
    prunedBytes: pruned.bytes,
    shippedBytes: await bundledPiHarnessSizeBytes(directory)
  }
}
