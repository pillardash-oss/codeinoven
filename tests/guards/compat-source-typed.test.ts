/**
 * Guards the rule that every injected compatibility shim is checked source.
 *
 * WHY THIS FILE EXISTS
 * The shims in `src/main/browser/extensions/compat/` used to be `.js` files
 * imported through Vite's `?raw`, which returns a file's exact bytes. Nothing ever
 * parsed them: not TypeScript, not the type-aware lint rules, and not the
 * 2000-line ceiling, which deliberately ignored `.js`. A 3622-line shim lived here
 * unchecked for months as a result, and a typo in it only surfaced as a silently
 * broken password manager or content blocker inside an installed extension.
 *
 * They are authored `.ts` now and reached through `?compat-source`, which compiles
 * them at build time (see `scripts/lib/compat-source-compiler.ts`). This guard
 * fails if anyone reintroduces the unchecked path, and it pins the one file that is
 * still waiting for its own split so the exception cannot quietly grow.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

import { MAX_SOURCE_FILE_LINES, scanSourceFileSizes } from '../../scripts/lib/file-size-policy'

const projectRoot = join(import.meta.dirname, '..', '..')
const compatDirectory = join(projectRoot, 'src', 'main', 'browser', 'extensions', 'compat')

/**
 * Shims still imported through `?raw`. The list is empty, and no entry may be added:
 * the last one, `cio-compat-preamble.js`, is now the typed module tree in
 * `compat/preamble/`, injected through `?compat-bundle`.
 */
const UNCHECKED_SHIMS_PENDING_CONVERSION: readonly string[] = []

async function listShims(): Promise<string[]> {
  const entries = await readdir(compatDirectory, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
}

/** Every `?raw` and `?compat-source` import specifier under the extension modules. */
async function findShimImports(): Promise<string[]> {
  const root = join(projectRoot, 'src', 'main', 'browser', 'extensions')
  const specifiers: string[] = []
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(absolutePath)
        continue
      }
      if (!entry.isFile() || !/\.(?:ts|svelte)$/u.test(entry.name)) continue
      const source = await readFile(absolutePath, 'utf8')
      for (const match of source.matchAll(/['"](\.[^'"]*compat\/[^'"]*)['"]/gu)) {
        specifiers.push(`${relative(projectRoot, absolutePath)} -> ${match[1]}`)
      }
    }
  }
  await walk(root)
  return specifiers.sort()
}

describe('injected compatibility shims are checked source', () => {
  it('keeps the unchecked inventory inside the pinned list', async () => {
    const shims = await listShims()
    const unchecked = shims.filter((name) => name.endsWith('.js'))
    // No `.js` may live here again: an injected shim in this folder is exactly the
    // shape that was invisible to the type checker, the linter and the ceiling.
    expect(unchecked).toEqual([...UNCHECKED_SHIMS_PENDING_CONVERSION])
    expect(unchecked).toEqual([])

    // `.ts` is what puts a shim back inside the ceiling and the type checker.
    const checked = shims.filter((name) => name.endsWith('.ts'))
    expect(checked.length).toBeGreaterThanOrEqual(7)

    // The preamble's by-concern split, one file per concern.
    const preamble = await readdir(join(compatDirectory, 'preamble'), { withFileTypes: true })
    const modules = preamble.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    expect(modules.length).toBeGreaterThanOrEqual(20)
    expect(modules.map((entry) => entry.name)).toContain('index.ts')
  })

  it('counts every checked shim in the file-size policy scan', async () => {
    const sizes = await scanSourceFileSizes(projectRoot)
    const checkedShims = (await listShims()).filter((name) => name.endsWith('.ts'))

    for (const name of checkedShims) {
      const path = `src/main/browser/extensions/compat/${name}`
      const size = sizes.find((candidate) => candidate.path === path)
      // A shim missing from the scan is a shim outside the ceiling again.
      expect(size, `${path} is not scanned by the file-size policy`).toBeDefined()
      expect(size?.lines ?? 0).toBeLessThanOrEqual(MAX_SOURCE_FILE_LINES)
    }
  })

  it('reaches every checked shim through the compiler queries, never ?raw', async () => {
    const specifiers = await findShimImports()
    const throughRaw = specifiers.filter(
      (specifier) => specifier.includes('?raw') && !specifier.includes('cio-bridge.page.html')
    )

    // Nothing in `compat/` is reached as raw bytes any more: a `?raw` import is a
    // file no check in this repository ever reads.
    for (const specifier of throughRaw) {
      const [file, imported] = specifier.split(' -> ')
      expect(
        [...UNCHECKED_SHIMS_PENDING_CONVERSION].some((name) =>
          imported.split('?')[0].endsWith(`compat/${name}`)
        ),
        `${file} imports ${imported} through ?raw, which leaves it unchecked`
      ).toBe(true)
    }

    const converted = specifiers.filter((specifier) => specifier.includes('?compat-source'))
    expect(converted.length).toBeGreaterThanOrEqual(9)
    for (const specifier of converted) {
      const imported = specifier.split(' -> ')[1]
      expect(imported.startsWith('./compat/'), `${specifier} is not a compat shim`).toBe(true)
      expect(imported.endsWith('.ts?compat-source'), `${specifier} must name a .ts shim`).toBe(true)
    }

    // The preamble is the one shim large enough to be a module tree, and it is
    // bundled rather than transformed, so it is reached through its own query.
    const bundled = specifiers.filter((specifier) => specifier.includes('?compat-bundle'))
    expect(bundled.length).toBe(1)
    expect(bundled[0]).toContain('-> ../compat/preamble/index.ts?compat-bundle')
  })

  it('has the compiler wired into the main build, the test run and typed for importers', async () => {
    const config = await readFile(join(projectRoot, 'electron.vite.config.ts'), 'utf8')
    expect(config).toMatch(/from '\.\/scripts\/lib\/vite-compat-source-plugin(?:\.ts)?'/)
    expect(config).toMatch(/main: \{[^}]*plugins: \[\s*compatSourcePlugin\(\)/u)

    // A test that imports one of the modules holding a shim would otherwise fail
    // on the query instead of on the code it was written to check.
    const vitestConfig = await readFile(join(projectRoot, 'vitest.config.ts'), 'utf8')
    expect(vitestConfig).toMatch(/from '\.\/scripts\/lib\/vite-compat-source-plugin(?:\.ts)?'/)
    expect(vitestConfig).toMatch(/plugins: \[[^\]]*compatSourcePlugin\(\)/u)

    const declaration = await readFile(
      join(projectRoot, 'src', 'main', 'types', 'source-assets.d.ts'),
      'utf8'
    )
    expect(declaration).toContain("declare module '*?compat-source'")
    expect(declaration).toContain("declare module '*?compat-bundle'")
  })
})
