import { constants } from 'node:fs'
import { access, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  CuaBridgeStatus,
  CuaInstallation,
  CuaInstallationSource,
  CuaPermissionStatus,
  HarnessUtilityBinding,
  PermissionLevel,
  ResolvedUtility,
  UtilityDefinitionFor
} from '../lib/types'
import type { StorageEngine } from './storage-engine'

const execFileAsync = promisify(execFile)
const CONFIG_PATH = 'computer-use/cua-bridge.json'
const CUA_TARGET_VERSION = '0.17.0'
const CUA_SUPPORTED_VERSION_RANGE = '0.17.x'
const CUA_RELEASE_BASE_URL = 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.17.0'
const CUA_RELEASE_URL = 'https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.17.0'
const CUA_DOCUMENTATION_URL = 'https://cua.ai/docs/how-to-guides/driver/install'
const CUA_UPDATE_URL = 'https://cua.ai/docs/how-to-guides/driver/update'
const CUA_PERMISSIONS_URL = 'https://cua.ai/docs/reference/cua-driver/macos-permissions'
const CUA_REPOSITORY_URL = 'https://github.com/trycua/cua'
const CUA_UTILITY_ID = 'codeinoven:cua-driver'

interface CuaBridgeConfig {
  enabled: boolean
}

interface CuaCandidate {
  path: string
  source: CuaInstallationSource
}

/**
 * Discovers and configures the separately installed Cua Driver without copying
 * binaries or persistent harness configuration into a user's repository.
 */
export class CuaBridgeService {
  constructor(private readonly storage: StorageEngine) {}

  async getStatus(): Promise<CuaBridgeStatus> {
    const config = await this.loadConfig()
    const platform = platformName()
    const installations = await discoverCuaInstallations()
    const selected = installations.find((installation) => installation.selected)
    if (!selected) {
      return this.baseStatus(config.enabled, platform, {
        installed: false,
        compatible: false,
        ready: false,
        mcpAvailable: false,
        daemonRunning: false,
        installations,
        permissionStatus: platform === 'macos' ? 'unknown' : 'not_required',
        detail: 'Cua Driver was not found in a supported install location.'
      })
    }

    const binaryPath = selected.realPath
    try {
      const version = selected.version
      const compatible = selected.compatible
      const [mcpAvailable, permissionStatus, daemonRunning] = await Promise.all([
        this.hasMcpSurface(binaryPath),
        this.permissionStatus(binaryPath, platform),
        this.daemonRunning(binaryPath)
      ])
      const platformReady =
        platform === 'macos' ? selected.appBundle && permissionStatus === 'granted' : daemonRunning
      const ready = compatible && mcpAvailable && platformReady
      return this.baseStatus(config.enabled, platform, {
        installed: true,
        compatible,
        ready,
        mcpAvailable,
        daemonRunning,
        permissionStatus,
        binaryPath,
        installations,
        updateCommand: updateCommand(selected, platform),
        ...(version ? { version } : {}),
        ...(!version
          ? { detail: 'Cua Driver did not report a semantic version.' }
          : !compatible
            ? {
                detail: `CodeInOven is using ${selected.path} (${version}), which is outside the supported ${CUA_SUPPORTED_VERSION_RANGE} contract.`
              }
            : platform === 'macos' && !selected.appBundle
              ? {
                  detail:
                    'A standalone Cua binary is installed, but macOS computer use requires the signed CuaDriver.app in /Applications.'
                }
              : !mcpAvailable
                ? { detail: 'Cua Driver is installed, but its MCP tool surface is unavailable.' }
                : permissionStatus === 'missing'
                  ? { detail: 'Cua Driver still needs the required macOS permissions.' }
                  : platform === 'macos' && permissionStatus !== 'granted'
                    ? {
                        detail:
                          'Cua Driver permissions could not be verified. Run cua-driver permissions grant, then refresh.'
                      }
                    : platform !== 'macos' && !daemonRunning
                      ? {
                          detail:
                            'Start cua-driver serve in the interactive desktop session, then refresh.'
                        }
                      : {})
      })
    } catch (error) {
      return this.baseStatus(config.enabled, platform, {
        installed: true,
        compatible: false,
        ready: false,
        mcpAvailable: false,
        daemonRunning: false,
        installations,
        permissionStatus: platform === 'macos' ? 'unknown' : 'not_required',
        binaryPath,
        updateCommand: updateCommand(selected, platform),
        detail: error instanceof Error ? error.message : 'Cua Driver could not be inspected.'
      })
    }
  }

  async setEnabled(enabled: boolean): Promise<CuaBridgeStatus> {
    if (typeof enabled !== 'boolean') throw new TypeError('Cua bridge enabled state is invalid')
    if (enabled) {
      const status = await this.getStatus()
      if (!status.installed) throw new Error('Install Cua Driver before enabling the bridge')
      if (!status.compatible) {
        throw new Error(`Cua Driver ${CUA_SUPPORTED_VERSION_RANGE} is required`)
      }
      if (!status.mcpAvailable) throw new Error('Cua Driver MCP is unavailable')
      if (!status.ready) throw new Error(status.detail ?? 'Cua Driver is not ready')
    }
    await this.storage.write(CONFIG_PATH, { enabled } satisfies CuaBridgeConfig)
    return this.getStatus()
  }

  async resolveUtility(
    harnessId: string,
    permissionLevel: PermissionLevel
  ): Promise<ResolvedUtility | null> {
    const status = await this.getStatus()
    if (!status.enabled || !status.ready || !status.binaryPath) return null
    const fullAccess = permissionLevel === 'full_access'
    const now = Date.now()
    const binding: HarnessUtilityBinding = {
      harnessId,
      strategy: 'mcp',
      nativeCapability: 'computer_use',
      transportName: 'cua-driver'
    }
    const utility: UtilityDefinitionFor<'mcp'> = {
      id: CUA_UTILITY_ID,
      kind: 'mcp',
      name: 'Cua Computer Use',
      description:
        'Operate desktop applications through the externally installed Cua Driver MCP server.',
      enabled: true,
      activation: 'on_demand',
      scope: { level: 'global' },
      config: {
        transport: 'stdio',
        command: status.binaryPath,
        args: ['mcp'],
        environment: {
          CUA_DRIVER_PERMISSION_MODE: fullAccess ? 'unrestricted' : 'standard',
          CUA_DRIVER_RS_UPDATE_CHECK: 'false',
          CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
          ...(fullAccess
            ? { CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS: 'true' }
            : { CUA_DRIVER_DISABLE_UNRESTRICTED: 'true' })
        }
      },
      credentials: [],
      harnessBindings: [binding],
      createdAt: now,
      updatedAt: now
    }
    return { utility, binding }
  }

  private async loadConfig(): Promise<CuaBridgeConfig> {
    const value = await this.storage.read<unknown>(CONFIG_PATH)
    if (!isRecord(value) || typeof value['enabled'] !== 'boolean') return { enabled: false }
    return { enabled: value['enabled'] }
  }

  private async hasMcpSurface(binaryPath: string): Promise<boolean> {
    try {
      await execFileAsync(binaryPath, ['list-tools'], { timeout: 8_000, maxBuffer: 1_000_000 })
      return true
    } catch {
      return false
    }
  }

  private async permissionStatus(
    binaryPath: string,
    platform: CuaBridgeStatus['platform']
  ): Promise<CuaPermissionStatus> {
    if (platform !== 'macos') return 'not_required'
    try {
      const { stdout, stderr } = await execFileAsync(binaryPath, ['permissions', 'status'], {
        timeout: 8_000,
        maxBuffer: 256_000
      })
      const output = `${stdout}\n${stderr}`.toLocaleLowerCase()
      const accessibilityGranted = /accessibility[^\n]*(granted|✅)/u.test(output)
      const screenRecordingGranted = /screen recording[^\n]*(granted|✅)/u.test(output)
      if (accessibilityGranted && screenRecordingGranted) return 'granted'
      if (/(denied|not granted|missing|❌)/u.test(output)) return 'missing'
      return 'unknown'
    } catch {
      return 'unknown'
    }
  }

  private async daemonRunning(binaryPath: string): Promise<boolean> {
    try {
      await execFileAsync(binaryPath, ['status'], { timeout: 8_000, maxBuffer: 256_000 })
      return true
    } catch {
      return false
    }
  }

  private baseStatus(
    enabled: boolean,
    platform: CuaBridgeStatus['platform'],
    status: Omit<
      CuaBridgeStatus,
      | 'enabled'
      | 'targetVersion'
      | 'supportedVersionRange'
      | 'platform'
      | 'architecture'
      | 'downloadLabel'
      | 'downloadName'
      | 'installUrl'
      | 'documentationUrl'
      | 'updateUrl'
      | 'permissionsUrl'
      | 'repositoryUrl'
    >
  ): CuaBridgeStatus {
    const architecture = architectureName()
    const download = downloadFor(platform, architecture)
    return {
      enabled,
      targetVersion: CUA_TARGET_VERSION,
      supportedVersionRange: CUA_SUPPORTED_VERSION_RANGE,
      platform,
      architecture,
      downloadLabel: download.label,
      ...(download.name ? { downloadName: download.name } : {}),
      installUrl: download.url,
      documentationUrl: CUA_DOCUMENTATION_URL,
      updateUrl: CUA_UPDATE_URL,
      permissionsUrl: CUA_PERMISSIONS_URL,
      repositoryUrl: CUA_REPOSITORY_URL,
      ...status
    }
  }
}

async function discoverCuaInstallations(): Promise<CuaInstallation[]> {
  const executable = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
  const pathCandidates = (process.env['PATH'] ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((directory): CuaCandidate => ({
      path: join(directory, executable),
      source: installationSource(join(directory, executable))
    }))
  const candidates: CuaCandidate[] = [
    ...(process.env['CUA_DRIVER_PATH']
      ? [{ path: process.env['CUA_DRIVER_PATH'], source: 'environment' as const }]
      : []),
    { path: join(homedir(), '.local', 'bin', executable), source: 'canonical' },
    ...(process.platform === 'darwin'
      ? [
          {
            path: '/Applications/CuaDriver.app/Contents/MacOS/cua-driver',
            source: 'application' as const
          },
          { path: '/opt/homebrew/bin/cua-driver', source: 'homebrew' as const },
          { path: '/usr/local/bin/cua-driver', source: 'path' as const }
        ]
      : []),
    ...pathCandidates
  ]
  const accessible: Array<CuaCandidate & { realPath: string }> = []
  const seenPaths = new Set<string>()
  for (const candidate of candidates) {
    if (seenPaths.has(candidate.path)) continue
    seenPaths.add(candidate.path)
    try {
      await access(candidate.path, constants.X_OK)
      accessible.push({ ...candidate, realPath: await realpath(candidate.path) })
    } catch {
      // Try the next documented or PATH-derived location.
    }
  }

  const groups = new Map<string, Array<CuaCandidate & { realPath: string }>>()
  for (const candidate of accessible) {
    const group = groups.get(candidate.realPath) ?? []
    group.push(candidate)
    groups.set(candidate.realPath, group)
  }
  const installations = await Promise.all(
    [...groups.entries()].map(async ([resolvedPath, group]): Promise<CuaInstallation> => {
      const aliases = [...new Set(group.map(({ path }) => path))]
      const source = groupSource(group, resolvedPath)
      const preferredPath =
        group.find((candidate) => candidate.source === source)?.path ?? aliases[0] ?? resolvedPath
      const version = await binaryVersion(resolvedPath)
      return {
        path: preferredPath,
        realPath: resolvedPath,
        aliases,
        source,
        ...(version ? { version } : {}),
        compatible: version !== undefined && isCompatibleVersion(version),
        appBundle: isAppBundlePath(resolvedPath),
        selected: false
      }
    })
  )
  const explicit = installations.find((installation) =>
    installation.aliases.includes(process.env['CUA_DRIVER_PATH'] ?? '')
  )
  const selected = explicit ?? [...installations].sort(compareInstallations)[0]
  return installations
    .map((installation) => ({
      ...installation,
      selected: installation.realPath === selected?.realPath
    }))
    .sort((left, right) => Number(right.selected) - Number(left.selected))
}

async function binaryVersion(binaryPath: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, ['--version'], {
      timeout: 8_000,
      maxBuffer: 128_000
    })
    return parseVersion(`${stdout}\n${stderr}`)
  } catch {
    return undefined
  }
}

function groupSource(
  candidates: Array<CuaCandidate & { realPath: string }>,
  resolvedPath: string
): CuaInstallationSource {
  if (candidates.some(({ source }) => source === 'environment')) return 'environment'
  if (isAppBundlePath(resolvedPath)) return 'application'
  if (installationSource(resolvedPath) === 'homebrew') return 'homebrew'
  if (candidates.some(({ source }) => source === 'canonical')) return 'canonical'
  return 'path'
}

function installationSource(value: string): CuaInstallationSource {
  if (
    value.startsWith('/opt/homebrew/') ||
    value.includes('/Homebrew/') ||
    value.includes('/Cellar/')
  ) {
    return 'homebrew'
  }
  return 'path'
}

function isAppBundlePath(value: string): boolean {
  return value.includes('/CuaDriver.app/Contents/MacOS/')
}

function compareInstallations(left: CuaInstallation, right: CuaInstallation): number {
  const leftScore = installationScore(left)
  const rightScore = installationScore(right)
  if (leftScore !== rightScore) return rightScore - leftScore
  return compareVersions(right.version, left.version)
}

function installationScore(installation: CuaInstallation): number {
  if (process.platform === 'darwin' && installation.compatible && installation.appBundle) return 4
  if (installation.compatible) return 3
  if (process.platform === 'darwin' && installation.appBundle) return 2
  return 1
}

function compareVersions(left?: string, right?: string): number {
  const leftParts = semanticVersionParts(left)
  const rightParts = semanticVersionParts(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index]
    if (difference !== 0) return difference
  }
  return 0
}

function semanticVersionParts(value?: string): [number, number, number] {
  const match = value?.match(/^(\d+)\.(\d+)\.(\d+)/u)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0]
}

function parseVersion(value: string): string | undefined {
  return value.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/u)?.[1]
}

function isCompatibleVersion(value: string): boolean {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)/u)
  return match?.[1] === '0' && match[2] === '17'
}

function platformName(): CuaBridgeStatus['platform'] {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'linux') return 'linux'
  return 'unsupported'
}

function architectureName(): CuaBridgeStatus['architecture'] {
  if (process.arch === 'arm64') return 'arm64'
  if (process.arch === 'x64') return 'x64'
  return 'unsupported'
}

function downloadFor(
  platform: CuaBridgeStatus['platform'],
  architecture: CuaBridgeStatus['architecture']
): { url: string; label: string; name?: string } {
  const architectureLabel = architecture === 'arm64' ? 'ARM64' : 'x64'
  const assetArchitecture = architecture === 'arm64' ? 'arm64' : 'x86_64'
  if (architecture === 'unsupported' || platform === 'unsupported') {
    return { url: CUA_RELEASE_URL, label: 'View supported downloads' }
  }
  if (platform === 'macos') {
    const name = `cua-driver-rs-${CUA_TARGET_VERSION}-darwin-${assetArchitecture}.tar.gz`
    return {
      url: `${CUA_RELEASE_BASE_URL}/${name}`,
      label: `Download Cua ${CUA_TARGET_VERSION} for macOS (${architectureLabel})`,
      name
    }
  }
  if (platform === 'windows') {
    const name = `cua-driver-rs-${CUA_TARGET_VERSION}-windows-${assetArchitecture}.zip`
    return {
      url: `${CUA_RELEASE_BASE_URL}/${name}`,
      label: `Download Cua ${CUA_TARGET_VERSION} for Windows (${architectureLabel})`,
      name
    }
  }
  const name = `cua-driver-rs-${CUA_TARGET_VERSION}-linux-${assetArchitecture}.tar.gz`
  return {
    url: `${CUA_RELEASE_BASE_URL}/${name}`,
    label: `Download Cua ${CUA_TARGET_VERSION} for Linux (${architectureLabel})`,
    name
  }
}

function updateCommand(
  installation: CuaInstallation,
  platform: CuaBridgeStatus['platform']
): string {
  if (platform === 'windows') {
    return `& "${installation.realPath.replaceAll('"', '`"')}" update --apply`
  }
  return `'${installation.realPath.replaceAll("'", "'\\''")}' update --apply`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
