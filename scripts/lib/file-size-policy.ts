/******************************************************************************
 *                                                                           *
 *   STOP.  THIS FILE DEFINES A HARD CEILING, NOT A SUGGESTION.              *
 *                                                                           *
 *   NO SOURCE FILE IN THIS REPOSITORY MAY GROW PAST 2000 LINES OF CODE.     *
 *   THAT IS A CEILING, NOT A TARGET, AND IT DOES NOT MOVE.                  *
 *                                                                           *
 *   YOU, THE AGENT READING THIS, ARE FORBIDDEN FROM RAISING, RELAXING,      *
 *   WIDENING, NARROWING, OR OTHERWISE WEAKENING THE POLICY BELOW.  NOT BY   *
 *   A LINE.  NOT BY EXCLUDING A DIRECTORY.  NOT BY DROPPING AN EXTENSION.   *
 *   NOT "JUST FOR THIS ONE FILE".  NOT TO GET CI GREEN.                     *
 *                                                                           *
 *   THE ONLY PERMITTED RESPONSE TO "THIS FILE IS TOO BIG" IS TO SPLIT IT    *
 *   BY CONCERN: one file per concern, a folder named after the file, the    *
 *   original path stays the composition root and keeps exporting exactly    *
 *   the same public API.  A SPLIT THAT CHANGES BEHAVIOUR IS NOT A SPLIT.    *
 *                                                                           *
 *   `tests/guards/file-size-limit.test.ts` asserts this policy is the one   *
 *   written here, word for word, and that the ceiling is still enforced by  *
 *   `verify:release` and by the Quality workflow.  Editing the policy to    *
 *   silence a failure makes that test fail, which is the point.            *
 *                                                                           *
 ******************************************************************************/
import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'

/**
 * The hard ceiling. A file at 2000 lines is legal, 2001 is not.
 *
 * ============================== DO NOT RAISE ==============================
 * Raising this number, or excluding a directory or an extension to get under
 * it, is prohibited. The ceiling exists because a file that big cannot be
 * read, reviewed or safely changed by anyone, human or agent. Split the file
 * by concern instead.
 * ==========================================================================
 */
export const MAX_SOURCE_FILE_LINES = 2000

/**
 * Which files count as source. `.js` is deliberately absent: the JavaScript
 * files in `src/` are browser-extension compat shims and vendored runtime
 * preambles that are shipped as-is, not authored modules (see
 * `src/main/browser/extensions/compat/`). Everything listed here is a file a
 * contributor writes and maintains, so everything listed here is bounded.
 */
export const SOURCE_FILE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.svelte',
  '.css',
  '.scss',
  '.less'
] as const

/** Every authored source tree in this repository. */
export const SOURCE_SCAN_ROOTS = ['src', 'tests', 'scripts', 'services'] as const

/**
 * Generated, vendored or disposable directories. None of these hold authored
 * source, and every entry here is a build output or a dependency tree rather
 * than a place a contributor writes code.
 */
export const IGNORED_DIRECTORY_NAMES = [
  'node_modules',
  '.git',
  '.cio',
  '.svelte-check',
  '.svelte-kit',
  'out',
  'dist',
  'build',
  'coverage'
] as const

/** A single scanned file and its byte-accurate line count. */
export interface SourceFileSize {
  /** Project-root-relative path, always with forward slashes. */
  path: string
  lines: number
}

const sourceExtensionSet: ReadonlySet<string> = new Set(SOURCE_FILE_EXTENSIONS)
const ignoredDirectorySet: ReadonlySet<string> = new Set(IGNORED_DIRECTORY_NAMES)

// Line counting is I/O bound on a cold page cache, so the walk keeps this many
// reads in flight. It is small on purpose: the whole tree is read on every
// Quality run and this check must never be the reason a test job is slow.
const READ_CONCURRENCY = 16

function toProjectPath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/')
}

async function collectSourceFiles(root: string, currentDirectory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(currentDirectory, { withFileTypes: true })
  } catch {
    // A scan root that does not exist is simply nothing to scan. CI checks out
    // the whole repository, so a missing root can only mean it was never there.
    return []
  }

  const directories: string[] = []
  const files: string[] = []

  for (const entry of entries) {
    const absolutePath = join(currentDirectory, entry.name)
    if (entry.isDirectory()) {
      if (!ignoredDirectorySet.has(entry.name)) {
        directories.push(absolutePath)
      }
      continue
    }
    if (entry.isFile() && sourceExtensionSet.has(extname(entry.name).toLowerCase())) {
      files.push(absolutePath)
    }
  }

  const nested = await Promise.all(
    directories.map((directory) => collectSourceFiles(root, directory))
  )
  return files.concat(...nested)
}

/**
 * Counts lines the way `wc -l` does, except that a final line without a
 * trailing newline still counts. Counting bytes rather than decoding the file
 * keeps a large `.ttf`-adjacent binary or an unusual encoding from turning a
 * size check into a crash.
 */
async function countLines(absolutePath: string): Promise<number> {
  const contents = await readFile(absolutePath)
  if (contents.length === 0) {
    return 0
  }
  let newlines = 0
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] === 10) {
      newlines += 1
    }
  }
  return contents[contents.length - 1] === 10 ? newlines : newlines + 1
}

/**
 * Reads every authored source file under {@link SOURCE_SCAN_ROOTS} and returns
 * its line count, sorted by path so a failure report is stable between runs.
 */
export async function scanSourceFileSizes(
  root: string = process.cwd(),
  scanRoots: readonly string[] = SOURCE_SCAN_ROOTS
): Promise<SourceFileSize[]> {
  const collected = (
    await Promise.all(scanRoots.map((scanRoot) => collectSourceFiles(root, join(root, scanRoot))))
  ).flat()

  const sizes: SourceFileSize[] = new Array(collected.length)
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= collected.length) {
        return
      }
      const absolutePath = collected[index]
      sizes[index] = {
        lines: await countLines(absolutePath),
        path: toProjectPath(root, absolutePath)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, collected.length) }, () => worker())
  )

  return sizes.sort((left, right) => left.path.localeCompare(right.path))
}

/** Every file over the ceiling, heaviest first. */
export function findOversizedSourceFiles(sizes: readonly SourceFileSize[]): SourceFileSize[] {
  return sizes
    .filter((size) => size.lines > MAX_SOURCE_FILE_LINES)
    .sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path))
}

/** A human-readable failure report naming every file over the ceiling. */
export function formatOversizedSourceFilesReport(oversized: readonly SourceFileSize[]): string {
  const lines = [`These source files exceed the hard ${MAX_SOURCE_FILE_LINES}-line ceiling:`, '']
  for (const file of oversized) {
    lines.push(`  ${file.lines.toString().padStart(5)} lines  ${file.path}`)
  }
  lines.push(
    '',
    'Split each one by concern into a folder named after the file: the original path becomes',
    'the composition root and keeps exporting the same public API, and each extracted unit',
    'owns exactly one concern. Never raise the ceiling, never exclude a directory or an',
    `extension instead. See scripts/lib/file-size-policy.ts and AGENTS.md.`
  )
  return lines.join('\n')
}
