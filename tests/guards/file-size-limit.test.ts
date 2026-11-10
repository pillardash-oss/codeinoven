/******************************************************************************
 *                                                                           *
 *   STOP.  THIS GUARD IS NOT NEGOTIABLE AND NOT EDITABLE TO GET GREEN.      *
 *                                                                           *
 *   It enforces one promise: no authored source file in this repository     *
 *   grows past 2000 lines of code, and the check that says so is wired into *
 *   the release gate.  Every assertion below exists to make a silent bypass *
 *   impossible: the ceiling, the extension list, the scan roots and the     *
 *   ignore list are all pinned to exact literals, the scanned inventory is  *
 *   pinned to a floor so a broken glob cannot "pass", named anchor files    *
 *   must appear in the inventory so a broad exclusion cannot hide a         *
 *   directory, and the file re-reads its own source to refuse a disabled    *
 *   or focused test.                                                        *
 *                                                                           *
 *   DO NOT: raise the ceiling, delete an extension, add an ignore entry,    *
 *   exclude a path, loosen an assertion, or remove this file.  The correct  *
 *   fix for "a file is too big" is to split that file by concern, keeping   *
 *   its public API identical.  Read scripts/lib/file-size-policy.ts first.  *
 *                                                                           *
 ******************************************************************************/
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  IGNORED_DIRECTORY_NAMES,
  MAX_SOURCE_FILE_LINES,
  SOURCE_FILE_EXTENSIONS,
  SOURCE_SCAN_ROOTS,
  findOversizedSourceFiles,
  formatOversizedSourceFilesReport,
  scanSourceFileSizes
} from '../../scripts/lib/file-size-policy'

const projectRoot = join(import.meta.dirname, '..', '..')

// A token that must survive in this file's own source. It is the cheap tripwire
// for "someone emptied the file instead of deleting it".
const GUARD_CANARY = 'FILE-SIZE-GUARD-CANARY'

// One test file cannot guard its own deletion, so the same ceiling is also
// enforced by the `check:file-size` script, which `verify:release` and the
// Quality workflow both run directly. The wiring assertions below fail if that
// script or its callers are removed.
const GUARDED_SCRIPT = 'bun scripts/check-file-size.ts'

// Files a whole-repository walk must always reach. If the walk silently stops
// covering a tree, one of these stops appearing and the inventory test fails
// instead of quietly reporting a clean run over nothing.
const ANCHOR_FILES = [
  'src/main/index.ts',
  'src/renderer/App.svelte',
  'scripts/lib/file-size-policy.ts',
  'scripts/check-file-size.ts',
  'tests/guards/file-size-limit.test.ts'
]

// The inventory this repository actually has is ~3200 authored files. The floor
// sits below that but far above any single directory, so an accidental or
// deliberate exclusion of a tree fails here.
const MINIMUM_SCANNED_FILES = 3000

describe('source file size ceiling', () => {
  it('keeps the frozen policy exactly as written', () => {
    expect(MAX_SOURCE_FILE_LINES).toBe(2000)
    expect([...SOURCE_FILE_EXTENSIONS]).toEqual(['.ts', '.svelte'])
    expect([...SOURCE_SCAN_ROOTS]).toEqual(['src', 'tests', 'scripts', 'services'])
    expect([...IGNORED_DIRECTORY_NAMES]).toEqual([
      'node_modules',
      '.git',
      '.cio',
      '.svelte-check',
      '.svelte-kit',
      'out',
      'dist',
      'build',
      'coverage'
    ])
  })

  it('scans the whole authored tree', async () => {
    const sizes = await scanSourceFileSizes(projectRoot)
    const scannedPaths = new Set(sizes.map((size) => size.path))

    expect(sizes.length).toBeGreaterThanOrEqual(MINIMUM_SCANNED_FILES)
    expect([...scannedPaths].filter((path) => ANCHOR_FILES.includes(path))).toEqual(
      [...ANCHOR_FILES].sort()
    )
  })

  it('keeps every source file at or under 2000 lines', async () => {
    const sizes = await scanSourceFileSizes(projectRoot)
    const oversized = findOversizedSourceFiles(sizes)

    expect(
      oversized.map((file) => `${file.path}: ${file.lines}`),
      formatOversizedSourceFilesReport(oversized)
    ).toEqual([])

    // Sanity: the ceiling really is compared against, not merely declared.
    expect(
      findOversizedSourceFiles([{ lines: MAX_SOURCE_FILE_LINES, path: 'at-limit.ts' }])
    ).toEqual([])
    expect(
      findOversizedSourceFiles([{ lines: MAX_SOURCE_FILE_LINES + 1, path: 'over-limit.ts' }])
    ).toHaveLength(1)
  })

  it('stays wired into the release gate', async () => {
    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const qualityWorkflow = await readFile(
      join(projectRoot, '.github', 'workflows', 'quality.yml'),
      'utf8'
    )
    const vitestConfig = await readFile(join(projectRoot, 'vitest.config.ts'), 'utf8')

    // The standalone gate, the aggregate verify chain, the release chain and CI.
    expect(packageJson.scripts['check:file-size']).toBe(GUARDED_SCRIPT)
    expect(packageJson.scripts.verify).toContain('bun run check:file-size')
    expect(packageJson.scripts['verify:release']).toContain('bun run verify')
    expect(qualityWorkflow).toContain('bun run check:file-size')
    // The guard test is only a gate while the suite that CI runs picks it up.
    expect(vitestConfig).toContain("include: ['tests/**/*.test.ts']")
  })

  it('cannot be disarmed inside its own file', async () => {
    const ownSource = await readFile(
      join(projectRoot, 'tests', 'guards', 'file-size-limit.test.ts'),
      'utf8'
    )

    expect(ownSource).toContain(GUARD_CANARY)
    expect(ownSource).toMatch(/this\.file|file-size-limit/)
    // No focused, skipped, pending or commented-out form of the suite.
    expect(ownSource).not.toMatch(/\b(?:describe|it|test)\.(?:skip|only|todo|fails)\b/)
    expect(ownSource).not.toMatch(/\b(?:xit|xdescribe|fit|fdescribe)\s*\(/)
    expect(ownSource).not.toMatch(/\bdescribeIf\b|\bitIf\b/)
  })
})
