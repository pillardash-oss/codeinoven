import { existsSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** Parse a versioned nvm dir name like `v24.18.0` into `[major, minor, patch]`. */
function parseVersion(name: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(name)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Descending semver comparison for versioned dir names; unparseable sorts last. */
function compareVersionsDescending(a: string, b: string): number {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (!va) return 1
  if (!vb) return -1
  for (let i = 0; i < 3; i++) {
    if ((va[i] ?? 0) !== (vb[i] ?? 0)) return (vb[i] ?? 0) - (va[i] ?? 0)
  }
  return 0
}

/** Platform PATH list separator. */
function pathSeparator(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':'
}

/** Locate the nvm root the user has installed for the current platform. */
function nvmRoot(base: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    // nvm-windows stores versions under NVM_HOME (default %APPDATA%\nvm).
    return base['NVM_HOME'] ?? join(base['APPDATA'] ?? homedir(), 'nvm')
  }
  return join(base['HOME'] ?? homedir(), '.nvm')
}

/** Installed version dir names (e.g. `v24.18.0`), newest-first. */
function installedVersionNames(root: string, platform: NodeJS.Platform): string[] {
  const versionsRoot = platform === 'win32' ? root : join(root, 'versions', 'node')
  try {
    return readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && parseVersion(entry.name))
      .map((entry) => entry.name)
      .sort(compareVersionsDescending)
  } catch {
    return []
  }
}

/** Bin dir for a versioned dir — nvm-windows keeps node.exe in the version dir itself. */
function versionBinDir(root: string, version: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? join(root, version) : join(root, 'versions', 'node', version, 'bin')
}

/** Read an nvm alias file relative to the nvm root, trimmed. */
function readAlias(root: string, relativePath: string): string | undefined {
  try {
    return readFileSync(join(root, relativePath), 'utf8').trim()
  } catch {
    return undefined
  }
}

/**
 * Resolve an nvm alias value (e.g. `24`, `v24.18.0`, `lts/*`, `lts/iron`) to a
 * concrete installed version name. Falls back to the newest installed version.
 */
function resolveAliasToVersion(
  root: string,
  alias: string,
  installed: string[],
  depth = 0
): string | undefined {
  if (depth > 3) return undefined
  const value = alias.trim()
  if (!value || installed.length === 0) return undefined

  if (installed.includes(value)) return value
  const withoutV = value.replace(/^v/u, '')
  const exact = installed.find((v) => v.replace(/^v/u, '') === withoutV)
  if (exact) return exact

  const major = /^(\d+)$/u.exec(value)
  if (major) {
    return installed.find((v) => parseVersion(v)?.[0] === Number(major[1]))
  }

  if (value === 'lts/*') {
    const ltsWildcard = readAlias(root, join('alias', 'lts', '*'))
    if (ltsWildcard) return resolveAliasToVersion(root, ltsWildcard, installed, depth + 1)
    return installed[0]
  }

  if (value.startsWith('lts/')) {
    const codename = value.slice(4)
    const target = readAlias(root, join('alias', 'lts', codename))
    if (target) return resolveAliasToVersion(root, target, installed, depth + 1)
  }

  return undefined
}

/** The bin dir for the node version the user has selected as their nvm default. */
function preferredNodeBin(base: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const root = nvmRoot(base, platform)

  // nvm-windows points NVM_SYMLINK at the active node dir (contains node.exe directly).
  if (platform === 'win32') {
    const symlink = base['NVM_SYMLINK']
    if (symlink) return symlink
  }

  // Unix nvm `current` symlink, when nvm has an active version.
  const current = join(root, 'current')
  if (existsSync(current)) return join(current, 'bin')

  const installed = installedVersionNames(root, platform)
  const defaultAlias = readAlias(root, join('alias', 'default'))
  const resolved =
    defaultAlias && installed.length > 0
      ? resolveAliasToVersion(root, defaultAlias, installed)
      : undefined
  const version = resolved ?? installed[0]
  return version ? versionBinDir(root, version, platform) : undefined
}

/** Marker env var set on every process spawned for a harness so a startup
 * reaper can identify app-owned processes without touching a user's own
 * external claude-code/opencode sessions. Inherited by agent-spawned children. */
export const OWNED_PROCESS_MARKER = 'CODEINOVEN_OWNED'

/**
 * Desktop apps do not inherit a login shell PATH. Keep the augmented harness
 * environment in one place so probing and process-backed drivers agree.
 *
 * The user's selected nvm version (default alias / current / newest installed)
 * is placed first so spawned harnesses and their `#!/usr/bin/env node`
 * children resolve the Node the user actually chose instead of an arbitrary
 * (often oldest) installed version.
 */
export function buildHarnessEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const sep = pathSeparator(platform)
  const home = base['HOME'] ?? (platform === 'win32' ? (base['USERPROFILE'] ?? '') : '')
  const root = nvmRoot(base, platform)
  const installed = installedVersionNames(root, platform)

  const preferred = preferredNodeBin(base, platform)

  const commonPaths =
    platform === 'win32'
      ? [join(base['APPDATA'] ?? homedir(), 'npm')]
      : [
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/bin',
          '/bin',
          `${home}/.local/bin`,
          `${home}/.bun/bin`,
          `${home}/.cargo/bin`,
          `${home}/.npm-global/bin`
        ]

  // All installed nvm bins, newest-first, excluding the already-preferred one.
  const versionBins = installed
    .map((version) => versionBinDir(root, version, platform))
    .filter((dir) => dir !== preferred)

  // The user's selected node version must come first so `#!/usr/bin/env node`
  // and PATH lookup resolve it even when the base PATH already carries an
  // older node (e.g. when the app is launched from a shell).
  const pathEntries = [
    ...(preferred ? [preferred] : []),
    base['PATH'] ?? '',
    ...commonPaths,
    ...versionBins
  ]

  return {
    ...base,
    PATH: pathEntries.filter(Boolean).join(sep),
    [OWNED_PROCESS_MARKER]: '1'
  }
}
