#!/usr/bin/env bun
/**
 * Verify that `.bun-version`, the single version every CI job installs, exactly
 * matches the version declared in `package.json`.
 *
 * `.bun-version` is what `oven-sh/setup-bun` reads via `bun-version-file`, so it
 * is the only place a workflow can pin the toolchain. `engines.bun` is the
 * contract contributors and the app resolve against. Three files describing one
 * fact is drift waiting to happen, so this makes the disagreement visible on the
 * run that has it instead of as a bug report weeks later.
 *
 * Policy: `engines.bun`, `packageManager`, and `.bun-version` must all name the
 * same exact version. CI and local development then use the same toolchain.
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

const pinned = readTrimmed('.bun-version')

if (!/^\d+\.\d+\.\d+$/.test(pinned)) {
  write(`::error::.bun-version must be a plain major.minor.patch version, got "${pinned}"`)
  process.exit(1)
}

const manifest = JSON.parse(readTrimmed('package.json')) as {
  engines?: { bun?: string }
  packageManager?: string
}

const engineVersion = manifest.engines?.bun ?? ''
const exactEngineMatch = /^>=\s*(\d+\.\d+\.\d+)$/.exec(engineVersion)

if (!exactEngineMatch) {
  write(`::error::package.json engines.bun must declare the exact pinned version as >=${pinned}.`)
  process.exit(1)
}

if (exactEngineMatch[1] !== pinned) {
  write(
    `::error::package.json engines.bun is "${engineVersion}" but .bun-version is ${pinned}. Set both to the same exact version.`
  )
  process.exit(1)
}

const packageManager = manifest.packageManager ?? ''
if (packageManager !== `bun@${pinned}`) {
  write(
    `::error::package.json packageManager is "${packageManager}" but .bun-version is ${pinned}. Set both to bun@${pinned}.`
  )
  process.exit(1)
}

if (Bun.version !== pinned) {
  write(
    `::error::Running Bun ${Bun.version} does not match the repository pin ${pinned}. Use the version in .bun-version.`
  )
  process.exit(1)
}

write(`check-bun-version: .bun-version, engines.bun, and packageManager match (${pinned}).`)
