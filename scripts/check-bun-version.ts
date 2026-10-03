#!/usr/bin/env bun
/**
 * Verify that `.bun-version`, the single version every CI job installs, actually
 * satisfies the floor `package.json` declares in `engines.bun`.
 *
 * `.bun-version` is what `oven-sh/setup-bun` reads via `bun-version-file`, so it
 * is the only place a workflow can pin the toolchain. `engines.bun` is the
 * contract contributors and the app resolve against. Two files describing one
 * fact is drift waiting to happen, so this makes the disagreement visible on the
 * run that has it instead of as a bug report weeks later.
 *
 * Policy:
 *   - pinned below the declared floor -> error. CI would be running a toolchain
 *     the repo itself refuses to support.
 *   - pinned above the floor -> notice. A newer Bun is deliberate, not a mistake.
 *   - no floor declared -> notice. `.bun-version` then stands alone.
 *
 * Run from the repository root (the composite `setup` action does).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname ?? '.', '..')

function readTrimmed(relativePath: string): string {
  try {
    return readFileSync(resolve(repoRoot, relativePath), 'utf8').trim()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    write(`::error::Could not read ${relativePath}: ${reason}`)
    process.exit(1)
  }
}

function write(line: string): void {
  process.stdout.write(`${line}\n`)
}

/** Compare two dotted numeric versions. Returns a negative, zero, or positive number. */
function compare(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

const pinned = readTrimmed('.bun-version')

if (!/^\d+\.\d+\.\d+$/.test(pinned)) {
  write(`::error::.bun-version must be a plain major.minor.patch version, got "${pinned}"`)
  process.exit(1)
}

const manifest = JSON.parse(readTrimmed('package.json')) as {
  engines?: { bun?: string }
  packageManager?: string
}

const floorMatch = /^>=\s*(\d+\.\d+\.\d+)/.exec(manifest.engines?.bun ?? '')

if (!floorMatch) {
  write(
    `::notice::package.json declares no engines.bun floor; .bun-version (${pinned}) stands alone.`
  )
  process.exit(0)
}

const floor = floorMatch[1]
const comparison = compare(pinned, floor)

if (comparison < 0) {
  write(
    `::error::.bun-version (${pinned}) is below the floor package.json declares in engines.bun (>= ${floor}). CI would install a toolchain the repository refuses to support. Bump .bun-version.`
  )
  process.exit(1)
}

if (comparison > 0) {
  write(`::notice::.bun-version (${pinned}) is newer than the engines.bun floor (>= ${floor}).`)
} else {
  write(`check-bun-version: .bun-version matches the engines.bun floor (${pinned}).`)
}

const packageManager = manifest.packageManager ?? ''
if (packageManager && !packageManager.endsWith(`bun@${pinned}`)) {
  write(
    `::error::package.json packageManager is "${packageManager}" but .bun-version is ${pinned}. Bump both together: .bun-version is what CI installs, packageManager is what Bun itself enforces.`
  )
  process.exit(1)
}
