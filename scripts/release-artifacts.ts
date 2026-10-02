#!/usr/bin/env bun
/**
 * The single definition of what a CodeInOven release contains.
 *
 * The installer extension list used to be spelled out six times across the
 * nightly and stable workflows: once in the artifact upload globs, once in the
 * checksum `find`, and once in the publish `find`, in both files. Adding a
 * format meant editing six places, and a checksum list that disagreed with the
 * publish list ships artifacts nobody can verify.
 *
 * This module owns the list. Checksums and publishing both go through it, so
 * they cannot drift apart; the artifact upload globs stay literal YAML because
 * `actions/upload-artifact` cannot read a computed `path`, and `upload-globs`
 * prints the authoritative copy of those lines to keep them checkable.
 *
 * Usage (from the repository root):
 *   bun scripts/release-artifacts.ts installers      # one extension per line
 *   bun scripts/release-artifacts.ts upload-globs    # the dist/*.ext upload lines
 *   bun scripts/release-artifacts.ts checksums --dir artifacts
 *   bun scripts/release-artifacts.ts paths --dir artifacts
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/** Installer formats a release publishes. Everything else is metadata. */
const INSTALLER_EXTENSIONS = ['dmg', 'zip', 'exe', 'AppImage', 'deb'] as const

/**
 * electron-updater's per-channel feeds. Not installers, so they carry no
 * checksum entry, but they must be uploaded alongside the installers or the
 * in-app updater cannot find a release.
 */
const UPDATE_FEED_EXTENSIONS = ['blockmap', 'yml'] as const

/** Checksum manifest filename, published as a release asset in its own right. */
const MANIFEST_NAME = 'SHA256SUMS.txt'

type Artifact = { name: string; absolutePath: string }

function write(line: string): void {
  process.stdout.write(`${line}\n`)
}

function fail(message: string): never {
  write(`::error::${message}`)
  process.exit(1)
}

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) continue
    const key = argument.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      flags.set(key, 'true')
    } else {
      flags.set(key, next)
      index += 1
    }
  }
  return flags
}

/** Depth-first listing of every file under `directory`, sorted by relative path. */
function listFiles(directory: string): Artifact[] {
  const root = resolve(directory)
  const collected: Artifact[] = []

  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const absolutePath = join(current, entry)
      if (statSync(absolutePath).isDirectory()) {
        walk(absolutePath)
        continue
      }
      collected.push({ name: entry, absolutePath })
    }
  }

  walk(root)
  return collected
}

function hasExtension(name: string, extensions: readonly string[]): boolean {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  return extensions.includes(name.slice(dot + 1))
}

/** sha256 of a file, as lowercase hex. */
async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(await Bun.file(path).arrayBuffer())
  return hasher.digest('hex')
}

/**
 * Path form the published manifest has always used: `sha256sum` writes
 * `hash`, two spaces, then the path exactly as `find` printed it, which is
 * `./name` relative to the artifacts root. Users verify with `sha256sum -c`,
 * so changing either half would break them.
 */
function manifestPath(directory: string, name: string): string {
  const relativePath = relative(resolve(directory), resolve(directory, name)).split(sep).join('/')
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`
}

async function checksums(directory: string): Promise<void> {
  const installers = listFiles(directory).filter((file) =>
    hasExtension(file.name, INSTALLER_EXTENSIONS)
  )

  if (installers.length === 0) {
    fail(
      `No release installers found under ${directory}. Expected at least one of: ${INSTALLER_EXTENSIONS.map((extension) => `*.${extension}`).join(', ')}.`
    )
  }

  const lines: string[] = []
  for (const installer of installers) {
    lines.push(
      `${await sha256(installer.absolutePath)}  ${manifestPath(directory, installer.name)}`
    )
  }

  writeFileSync(join(resolve(directory), MANIFEST_NAME), `${lines.join('\n')}\n`)

  write('artifacts listing:')
  for (const file of listFiles(directory)) {
    write(manifestPath(directory, file.name))
  }
  write(`${MANIFEST_NAME}:`)
  for (const line of lines) write(line)
}

/** Every asset to attach to the GitHub release: installers, update feeds, manifest. */
function publishPaths(directory: string): Artifact[] {
  const files = listFiles(directory)
  const assets = files.filter(
    (file) =>
      file.name !== MANIFEST_NAME &&
      (hasExtension(file.name, INSTALLER_EXTENSIONS) ||
        hasExtension(file.name, UPDATE_FEED_EXTENSIONS) ||
        file.name === MANIFEST_NAME)
  )

  if (assets.length === 0) {
    fail(`No release assets found under ${directory}.`)
  }
  return assets
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const flags = parseFlags(rest)

  switch (command) {
    case 'installers':
      for (const extension of INSTALLER_EXTENSIONS) write(extension)
      return

    case 'upload-globs':
      for (const extension of INSTALLER_EXTENSIONS) write(`dist/*.${extension}`)
      for (const extension of UPDATE_FEED_EXTENSIONS) write(`dist/*.${extension}`)
      return

    case 'checksums':
      await checksums(flags.get('dir') ?? fail('checksums requires --dir'))
      return

    case 'paths': {
      const directory = flags.get('dir') ?? fail('paths requires --dir')
      // Repo-relative (`artifacts/CodeInOven-0.5.58.dmg`), matching the `find
      // artifacts ...` form this replaced. gh labels each asset by its basename
      // either way, but the log lines a failed publish prints stay readable.
      const base = resolve(directory, '..')
      for (const asset of publishPaths(directory)) {
        write(relative(base, asset.absolutePath).split(sep).join('/'))
      }
      return
    }

    default:
      fail(
        `Unknown command "${command ?? ''}". Expected one of: installers, upload-globs, checksums, paths.`
      )
  }
}

await main()
