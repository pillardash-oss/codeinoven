/**
 * Enforces the hard 2000-line ceiling on authored source files.
 *
 * Reads every `.ts`, `.tsx`, `.mts`, `.cts`, `.svelte`, `.css`, `.scss` and
 * `.less` file under `src/`, `tests/`, `scripts/` and `services/` and fails when
 * any single file is longer than `MAX_SOURCE_FILE_LINES`. The policy itself
 * lives in `scripts/lib/file-size-policy.ts`, which is under a freeze notice,
 * and `tests/guards/file-size-limit.test.ts` asserts this check is still wired
 * into the release gate.
 *
 * Usage: `bun run check:file-size [root]`
 */
/// <reference types="node" />

import {
  MAX_SOURCE_FILE_LINES,
  SOURCE_FILE_EXTENSIONS,
  SOURCE_SCAN_ROOTS,
  findOversizedSourceFiles,
  formatOversizedSourceFilesReport,
  scanSourceFileSizes
} from './lib/file-size-policy'

const root = process.argv[2] ?? process.cwd()

const sizes = await scanSourceFileSizes(root)
const oversized = findOversizedSourceFiles(sizes)

if (sizes.length === 0) {
  // An empty scan means the walk is broken, not that the repository is clean.
  process.stderr.write(
    `No source files were found under ${SOURCE_SCAN_ROOTS.join(', ')} (root: ${root}). Refusing to report a pass.\n`
  )
  process.exit(1)
}

if (oversized.length > 0) {
  process.stderr.write(`${formatOversizedSourceFilesReport(oversized)}\n`)
  process.exit(1)
}

const heaviest = sizes.reduce((left, right) => (left.lines >= right.lines ? left : right))
process.stdout.write(
  `Checked ${sizes.length} source files (${SOURCE_FILE_EXTENSIONS.join(' ')}): all at or under ${MAX_SOURCE_FILE_LINES} lines. Heaviest: ${heaviest.path} (${heaviest.lines}).\n`
)
