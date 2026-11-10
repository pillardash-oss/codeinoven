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
 * Shims still imported through `?raw`, pinned to the exact set.
 *
 * Every entry here is unchecked source, and the list may only shrink. The preamble
 * is the last one: it is 3622 lines of one closure, so it is converted together
 * with the by-concern split that also brings it under the line ceiling.
 */
const UNCHECKED_SHIMS_PENDING_CONVERSION = ['cio-compat-preamble.js'] as const

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
    expect(unchecked).toEqual([...UNCHECKED_SHIMS_PENDING_CONVERSION])

    // `.ts` is what puts a shim back inside the ceiling and the type checker, so
    // there has to be more than one of them.
    const checked = shims.filter((name) => name.endsWith('.ts'))
    expect(checked.length).toBeGreaterThanOrEqual(7)
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

  it('reaches every checked shim through ?compat-source, never ?raw', async () => {
    const specifiers = await findShimImports()
    const throughRaw = specifiers.filter(
      (specifier) => specifier.includes('?raw') && !specifier.includes('cio-bridge.page.html')
    )

    for (const specifier of throughRaw) {
      const [file, imported] = specifier.split(' -> ')
      // The preamble is the last unchecked shim, and each importer reaches it by
      // the path that suits it, plus the `?raw` query that makes it unchecked, so
      // match the file name rather than a path prefix nobody guarantees.
      const importedPath = imported.split('?')[0]
      expect(
        [...UNCHECKED_SHIMS_PENDING_CONVERSION].some((name) =>
          importedPath.endsWith(`compat/${name}`)
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
  })
})
