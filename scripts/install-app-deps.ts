/**
 * Rebuild Electron's native dependencies with a Visual Studio toolset this
 * machine can actually build with.
 *
 * node-gyp picks the newest Visual Studio it can find and derives the MSBuild
 * `PlatformToolset` from that installation's year: VS 2026 means v145, VS 2022
 * means v143. A machine can hold several installations where the newest one
 * does not carry the compiler for its own year (VS 2026 Build Tools with only
 * the v143 compiler, for example). node-gyp then still emits v145 and MSBuild
 * fails the `better-sqlite3` rebuild with MSB8020, "The build tools for v145
 * cannot be found", even though a complete v143 toolchain sits next to it.
 *
 * Before handing over to `electron-builder install-app-deps`, this script looks
 * for the newest installation whose installed compiler matches the toolset
 * node-gyp derives from that installation's year, and pins that year through
 * `npm_config_msvs_version`, the only channel node-gyp 12 still reads (its
 * `msvs-version` option ignores the `--msvs_version` flag that
 * `@electron/rebuild` forwards from `GYP_MSVS_VERSION`, which is why setting
 * that variable alone never changed the toolset). An explicit year always
 * wins, and when nothing matches the rebuild still runs with node-gyp's own
 * detection so the failure stays visible; the lines below name the toolset to
 * install.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Logger } from '../src/main/system/logger'

/** VS installation major version to the node-gyp year it maps to. */
const YEARS: Record<string, string> = { '18': '2026', '17': '2022', '16': '2019' }

/**
 * Compiler versions that satisfy each year's toolset: node-gyp asks for v145 on
 * 2026, v143 on 2022 (either 14.3x or 14.4x), and v142 on 2019.
 */
const COMPILERS: Record<string, string[]> = {
  '18': ['14.5'],
  '17': ['14.3', '14.4'],
  '16': ['14.2']
}

const TARGET_ARCHITECTURE: Record<string, string> = {
  arm64: 'arm64',
  x64: 'x64',
  ia32: 'x86'
}

interface VisualStudioInstallation {
  installationPath: string
  installationVersion: string
  /** vswhere reports package objects (`{ id, version, type }`) here. */
  packages?: unknown
}

interface ToolsetMatch {
  year: string
  toolset: string
  path: string
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function visualStudioInstaller(): string | null {
  const programFiles = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const vswhere = join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  return existsSync(vswhere) ? vswhere : null
}

function installedVisualStudios(vswhere: string): VisualStudioInstallation[] {
  const result = spawnSync(
    vswhere,
    ['-products', '*', '-prerelease', '-include', 'packages', '-format', 'json', '-utf8'],
    {
      encoding: 'utf8',
      windowsHide: true
    }
  )
  if (result.status !== 0 || !result.stdout.trim()) return []
  try {
    const parsed: unknown = JSON.parse(result.stdout)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is VisualStudioInstallation =>
        typeof entry === 'object' &&
        entry !== null &&
        'installationPath' in entry &&
        typeof entry.installationPath === 'string' &&
        'installationVersion' in entry &&
        typeof entry.installationVersion === 'string'
    )
  } catch {
    return []
  }
}

function packageIds(packages: unknown): string[] | null {
  if (!Array.isArray(packages)) return null
  const ids: string[] = []
  for (const entry of packages) {
    if (typeof entry === 'string') {
      ids.push(entry)
    } else if (typeof entry === 'object' && entry !== null && 'id' in entry) {
      const { id } = entry
      if (typeof id === 'string') ids.push(id)
    }
  }
  return ids
}

/**
 * node-gyp only accepts an installation that carries a Windows SDK, so the
 * pinned year has to clear the same bar.
 */
function hasWindowsSdk(packages: unknown): boolean {
  // Without the package list there is nothing to second-guess.
  const ids = packageIds(packages)
  if (!ids) return true
  return ids.some(
    (id) =>
      id.startsWith('Microsoft.VisualStudio.Component.Windows10SDK.') ||
      id.startsWith('Microsoft.VisualStudio.Component.Windows11SDK.') ||
      id === 'Microsoft.VisualStudio.Component.Windows81SDK'
  )
}

/**
 * Finds the compiler directory node-gyp's vcxproj expects for this install.
 * `VC/Tools/MSVC/<version>/bin/Host<host>/<target>/cl.exe` is exactly what
 * MSBuild resolves a `PlatformToolset` to, so its presence is the same test
 * that produced MSB8020.
 */
function findCompiler(installationPath: string, prefixes: string[]): string | null {
  const msvcRoot = join(installationPath, 'VC', 'Tools', 'MSVC')
  const target = TARGET_ARCHITECTURE[process.arch]
  if (!target || !existsSync(msvcRoot)) return null
  let toolsets: string[]
  try {
    toolsets = readdirSync(msvcRoot)
  } catch {
    return null
  }
  for (const toolset of toolsets.filter((entry) =>
    prefixes.some((prefix) => entry.startsWith(prefix))
  )) {
    const binRoot = join(msvcRoot, toolset, 'bin')
    if (!existsSync(binRoot)) continue
    for (const host of readdirSync(binRoot).filter((entry) => entry.startsWith('Host'))) {
      if (existsSync(join(binRoot, host, target, 'cl.exe'))) return toolset
    }
  }
  return null
}

function selectToolset(installations: VisualStudioInstallation[]): ToolsetMatch | null {
  const ranked = installations.slice().sort((left, right) =>
    right.installationVersion.localeCompare(left.installationVersion, undefined, {
      numeric: true
    })
  )
  for (const installation of ranked) {
    const major = installation.installationVersion.split('.')[0]
    const year = YEARS[major]
    const prefixes = COMPILERS[major]
    if (!year || !prefixes) continue
    if (!hasWindowsSdk(installation.packages)) continue
    const compiler = findCompiler(installation.installationPath, prefixes)
    if (!compiler) continue
    return { year, toolset: compiler, path: installation.installationPath }
  }
  return null
}

function describeInstallations(installations: VisualStudioInstallation[]): string {
  return installations
    .map((installation) => {
      const major = installation.installationVersion.split('.')[0]
      const compiler = COMPILERS[major]
        ? findCompiler(installation.installationPath, COMPILERS[major])
        : null
      const state = compiler ? `toolset ${compiler}` : 'no C++ toolset for its year'
      const sdk = hasWindowsSdk(installation.packages) ? '' : ', no Windows SDK'
      return `- ${installation.installationPath} (${installation.installationVersion}, ${state}${sdk})`
    })
    .join('\n')
}

const args = ['install-app-deps']
const environment: NodeJS.ProcessEnv = { ...process.env }

/** node-gyp reads the requested year from npm config, not from its own flag. */
function applyYear(year: string): void {
  environment.npm_config_msvs_version = year
  environment.GYP_MSVS_VERSION = year
}

const configuredYear = environment.npm_config_msvs_version ?? environment.GYP_MSVS_VERSION

if (process.platform === 'win32') {
  if (configuredYear) {
    applyYear(configuredYear)
  } else {
    try {
      const vswhere = visualStudioInstaller()
      const installations = vswhere ? installedVisualStudios(vswhere) : []
      const match = selectToolset(installations)
      if (match) {
        applyYear(match.year)
        Logger.info(
          `[install-app-deps] Building native modules with Visual Studio ${match.year} (toolset ${match.toolset}) at ${match.path}.`
        )
      } else {
        Logger.error(
          [
            '[install-app-deps] No Visual Studio C++ toolset matches the one node-gyp derives from its year.',
            installations.length > 0
              ? describeInstallations(installations)
              : '- no Visual Studio installation reported by vswhere',
            `Install "Desktop development with C++" including the ${TARGET_ARCHITECTURE[process.arch] ?? process.arch} build tools, or set GYP_MSVS_VERSION to a year whose toolset is installed.`
          ].join('\n')
        )
      }
    } catch (error) {
      // Inspecting Visual Studio must never decide whether the install succeeds;
      // node-gyp's own detection stays the fallback.
      Logger.error(
        '[install-app-deps] Could not inspect Visual Studio; using node-gyp detection:',
        error
      )
    }
  }
}

const cli = join(root, 'node_modules', 'electron-builder', 'cli.js')
const child = spawnSync(process.execPath, [cli, ...args], {
  cwd: root,
  env: environment,
  stdio: 'inherit'
})

if (child.error) {
  Logger.error('[install-app-deps] electron-builder could not start:', child.error.message)
  process.exit(1)
}
process.exit(child.status ?? 1)
