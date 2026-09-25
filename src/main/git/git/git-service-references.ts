import { existsSync, statSync } from 'fs'
import { readFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import type { SimpleGit } from 'simple-git'
import type { DanglingReference, GitIntegrationChanges } from '../../../lib/types'
import { posixBasename, toPosixPath } from '../../../lib/paths'

/**
 * The post-integration reference probe.
 *
 * A merge or a rebase integrates path by path, with a three-way comparison per
 * path. A path is only in conflict when both sides changed it. So when one side
 * deletes a module while the other side's brand-new file imports it, the two
 * changes touch different paths, git reports a clean integration, and the
 * result is nevertheless broken: a bundler "failed to resolve import" overlay,
 * or a `ReferenceError` from a main-process module that no longer exists. Git
 * cannot see it, because git has no linker and stores an import as nothing more
 * than characters inside a file it considers valid.
 *
 * This probe answers the question the integration cannot: does anything in the
 * checkout still name a module the integration just removed?
 *
 * It is deliberately cheaper than a type-check, and covers one gap a type-check
 * in this project does not: the no-path `bun run check` runs svelte-check with
 * `--tsgo`, which does not report an unresolved `.svelte` import at all. Only
 * the bundler does, at runtime, once the app is already starting.
 *
 * What it does:
 * 1. Reads the paths the integration removed and the paths it touched.
 * 2. Collects the module names those removals orphaned, keyed by the name an
 *    import would end with.
 * 3. Reads the source files git tracks, and for each import specifier whose
 *    last segment matches an orphaned name, resolves the specifier against the
 *    tree the integration produced.
 * 4. Reports every specifier that no longer resolves.
 *
 * What it is not: a type-check, a lint pass, or a general static analysis. It
 * resolves import specifiers and nothing else, and it only runs when the
 * integration actually removed a file.
 */

/** Source extensions an import specifier is resolved against, in order. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.svelte', '.js', '.jsx', '.mjs', '.cjs']

/** `./widget.js` written for a `widget.ts` source, as ESM TypeScript allows. */
const CONFIGURATION_SUFFIXES = ['.js', '.jsx', '.mjs', '.cjs']
const CONFIGURATION_REPLACEMENTS = ['.ts', '.tsx']

/** Source files larger than this are generated payloads, not code to inspect. */
const MAX_SOURCE_BYTES = 1024 * 1024

/** How many files are read at once, so a large tree never bursts the process. */
const READ_CONCURRENCY = 24

/**
 * Dependency manifests whose change leaves an existing install stale. A sync
 * that rewrites one of these changes what the checkout needs on disk without
 * installing any of it.
 */
const DEPENDENCY_MANIFESTS = ['package.json', 'bun.lock', 'bun.lockb']

/** Every import, export-from, dynamic import and `require` in a source file. */
const SPECIFIER_PATTERN =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g

/**
 * Compare the tree before and after an integration in one git call, so the
 * caller learns both what was removed and what was touched.
 */
export async function integrationChanges(
  git: SimpleGit,
  beforeSha: string | null,
  afterSha: string | null
): Promise<GitIntegrationChanges> {
  if (!beforeSha || !afterSha || beforeSha === afterSha) return { deleted: [], changed: [] }

  // `-z` keeps paths byte-exact (git would otherwise quote and escape anything
  // unusual), and `--no-renames` reports a rename as the deletion and the
  // addition it really is, so a moved file is still inspected as a removal.
  const output = await git.raw(['diff', '--name-status', '--no-renames', '-z', beforeSha, afterSha])

  const fields = output.split('\0').filter((field) => field.length > 0)
  const deleted: string[] = []
  const changed: string[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index] ?? ''
    const path = toPosixPath(fields[index + 1] ?? '')
    if (path === '') continue
    changed.push(path)
    if (status.startsWith('D')) deleted.push(path)
  }
  return { deleted, changed }
}

/** The dependency manifests an integration rewrote, if any. */
export function changedDependencyManifests(changes: GitIntegrationChanges): string[] {
  return changes.changed.filter((path) => DEPENDENCY_MANIFESTS.includes(posixBasename(path)))
}

/**
 * Every import in `root` that names a module in `deletedPaths` and no longer
 * resolves. Returns an empty list as soon as there is nothing to look for, so
 * the probe costs nothing on the integrations that removed no file.
 */
export async function findDanglingReferences(
  root: string,
  deletedPaths: readonly string[],
  git: SimpleGit
): Promise<DanglingReference[]> {
  const orphans = orphanedNames(deletedPaths)
  if (orphans.size === 0) return []

  const aliases = await readPathAliases(root)
  const files = await trackedSourceFiles(git)
  const found: DanglingReference[] = []
  for (let index = 0; index < files.length; index += READ_CONCURRENCY) {
    const batch = files.slice(index, index + READ_CONCURRENCY)
    const scanned = await Promise.all(batch.map((file) => scanFile(root, file, orphans, aliases)))
    for (const references of scanned) found.push(...references)
  }
  return found.sort((left, right) => left.file.localeCompare(right.file))
}

/**
 * The names an orphaned module can be named by: its basename, and its stem
 * without the final extension, because a specifier writes `./widget` for
 * `widget.svelte` as often as it writes `./widget.svelte`.
 *
 * A directory's own `index` file is skipped: it is reached by the directory's
 * name, never by the word "index", so its stem would match every unrelated
 * directory import in the tree.
 */
function orphanedNames(deletedPaths: readonly string[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const deleted of deletedPaths) {
    const path = toPosixPath(deleted)
    const base = posixBasename(path)
    const stem = base.replace(/\.[^.]+$/, '')
    if (stem === '' || stem === 'index') continue
    if (!names.has(base)) names.set(base, path)
    if (!names.has(stem)) names.set(stem, path)
  }
  return names
}

/** The tracked source files of the checkout, as repo-relative POSIX paths. */
async function trackedSourceFiles(git: SimpleGit): Promise<string[]> {
  const output = await git.raw(['ls-files', '-z'])
  return output
    .split('\0')
    .map((path) => toPosixPath(path.trim()))
    .filter((path) => SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)))
}

/** Every specifier in one source file that names an orphaned module. */
async function scanFile(
  root: string,
  file: string,
  orphans: Map<string, string>,
  aliases: Map<string, string>
): Promise<DanglingReference[]> {
  const absolute = join(root, file)
  const references: DanglingReference[] = []
  let source: string
  try {
    const stats = statSync(absolute)
    if (!stats.isFile() || stats.size > MAX_SOURCE_BYTES) return references
    source = await readFile(absolute, 'utf8')
  } catch {
    // A file git tracks but that is not on disk: report nothing for it, the
    // dangling-reference question is about what the tree can resolve.
    return references
  }

  const seen = new Set<string>()
  for (const match of source.matchAll(SPECIFIER_PATTERN)) {
    const specifier = match[1]
    if (specifier === undefined || seen.has(specifier)) continue
    seen.add(specifier)

    const target = specifier.split('?')[0] ?? ''
    const deleted = orphans.get(posixBasename(target))
    if (deleted === undefined) continue
    if (resolvesInTree(target, dirname(absolute), aliases)) continue
    references.push({ file, specifier, deletedPath: deleted })
  }
  return references
}

/**
 * Whether a specifier still resolves. Only internal specifiers are considered:
 * a bare package name is not this checkout's file to lose, and a package that
 * shares a basename with a deleted source file must never be reported.
 */
function resolvesInTree(
  specifier: string,
  fromDirectory: string,
  aliases: Map<string, string>
): boolean {
  if (specifier.startsWith('.')) {
    return resolvesToFile(resolve(fromDirectory, specifier))
  }
  if (specifier.startsWith('/') || !isInternalSpecifier(specifier)) return true

  for (const [prefix, target] of aliases) {
    if (!specifier.startsWith(prefix)) continue
    return resolvesToFile(resolve(target, specifier.slice(prefix.length)))
  }

  // An internal specifier that no configured alias claims. Nothing here can
  // resolve it, and reporting it would blame this integration for a
  // pre-existing unknown alias, so it is treated as resolved.
  return true
}

/** A relative, or a configured-alias-shaped, specifier rather than a package. */
function isInternalSpecifier(specifier: string): boolean {
  return specifier.startsWith('$') || specifier.startsWith('@/') || specifier.startsWith('~/')
}

/**
 * Whether a path resolves the way a bundler would: the path itself, the path
 * with a source extension, the path with a TypeScript source written against
 * its emitted extension, or a directory's `index` file.
 */
function resolvesToFile(candidate: string): boolean {
  if (isFile(candidate)) return true
  for (const extension of SOURCE_EXTENSIONS) {
    if (isFile(candidate + extension)) return true
    if (isFile(join(candidate, `index${extension}`))) return true
  }
  for (const extension of CONFIGURATION_SUFFIXES) {
    if (!candidate.endsWith(extension)) continue
    const swapped = candidate.slice(0, -extension.length)
    for (const replacement of CONFIGURATION_REPLACEMENTS) {
      if (isFile(swapped + replacement)) return true
    }
  }
  return false
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

/**
 * The checkout's own alias map, read from `compilerOptions.paths` in its
 * tsconfig, which is where a Vite, Svelte or bundler alias is declared for the
 * editor as well. A tsconfig that cannot be read simply leaves aliases empty
 * and only relative specifiers are resolved; that is a smaller report, never a
 * wrong one.
 */
async function readPathAliases(root: string): Promise<Map<string, string>> {
  const aliases = new Map<string, string>()
  const seen = new Set<string>()
  let configPath: string | null = join(root, 'tsconfig.json')
  for (let depth = 0; depth < 2 && configPath !== null; depth += 1) {
    if (seen.has(configPath)) break
    seen.add(configPath)
    const parsed = await readJsonc(configPath)
    if (parsed === null) break
    const compilerOptions = parsed['compilerOptions']
    const paths =
      typeof compilerOptions === 'object' && compilerOptions !== null
        ? (compilerOptions as Record<string, unknown>)['paths']
        : undefined
    if (typeof paths === 'object' && paths !== null) {
      for (const [pattern, targets] of Object.entries(paths as Record<string, unknown>)) {
        if (!pattern.endsWith('/*') || !Array.isArray(targets)) continue
        const target = targets[0]
        if (typeof target !== 'string' || !target.endsWith('/*')) continue
        const prefix = pattern.slice(0, -1)
        if (aliases.has(prefix)) continue
        // `paths` entries are relative to the config that declares them.
        aliases.set(prefix, resolve(dirname(configPath), target.slice(0, -1)))
      }
    }
    const extended = parsed['extends']
    configPath =
      typeof extended === 'string' && extended.startsWith('.')
        ? resolveExtendedConfig(configPath, extended)
        : null
  }
  return aliases
}

/** Resolve a relative `extends`, trying the `.json` suffix tsconfig implies. */
function resolveExtendedConfig(from: string, extended: string): string | null {
  const candidate = resolve(dirname(from), extended)
  if (isFile(candidate)) return candidate
  if (isFile(`${candidate}.json`)) return `${candidate}.json`
  return null
}

/**
 * Read a JSON file that is allowed to carry comments and trailing commas, as
 * tsconfig does. The comment strip is quote-aware so a `//` inside a string
 * value survives.
 */
async function readJsonc(path: string): Promise<Record<string, unknown> | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  for (const attempt of [raw, stripJsonc(raw)]) {
    try {
      const parsed: unknown = JSON.parse(attempt)
      if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
    } catch {
      // Fall through to the relaxed pass, then give up on this config.
    }
  }
  return null
}

function stripJsonc(source: string): string {
  let output = ''
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? ''
    const next = source[index + 1] ?? ''
    if (inLineComment) {
      if (character === '\n') {
        inLineComment = false
        output += character
      }
      continue
    }
    if (inBlockComment) {
      if (character === '*' && next === '/') {
        inBlockComment = false
        index += 1
      }
      continue
    }
    if (inString) {
      output += character
      if (character === '\\') {
        output += next
        index += 1
        continue
      }
      if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      output += character
      continue
    }
    if (character === '/' && next === '/') {
      inLineComment = true
      index += 1
      continue
    }
    if (character === '/' && next === '*') {
      inBlockComment = true
      index += 1
      continue
    }
    output += character
  }
  // A trailing comma before a closing brace or bracket is legal in tsconfig.
  return output.replace(/,(\s*[}\]])/g, '$1')
}
