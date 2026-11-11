/**
 * Homebrew ownership of a harness binary.
 *
 * A harness installed by Homebrew belongs to Homebrew: its vendor updater
 * refuses to touch it (Claude Code answers `claude update` with "Claude is
 * managed by Homebrew"), so the only update that works is `brew upgrade`.
 * The resolved binary path is the authority   a Homebrew launcher is a `bin/`
 * symlink into `Cellar/<formula>/` or `Caskroom/<cask>/`, which names both the
 * package and whether it is a cask.
 */
import { realpath } from 'node:fs/promises'
import { runHarnessCommand } from '../drivers/harness-runtime'
import { buildProcessEnvironmentAsync } from '../drivers/cli-environment'

export type HomebrewPackageKind = 'cask' | 'formula'

export interface HomebrewPackage {
  kind: HomebrewPackageKind
  /** The installed package name, e.g. `claude-code` or `anomalyco/tap/opencode-v2`. */
  name: string
}

/** A Homebrew launcher that points at a cask's staged payload. */
const CASKROOM_SEGMENT = /\/Caskroom\/([^/]+)\//u
/** A Homebrew launcher that points at a formula's keg. */
const CELLAR_SEGMENT = /\/Cellar\/([^/]+)\//u

/**
 * The Homebrew package that owns this binary, or `null` when Homebrew is not
 * what installed it. A `node_modules` copy living under a Homebrew prefix is
 * not a Homebrew package, so only the Cellar and Caskroom layouts count.
 */
export async function homebrewPackageFor(
  resolvedPath: string | undefined
): Promise<HomebrewPackage | null> {
  if (!resolvedPath || process.platform === 'win32') return null
  // The launcher itself sits in `bin/`, so its symlink target is what names the
  // package. An unresolvable path is read as given rather than as a failure.
  const target = await realpath(resolvedPath).catch(() => resolvedPath)
  const normalized = target.replace(/\\/gu, '/')
  const cask = CASKROOM_SEGMENT.exec(normalized)?.[1]
  if (cask) return { kind: 'cask', name: cask }
  const formula = CELLAR_SEGMENT.exec(normalized)?.[1]
  if (formula) return { kind: 'formula', name: formula }
  return null
}

/** The `brew upgrade` arguments that move a Homebrew-owned install forward. */
export function homebrewUpgradeArgs(pkg: HomebrewPackage): string[] {
  return ['upgrade', ...(pkg.kind === 'cask' ? ['--cask'] : []), pkg.name]
}

/** What Homebrew itself knows about one package: what is installed, what it can install. */
export interface HomebrewVersions {
  installed?: string
  latest?: string
}

/** Reuse Homebrew's answer across rows and repeated check passes. */
const VERSIONS_CACHE_TTL_MS = 5 * 60_000
const VERSIONS_TIMEOUT_MS = 8_000
const VERSIONS_MAX_BYTES = 1024 * 1024

const versionsCache = new Map<string, { at: number; versions: HomebrewVersions }>()
const versionsInFlight = new Map<string, Promise<HomebrewVersions | null>>()

/**
 * Homebrew's own view of a package's versions.
 *
 * A Homebrew-owned install must be measured against what Homebrew can actually
 * install, not against a registry another channel publishes: a tap and an npm
 * package can sit on different version lines, and a badge that a `brew upgrade`
 * cannot clear is worse than no badge at all. `null` means Homebrew could not
 * answer, so the caller falls back to the published feed.
 */
export async function homebrewVersions(pkg: HomebrewPackage): Promise<HomebrewVersions | null> {
  const key = `${pkg.kind}:${pkg.name}`
  const cached = versionsCache.get(key)
  if (cached && Date.now() - cached.at < VERSIONS_CACHE_TTL_MS) return cached.versions
  const active = versionsInFlight.get(key)
  if (active) return active

  const lookup = readVersions(pkg).finally(() => versionsInFlight.delete(key))
  versionsInFlight.set(key, lookup)
  const versions = await lookup
  if (versions) versionsCache.set(key, { at: Date.now(), versions })
  return versions
}

async function readVersions(pkg: HomebrewPackage): Promise<HomebrewVersions | null> {
  try {
    // `brew update` is never run here: a metadata refresh can take minutes, and
    // reading the local taps keeps the check as cheap as the version probe. The
    // full app environment is passed because an invocation's `env` replaces the
    // child's environment outright, and brew needs the same PATH the app uses.
    const env = {
      ...(await buildProcessEnvironmentAsync()),
      HOMEBREW_NO_AUTO_UPDATE: '1',
      HOMEBREW_NO_ENV_HINTS: '1'
    }
    const { stdout } = await runHarnessCommand(
      'brew',
      ['info', '--json=v2', ...(pkg.kind === 'cask' ? ['--cask'] : []), pkg.name],
      {
        timeoutMs: VERSIONS_TIMEOUT_MS,
        maxOutputBytes: VERSIONS_MAX_BYTES,
        env
      }
    )
    const body: unknown = JSON.parse(stdout)
    return pkg.kind === 'cask' ? caskVersions(body) : formulaVersions(body)
  } catch {
    return null
  }
}

function caskVersions(body: unknown): HomebrewVersions | null {
  const cask = readArray(body, 'casks')[0]
  if (!cask) return null
  return { installed: readString(cask, 'installed'), latest: readString(cask, 'version') }
}

function formulaVersions(body: unknown): HomebrewVersions | null {
  const formula = readArray(body, 'formulae')[0]
  if (!formula) return null
  const stable = readRecord(formula, 'versions')
  const installed = readArray(formula, 'installed')[0]
  return {
    installed: installed ? readString(installed, 'version') : undefined,
    latest: stable ? readString(stable, 'stable') : undefined
  }
}

function readRecord(source: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function readArray(source: unknown, key: string): Record<string, unknown>[] {
  if (typeof source !== 'object' || source === null) return []
  const value = (source as Record<string, unknown>)[key]
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null
  )
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
