import { constants } from 'node:fs'
import { access, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  CuaBridgeStatus,
  CuaInstallation,
  CuaInstallationSource,
  CuaPermissionStatus,
  CuaUpdateCheck,
  CuaUpdateProgress,
  HarnessUtilityBinding,
  PermissionLevel,
  ResolvedUtility,
  UtilityDefinitionFor
} from '../../lib/types'
import type { StorageEngine } from '../storage/storage-engine'
import { Logger } from '../system/logger'

const execFileAsync = promisify(execFile)
const CONFIG_PATH = 'computer-use/cua-bridge.json'
/** Release the manual download fallback points at, and the newest stable release we know. */
const CUA_TARGET_VERSION = '0.28.2'
/**
 * How compatibility is decided.
 *
 * A minimum, not a pinned minor: every verb and MCP tool CodeInOven drives
 * (`--version`, `list-tools`, `mcp`, `status`, `stop`, `permissions status
 * --json`, plus the tool names the PiP and the orchestration service call) has
 * been present and unchanged from 0.17.0 through 0.28.2, and the MCP surface is
 * probed at runtime anyway, so pinning one minor only had the effect of locking a
 * user out of their own driver the moment it updated.
 */
const CUA_MINIMUM_VERSION = '0.17.0'
const CUA_SUPPORTED_VERSION_RANGE = `${CUA_MINIMUM_VERSION} or newer`
const CUA_RELEASE_BASE_URL = 'https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.28.2'
const CUA_RELEASE_URL = 'https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.28.2'
const CUA_DOCUMENTATION_URL = 'https://cua.ai/docs/how-to-guides/driver/install'
const CUA_UPDATE_URL = 'https://cua.ai/docs/how-to-guides/driver/update'
const CUA_PERMISSIONS_URL = 'https://cua.ai/docs/reference/cua-driver/macos-permissions'
const CUA_REPOSITORY_URL = 'https://github.com/trycua/cua'
const CUA_UTILITY_ID = 'cio:cua-driver'
const PERMISSION_CACHE_TTL_MS = 20_000
const DAEMON_START_TIMEOUT_MS = 8_000
const DAEMON_WAIT_STEP_MS = 300
const UPDATE_CHECK_TIMEOUT_MS = 30_000
/** The updater downloads roughly 70 MB and then swaps a signed app bundle in. */
const UPDATE_APPLY_TIMEOUT_MS = 20 * 60_000
/**
 * How long to keep watching the installed copy after the updater settles.
 *
 * Cua's installer runs `pkill -x cua-driver` while it swaps the binary, which
 * also matches the `update --apply` process we are waiting on, so the update can
 * outlive its own parent. Version readback, not the exit code, decides success.
 */
const UPDATE_VERIFY_TIMEOUT_MS = 120_000
/**
 * A clean exit means the installer finished on its own, so the new binary is
 * already on disk and only a filesystem-level readback delay is worth waiting for.
 */
const UPDATE_VERIFY_QUICK_MS = 15_000
const UPDATE_VERIFY_STEP_MS = 1_500
/** Installer milestones are chatty; the renderer only needs the latest one. */
const UPDATE_PROGRESS_INTERVAL_MS = 250
const UPDATE_OUTPUT_TAIL_LINES = 12
/**
 * A killed updater is the normal end of a successful swap, so an update may not
 * report a non-zero exit and still have installed. Anything else is a failure.
 */
const UPDATER_TERMINATION_SIGNAL_HINT =
  "Cua's installer stopped the driver while it swapped the binary. Check the installed version and try again if it did not change."

let permissionCache: { status: CuaPermissionStatus; at: number } | null = null

interface CuaBridgeConfig {
  enabled: boolean
}

interface CuaCandidate {
  path: string
  source: CuaInstallationSource
}

/** The subset of `cua-driver check-update --json` that the settings surface uses. */
interface CuaUpdateCheckPayload {
  current_version?: string
  latest_version?: string
  update_available?: boolean
  cache_hit?: boolean
  checked_at?: string
  release_notes_url?: string | null
  install_command?: string | null
  current_channel?: string
  selected_channel?: string
  error?: string | null
}

interface UpdaterOutcome {
  /** False when the process never started, so no installer is running. */
  started: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  /** Bounded tail of the installer's own output, for a failure explanation. */
  tail: string[]
}

/**
 * Discovers and configures the separately installed Cua Driver without copying
 * binaries or persistent harness configuration into a user's repository.
 */
export class CuaBridgeService {
  constructor(private readonly storage: StorageEngine) {}

  /** A second click must join the running update, not start a second installer. */
  private updateInFlight: Promise<CuaBridgeStatus> | null = null

  async getStatus(): Promise<CuaBridgeStatus> {
    const config = await this.loadConfig()
    const platform = platformName()
    const { installations, selected } = await this.selectedInstallation()
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
      const permissionStatus = await this.permissionStatus(binaryPath, platform)
      const [mcpAvailable, daemonRunning] = await Promise.all([
        this.hasMcpSurface(binaryPath),
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
                detail: `CodeInOven is using ${selected.path} (${version}), which is older than the supported ${CUA_MINIMUM_VERSION} contract.`
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
                          'Cua Driver permissions could not be verified. Start the Cua Driver daemon (cua-driver serve), then refresh.'
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

  /**
   * Ask the installed driver whether Cua published a newer release.
   *
   * Deliberately outside `getStatus()`: every turn resolves this bridge through
   * `resolveUtility()`, so the status read has to stay local and fast. The driver
   * owns the GitHub round trip and caches it for 20 hours, so this runs only when
   * a user opens the Computer use settings.
   *
   * Returns null when no driver is installed: there is nothing to update yet.
   */
  async checkForUpdate(options: { skipCache?: boolean } = {}): Promise<CuaUpdateCheck | null> {
    const { selected } = await this.selectedInstallation()
    if (!selected) return null
    return this.readUpdateCheck(selected.realPath, options.skipCache === true)
  }

  /**
   * Update the installed driver in place, then report the refreshed bridge state.
   *
   * Cua's own updater does the work: it runs the canonical installer, which
   * verifies the release bundle's signature, replaces
   * `/Applications/CuaDriver.app` and the CLI together, and rolls the previous
   * copy back when that verification fails. Milestones stream to `onProgress`
   * because the download is large enough that silence would read as a hang.
   *
   * Success is decided by re-reading the installed version, never by the
   * updater's exit code: the installer stops the driver mid-swap, which also
   * ends the `update --apply` process that is being waited on.
   */
  async applyUpdate(onProgress?: (progress: CuaUpdateProgress) => void): Promise<CuaBridgeStatus> {
    if (this.updateInFlight) return this.updateInFlight
    const run = this.runUpdate(onProgress)
    this.updateInFlight = run
    try {
      return await run
    } finally {
      this.updateInFlight = null
    }
  }

  /**
   * Resolve the installations this machine has, and the one CodeInOven drives.
   *
   * Shared by the status read and the update path so both always agree on which
   * copy an action would touch.
   */
  private async selectedInstallation(): Promise<{
    installations: CuaInstallation[]
    selected?: CuaInstallation
  }> {
    const installations = await discoverCuaInstallations()
    const selected = installations.find((installation) => installation.selected)
    return selected ? { installations, selected } : { installations }
  }

  private async runUpdate(
    onProgress?: (progress: CuaUpdateProgress) => void
  ): Promise<CuaBridgeStatus> {
    const { selected } = await this.selectedInstallation()
    if (!selected) throw new Error('Install Cua Driver before updating it')
    const previousVersion = selected.version
    onProgress?.({ state: 'updating', detail: "Starting Cua's installer" })
    const outcome = await runCuaUpdater(selected.realPath, onProgress)
    if (!outcome.started) {
      const reason = outcome.tail.join(' ').trim() || 'Cua Driver could not start its own updater.'
      onProgress?.({ state: 'failed', error: reason })
      throw new Error(reason)
    }
    // A signal death or a timeout is the swap's own side effect, and the installer
    // may still be finishing: watch for the new version for longer there.
    const mayOutliveUpdater = outcome.timedOut || outcome.signal !== null
    const installed = await this.waitForVersionChange(
      previousVersion,
      mayOutliveUpdater ? UPDATE_VERIFY_TIMEOUT_MS : UPDATE_VERIFY_QUICK_MS
    )
    if (!installed && outcome.exitCode !== 0) {
      const reason = outcome.timedOut
        ? "Cua's installer did not finish in time and the installed version did not change."
        : outcome.signal
          ? UPDATER_TERMINATION_SIGNAL_HINT
          : "Cua's installer failed and the installed version did not change."
      const detail = outcome.tail.join('\n')
      Logger.dev('Cua update failed:', outcome.exitCode, outcome.signal, detail)
      onProgress?.({ state: 'failed', error: detail ? `${reason}\n${detail}` : reason })
      throw new Error(detail ? `${reason} ${detail}` : reason)
    }
    // The bundle was replaced, so a cached permission verdict describes an app
    // that no longer exists on disk.
    permissionCache = null
    const status = await this.getStatus()
    onProgress?.({ state: 'installed', version: status.version ?? installed?.version })
    return status
  }

  private async readUpdateCheck(binaryPath: string, skipCache: boolean): Promise<CuaUpdateCheck> {
    const args = ['check-update', '--json', ...(skipCache ? ['--no-cache'] : [])]
    let output: string
    try {
      const { stdout, stderr } = await execFileAsync(binaryPath, args, {
        timeout: UPDATE_CHECK_TIMEOUT_MS,
        maxBuffer: 256_000
      })
      output = `${stdout}\n${stderr}`
    } catch (error) {
      output = childOutput(error)
      if (!output.trim()) {
        throw new Error(
          error instanceof Error && error.message
            ? `Cua Driver could not check for updates: ${error.message}`
            : 'Cua Driver could not check for updates.',
          { cause: error }
        )
      }
    }
    const payload = parseJsonObject(output) as CuaUpdateCheckPayload | null
    if (!payload) {
      throw new Error('Cua Driver did not return a readable release check.')
    }
    if (typeof payload.error === 'string' && payload.error.trim()) {
      throw new Error(`Cua Driver could not check for updates: ${payload.error.trim()}`)
    }
    const currentVersion = stringValue(payload.current_version)
    const latestVersion = stringValue(payload.latest_version)
    if (!currentVersion || !latestVersion) {
      throw new Error('Cua Driver did not report the released versions it compared.')
    }
    const channel = stringValue(payload.selected_channel) ?? stringValue(payload.current_channel)
    const checkedAt = stringValue(payload.checked_at)
    const releaseNotesUrl = stringValue(payload.release_notes_url)
    const installCommand = stringValue(payload.install_command)
    return {
      currentVersion,
      latestVersion,
      // A driver that predates the check has no opinion; the version pair is the
      // contract, and `update_available` only confirms what we can see anyway.
      updateAvailable: payload.update_available === true || currentVersion !== latestVersion,
      cached: payload.cache_hit === true,
      ...(channel ? { channel } : {}),
      ...(checkedAt ? { checkedAt } : {}),
      ...(releaseNotesUrl ? { releaseNotesUrl } : {}),
      ...(installCommand ? { installCommand } : {})
    }
  }

  /**
   * Wait until some discovered installation reports a different version, or give
   * up. Polling rather than reading once, because the swap can outlive the
   * updater process this app is waiting on.
   */
  private async waitForVersionChange(
    previousVersion: string | undefined,
    budgetMs: number
  ): Promise<CuaInstallation | undefined> {
    const deadline = Date.now() + budgetMs
    for (;;) {
      const { selected } = await this.selectedInstallation()
      if (selected && selected.version !== previousVersion) return selected
      if (Date.now() >= deadline) return undefined
      await sleep(UPDATE_VERIFY_STEP_MS)
    }
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
      appOwned: false,
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
    const running = await this.daemonRunning(binaryPath)
    if (running) return this.readPermissionStatus(binaryPath)
    const cached = permissionCache
    if (cached && Date.now() - cached.at < PERMISSION_CACHE_TTL_MS) return cached.status
    const started = await this.startDaemonTransiently(binaryPath)
    if (!started) return 'unknown'
    try {
      const status = await this.readPermissionStatus(binaryPath)
      permissionCache = { status, at: Date.now() }
      return status
    } finally {
      await this.stopDaemon(binaryPath)
    }
  }

  private async readPermissionStatus(binaryPath: string): Promise<CuaPermissionStatus> {
    try {
      const { stdout, stderr } = await execFileAsync(
        binaryPath,
        ['permissions', 'status', '--json'],
        {
          timeout: 8_000,
          maxBuffer: 256_000
        }
      )
      const payload = parsePermissionJson(`${stdout}\n${stderr}`)
      if (payload !== null) {
        if (payload.daemon_running === false) return 'unknown'
        if (payload.accessibility !== undefined && payload.screen_recording !== undefined) {
          return payload.accessibility && payload.screen_recording ? 'granted' : 'missing'
        }
      }
      return parseTextPermissionStatus(`${stdout}\n${stderr}`)
    } catch {
      return 'unknown'
    }
  }

  private async startDaemonTransiently(binaryPath: string): Promise<boolean> {
    const appRoot = appBundleRoot(binaryPath)
    const args = appRoot
      ? ['-n', '-g', appRoot, '--args', 'serve']
      : ['-n', '-g', '-a', 'CuaDriver', '--args', 'serve']
    try {
      await execFileAsync('open', args, { timeout: 8_000, maxBuffer: 128_000 })
    } catch {
      return false
    }
    const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await this.daemonRunning(binaryPath)) return true
      await sleep(DAEMON_WAIT_STEP_MS)
    }
    return false
  }

  private async stopDaemon(binaryPath: string): Promise<void> {
    try {
      await execFileAsync(binaryPath, ['stop'], { timeout: 8_000, maxBuffer: 128_000 })
    } catch {
      // The transient daemon may already be gone.
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

/**
 * Whether this driver release is one CodeInOven can drive.
 *
 * A floor rather than a pinned minor: the verbs and MCP tools this app depends
 * on have been stable across every release since 0.17.0, and the MCP surface is
 * probed at runtime, so refusing a newer driver only stranded the user on the
 * version they already had.
 */
function isCompatibleVersion(value: string): boolean {
  return compareVersions(value, CUA_MINIMUM_VERSION) >= 0
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

/** A non-empty trimmed string, or undefined for anything else the CLI may emit. */
function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

/**
 * The JSON object a driver subcommand printed, ignoring any prose around it.
 *
 * Cua's CLI writes human hints to the same streams as the payload, so the
 * prefix before the first brace is never part of the answer.
 */
function parseJsonObject(output: string): Record<string, unknown> | null {
  const start = output.indexOf('{')
  if (start < 0) return null
  try {
    const value = JSON.parse(output.slice(start)) as unknown
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

/** Whatever a failed `execFile` managed to capture before it rejected. */
function childOutput(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  const record = error as { stdout?: unknown; stderr?: unknown }
  const stdout = typeof record.stdout === 'string' ? record.stdout : ''
  const stderr = typeof record.stderr === 'string' ? record.stderr : ''
  return `${stdout}\n${stderr}`
}

/**
 * Run Cua's updater and stream its milestone lines.
 *
 * `spawn` rather than `execFile` because the install takes minutes and the user
 * needs to see it moving. Only the latest milestone is forwarded, at a bounded
 * rate, and only the tail is retained for a failure explanation.
 */
function runCuaUpdater(
  binaryPath: string,
  onProgress?: (progress: CuaUpdateProgress) => void
): Promise<UpdaterOutcome> {
  return new Promise((resolve) => {
    const child = spawn(binaryPath, ['update', '--apply'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const tail: string[] = []
    const partials = new Map<string, string>()
    let started = false
    let lastEmittedAt = 0
    let lastEmitted = ''
    let timedOut = false

    const record = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      // Lines arrive split across chunks, so each stream keeps its remainder
      // instead of turning one milestone into two halves.
      const lines = `${partials.get(stream) ?? ''}${chunk.toString()}`.split('\n')
      partials.set(stream, lines.pop() ?? '')
      for (const line of lines) {
        const detail = installerMilestone(line)
        if (!detail) continue
        if (tail.at(-1) !== detail) {
          tail.push(detail)
          if (tail.length > UPDATE_OUTPUT_TAIL_LINES) tail.shift()
        }
        const now = Date.now()
        if (now - lastEmittedAt < UPDATE_PROGRESS_INTERVAL_MS || detail === lastEmitted) continue
        lastEmittedAt = now
        lastEmitted = detail
        onProgress?.({ state: 'updating', detail })
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => record('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => record('stderr', chunk))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
    }, UPDATE_APPLY_TIMEOUT_MS)
    timer.unref()

    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({
        started: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        tail: [error.message]
      })
    })
    child.once('spawn', () => {
      started = true
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ started, exitCode: code, signal, timedOut, tail })
    })
  })
}

/**
 * One displayable installer milestone, or undefined for noise.
 *
 * Cua's installer prefixes its own steps with `==>`, so those lines are the
 * milestones a user can follow. Anything that is only punctuation is dropped.
 */
function installerMilestone(line: string): string | undefined {
  const trimmed = line.trim()
  const milestone = trimmed.startsWith('==>') ? trimmed.slice(3).trim() : trimmed
  if (!milestone || /^[\s.:#=*_-]+$/u.test(milestone)) return undefined
  return milestone.length > 240 ? `${milestone.slice(0, 237)}...` : milestone
}

interface PermissionStatusJson {
  daemon_running?: boolean
  accessibility?: boolean
  screen_recording?: boolean
}

function parsePermissionJson(output: string): PermissionStatusJson | null {
  const value = parseJsonObject(output)
  if (!value) return null
  const payload: PermissionStatusJson = {}
  if (typeof value['daemon_running'] === 'boolean') {
    payload.daemon_running = value['daemon_running']
  }
  if (typeof value['accessibility'] === 'boolean') {
    payload.accessibility = value['accessibility']
  }
  if (typeof value['screen_recording'] === 'boolean') {
    payload.screen_recording = value['screen_recording']
  }
  return payload
}

function parseTextPermissionStatus(output: string): CuaPermissionStatus {
  const lower = output.toLocaleLowerCase()
  const accessibilityGranted = /accessibility[^\n]*(granted|✅)/u.test(lower)
  const screenRecordingGranted = /screen recording[^\n]*(granted|✅)/u.test(lower)
  if (accessibilityGranted && screenRecordingGranted) return 'granted'
  if (/(denied|not granted|missing|❌)/u.test(lower)) return 'missing'
  return 'unknown'
}

function appBundleRoot(binaryPath: string): string | null {
  const marker = '/Contents/MacOS/'
  const index = binaryPath.indexOf(marker)
  return index < 0 ? null : binaryPath.slice(0, index)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
