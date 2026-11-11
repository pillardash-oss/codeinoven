import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { app } from 'electron'
import { isAbsolute, relative } from 'node:path'
import type {
  HarnessUpdateHandoff,
  HarnessUpdateStatus,
  ProviderConnectionInfo
} from '../../lib/types'
import { findHarness, listHarnesses } from './harness-registry'
import {
  currentAcpAgents,
  ensureAcpAgentsLoaded,
  findAcpAgent,
  isAcpAgentId
} from '../drivers/acp/acp-agents-store'
import { acpCommandName, acpUpdateCommandFor } from '../drivers/acp/acp-update-recipes'
import { resolvedOpenCodeCommand } from './opencode-installation'
import { homebrewPackageFor, homebrewUpgradeArgs, homebrewVersions } from './harness-homebrew'
import { parseMajorVersion, compareVersions } from '../../lib/version-compare'
import type { ProviderConnectionService } from '../providers/provider-connection'
import { Logger } from '../system/logger'
import {
  prepareHarnessTerminalHandoff,
  prepareWslTerminalHandoff
} from '../drivers/harness-runtime'

/** Network timeout for a registry/release lookup   a slow network must never hang the UI. */
const FETCH_TIMEOUT_MS = 10_000
/** Reopening the Harnesses page should not repeat the same registry traffic. */
const UPDATE_CACHE_TTL_MS = 5 * 60_000
/** Leave room for Electron's main loop between registry requests. */
const UPDATE_YIELD_MS = 50

/** Npm registry and GitHub release endpoints, matching the harness's install channel. */
interface NpmSource {
  kind: 'npm'
  package: string
}
interface GitHubSource {
  kind: 'github'
  repo: string
}
/**
 * A vendor installer script that embeds the release it installs.
 *
 * Some agents publish no registry and no release feed: their installer is
 * regenerated per release and names the build in its download URL, so the
 * script itself is the published version. Cursor Agent ships this way.
 */
interface InstallerSource {
  kind: 'installer'
  url: string
}
type UpdateSource = NpmSource | GitHubSource | InstallerSource

/**
 * Where the latest published version of each harness lives. Sources were
 * verified against the harnesses' real install channels:
 *  - npm-distributed CLIs query the registry `latest` tag.
 *  - Antigravity ships a standalone binary; its releases are published on GitHub.
 *    Its own background auto-updater is held by CodeInOven so updates stay under
 *    the Harnesses page (see drivers/antigravity/antigravity-self-update.ts), so
 *    this release feed is the truth about how far behind an install is.
 */
const UPDATE_SOURCES: Record<string, UpdateSource> = {
  // OpenCode V2 is the current release and installs under the same `opencode`
  // command, so the latest published version lives on the V2 npm package.
  opencode: { kind: 'npm', package: '@opencode/cli' },
  codex: { kind: 'npm', package: '@openai/codex' },
  'claude-code': { kind: 'npm', package: '@anthropic-ai/claude-code' },
  cline: { kind: 'npm', package: 'cline' },
  pi: { kind: 'npm', package: '@earendil-works/pi-coding-agent' },
  antigravity: { kind: 'github', repo: 'google-antigravity/antigravity-cli' }
}

/**
 * The harness's own self-update command, run by the user inside the embedded
 * terminal   CodeInOven never mutates a harness install on its own.
 */
/**
 * Where the latest published version of a well-known ACP agent lives.
 *
 * An ACP agent is the user's own binary, so the app has no manifest to read a
 * version from: the `<agent> --version` that ProviderConnectionService probes and
 * the vendor's published feed are the only authorities. An agent this table does
 * not recognize simply has no feed to compare against, so its Update action runs
 * the updater the user configured without a badge.
 */
const ACP_UPDATE_SOURCES: Record<string, UpdateSource> = {
  cline: { kind: 'npm', package: 'cline' },
  // cursor-agent publishes no registry entry; the vendor's installer names the
  // build it downloads, so its URL is the only published-version source. Without
  // this entry the app could never show that an install was months behind.
  'cursor-agent': { kind: 'installer', url: 'https://cursor.com/install' }
}

/** Split an agent's update command line into the argv the terminal runs. */
export function splitAcpUpdateCommand(line: string): { command: string; args: string[] } {
  const parts = line.trim().split(/\s+/u).filter(Boolean)
  const [command = '', ...args] = parts
  return { command, args }
}

const UPDATE_ARGS: Record<string, string[]> = {
  opencode: ['upgrade'],
  codex: ['update'],
  'claude-code': ['update'],
  cline: ['update'],
  pi: ['update'],
  antigravity: ['update'],
  muse: ['update']
}

/**
 * The command that moves an OpenCode install to the current release.
 *
 * V1 and V2 share the `opencode` command but are separate version lines; the
 * vendor's own V2 installer replaces a package-managed V1 binary, so a V1
 * install updates through that installer rather than `opencode upgrade` (which
 * would only advance it within the V1 line). A V2 install self-updates.
 */
function openCodeUpdateHandoff(
  provider: ProviderConnectionInfo | undefined
): { command: string; args: string[] } | null {
  const major = provider?.version ? parseMajorVersion(provider.version) : Number.NaN
  if (Number.isFinite(major) && major >= 2) return null
  if (process.platform === 'win32') {
    return { command: 'npm', args: ['install', '-g', '@opencode/cli'] }
  }
  return { command: 'sh', args: ['-lc', 'curl -fsSL https://opencode.ai/v2/install | bash'] }
}

const VERSION_PATTERN = /\b(v?\d+\.\d+\.\d+)/u
/** The release a vendor installer downloads, e.g. `/lab/2026.11.05-86047df/`. */
const INSTALLER_VERSION_PATTERN = /\/lab\/(\d{4}\.\d{2}\.\d{2}(?:-[0-9a-z]+)?)\//u
/**
 * Whether a resolved harness binary belongs to the CodeInOven application
 * itself rather than a user install   e.g. `node_modules/.bin/pi.exe` inside
 * a dev checkout. App-owned copies update with the app, so self-update must
 * never be offered (it would mutate the app's own dependencies).
 */
function isAppOwnedInstall(resolvedPath: string | undefined): boolean {
  if (!resolvedPath) return false
  const appRoot = app.getAppPath()
  const relativePath = relative(appRoot, resolvedPath)
  const inside =
    relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  if (inside || process.platform !== 'win32') return inside
  // Windows is case-insensitive; a differing drive-letter casing would
  // otherwise report an app-owned path as user-owned.
  const lowerRelative = relative(appRoot.toLowerCase(), resolvedPath.toLowerCase())
  return lowerRelative === '' || (!lowerRelative.startsWith('..') && !isAbsolute(lowerRelative))
}

/**
 * The command that upgrades a Homebrew-owned install, or `undefined` when the
 * harness was installed some other way.
 *
 * A Homebrew-owned harness has to be updated by Homebrew. Its vendor updater
 * either refuses outright   Claude Code answers `claude update` with "Claude is
 * managed by Homebrew"   or writes a second copy the app never drives, so the
 * Update action would leave the install exactly where it was.
 */
async function homebrewUpgradeArgsFor(
  provider: ProviderConnectionInfo | undefined
): Promise<string[] | undefined> {
  // A WSL install is a Linux binary inside the distribution, not this host's
  // Homebrew, so its own updater stays the truth there.
  if (provider?.executionTarget?.kind === 'wsl') return undefined
  const pkg = await homebrewPackageFor(provider?.resolvedPath)
  return pkg ? homebrewUpgradeArgs(pkg) : undefined
}

/** Pull the first `major.minor.patch` sequence out of a `--version` line. */
export function extractHarnessVersion(output: string): string | undefined {
  return output.match(VERSION_PATTERN)?.[1]?.replace(/^v/u, '')
}

/**
 * The harness's own documented self-update arguments, or undefined when it has
 * none. Remote ovens and the local embedded-terminal handoff both read these,
 * so a harness's updater is described once.
 */
export function harnessSelfUpdateArgs(harnessId: string): string[] | undefined {
  return UPDATE_ARGS[harnessId]
}

/**
 * The latest published version of a harness, or undefined when CodeInOven has no
 * verified source for it (Muse Code publishes no release feed the app tracks).
 * A lookup failure is returned as a discriminated result instead of thrown,
 * because "could not check" must never read as "up to date".
 */
export async function latestHarnessVersion(
  harnessId: string
): Promise<{ ok: true; version: string } | { ok: false; detail: string }> {
  const source = UPDATE_SOURCES[harnessId]
  if (!source) return { ok: false, detail: 'No update source is configured for this harness.' }
  try {
    const latest = await fetchLatest(source)
    return { ok: true, version: extractHarnessVersion(latest) ?? latest }
  } catch (error) {
    Logger.dev(`[harness-update] ${harnessId} lookup failed:`, error)
    return { ok: false, detail: 'The latest version could not be checked. Are you online?' }
  }
}

async function fetchLatest(source: UpdateSource): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    if (source.kind === 'npm') {
      const response = await fetch(
        `https://registry.npmjs.org/${encodeURIComponent(source.package)}/latest`,
        { signal: controller.signal }
      )
      if (!response.ok) {
        throw new Error(`npm registry returned HTTP ${response.status}`)
      }
      const body = (await response.json()) as { version?: unknown }
      if (typeof body['version'] !== 'string') {
        throw new Error('npm registry did not report a version')
      }
      return body['version']
    }
    if (source.kind === 'installer') {
      const response = await fetch(source.url, { signal: controller.signal })
      if (!response.ok) {
        throw new Error(`installer script returned HTTP ${response.status}`)
      }
      const script = await response.text()
      const version = script.match(INSTALLER_VERSION_PATTERN)?.[1]
      if (!version) throw new Error('installer script did not name a release')
      return version
    }
    const response = await fetch(`https://api.github.com/repos/${source.repo}/releases/latest`, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CodeInOven' }
    })
    if (!response.ok) {
      throw new Error(`GitHub releases returned HTTP ${response.status}`)
    }
    const body = (await response.json()) as { tag_name?: unknown }
    if (typeof body['tag_name'] !== 'string') {
      throw new Error('GitHub releases did not report a tag')
    }
    return body['tag_name'].replace(/^v/u, '')
  } finally {
    clearTimeout(timer)
  }
}

function idleStatus(harnessId: string): HarnessUpdateStatus {
  return { harnessId, state: 'idle', checkedAt: 0 }
}

/**
 * Detect whether installed harnesses are behind their distribution channel and
 * hand back the harness's own self-update command for the embedded terminal.
 *
 * Update availability is decided by comparing the already-probed installed
 * version (ProviderConnectionService) against the latest published version  
 * none of the harnesses expose a reliable "check only" CLI flag.
 */
export class HarnessUpdateService {
  private results = new Map<string, HarnessUpdateStatus>()
  private lastCheckedAt = 0
  private checkAllInFlight: Promise<HarnessUpdateStatus[]> | null = null
  private checkOneInFlight = new Map<string, Promise<HarnessUpdateStatus>>()
  private lookupQueueTail: Promise<void> = Promise.resolve()

  constructor(private providers: ProviderConnectionService) {}

  register(): void {
    ipcMain.handle('harnessUpdates:checkAll', (_, force?: unknown) => this.checkAll(force === true))
    ipcMain.handle('harnessUpdates:check', (_, rawHarnessId: unknown) =>
      this.checkOne(this.harnessId(rawHarnessId))
    )
    ipcMain.handle('harnessUpdates:handoff', (_, rawHarnessId: unknown) =>
      this.handoff(this.harnessId(rawHarnessId))
    )
  }

  /** Last completed per-harness results (never throws). */
  getAll(): HarnessUpdateStatus[] {
    const native = listHarnesses().map(
      (harness) => this.results.get(harness.id) ?? idleStatus(harness.id)
    )
    // ACP agents are listed beside the harnesses, so their update state travels
    // with them into the same status map the page reads.
    const acp = currentAcpAgents().map(
      (agent) => this.results.get(agent.id) ?? idleStatus(agent.id)
    )
    return [...native, ...acp]
  }

  async checkAll(force = false): Promise<HarnessUpdateStatus[]> {
    if (!force && Date.now() - this.lastCheckedAt < UPDATE_CACHE_TTL_MS) return this.getAll()
    if (this.checkAllInFlight) return this.checkAllInFlight

    const check = this.runCheckAll()
    this.checkAllInFlight = check
    try {
      return await check
    } finally {
      this.checkAllInFlight = null
    }
  }

  async checkOne(harnessId: string): Promise<HarnessUpdateStatus> {
    const active = this.checkOneInFlight.get(harnessId)
    if (active) return active

    const check = this.runCheckOne(harnessId)
    this.checkOneInFlight.set(harnessId, check)
    try {
      return await check
    } finally {
      this.checkOneInFlight.delete(harnessId)
    }
  }

  private async runCheckAll(): Promise<HarnessUpdateStatus[]> {
    const results: HarnessUpdateStatus[] = []
    await ensureAcpAgentsLoaded()
    const ids = [
      ...listHarnesses().map((harness) => harness.id),
      ...currentAcpAgents().map((agent) => agent.id)
    ]
    for (const [index, id] of ids.entries()) {
      results.push(await this.checkOne(id))
      if (index < ids.length - 1) await this.yieldToMainLoop()
    }
    this.lastCheckedAt = Date.now()
    return results
  }

  private async runCheckOne(harnessId: string): Promise<HarnessUpdateStatus> {
    if (isAcpAgentId(harnessId)) return this.runCheckAcpAgent(harnessId)
    const provider = this.providers.getAll().find((candidate) => candidate.id === harnessId)
    const base = idleStatus(harnessId)
    if (!provider || provider.status !== 'available') {
      return this.settle(harnessId, {
        ...base,
        state: 'error',
        detail: 'Harness is not installed   nothing to update.'
      })
    }

    const currentVersion = provider.version ? extractHarnessVersion(provider.version) : undefined
    if (provider.executionTarget?.kind === 'bundled' || isAppOwnedInstall(provider.resolvedPath)) {
      return this.settle(harnessId, {
        ...base,
        currentVersion,
        state: 'current',
        detail: 'Bundled with CodeInOven   updates with the app.'
      })
    }
    // A Homebrew-owned install answers to Homebrew, and Homebrew is the only
    // thing that can tell the user whether there is anything to install.
    const viaHomebrew = await this.homebrewUpdateStatus(harnessId, provider, currentVersion)
    if (viaHomebrew) return this.settle(harnessId, viaHomebrew)
    const source = UPDATE_SOURCES[harnessId]
    if (!source) {
      return this.settle(harnessId, {
        ...base,
        currentVersion,
        state: 'error',
        detail: 'No update source is configured for this harness.'
      })
    }

    let latestVersion: string | undefined
    try {
      latestVersion = await this.enqueueLookup(() => fetchLatest(source))
    } catch (error) {
      Logger.dev(`[harness-update] ${harnessId} lookup failed:`, error)
      return this.settle(harnessId, {
        ...base,
        currentVersion,
        state: 'error',
        detail: 'Update check failed   are you online?'
      })
    }

    const latestClean = extractHarnessVersion(latestVersion) ?? latestVersion
    if (!currentVersion || !latestClean) {
      return this.settle(harnessId, {
        ...base,
        currentVersion,
        latestVersion,
        state: 'error',
        detail: 'Versions could not be compared.'
      })
    }

    const updateAvailable = compareVersions(latestClean, currentVersion) > 0
    return this.settle(harnessId, {
      ...base,
      currentVersion,
      latestVersion,
      state: updateAvailable ? 'update_available' : 'current'
    })
  }

  /**
   * Update availability as Homebrew sees it, or `undefined` when Homebrew does
   * not own this install or could not answer.
   *
   * A Homebrew-owned harness is measured against what Homebrew can install. The
   * published feed the app tracks may be a different channel on a different
   * version line, and a badge a `brew upgrade` cannot clear is a dead end.
   */
  private async homebrewUpdateStatus(
    harnessId: string,
    provider: ProviderConnectionInfo | undefined,
    currentVersion: string | undefined
  ): Promise<HarnessUpdateStatus | undefined> {
    if (provider?.executionTarget?.kind === 'wsl') return undefined
    const pkg = await homebrewPackageFor(provider?.resolvedPath)
    if (!pkg) return undefined
    const versions = await homebrewVersions(pkg)
    const installed = versions?.installed ? extractHarnessVersion(versions.installed) : undefined
    const latest = versions?.latest ? extractHarnessVersion(versions.latest) : undefined
    const from = installed ?? currentVersion
    if (!from || !latest) return undefined
    return {
      ...idleStatus(harnessId),
      currentVersion: from,
      latestVersion: latest,
      state: compareVersions(latest, from) > 0 ? 'update_available' : 'current'
    }
  }
  async handoff(harnessId: string): Promise<HarnessUpdateHandoff> {
    if (isAcpAgentId(harnessId)) return this.acpHandoff(harnessId)
    const definition = findHarness(harnessId)
    if (!definition) throw new Error(`Unknown harness: ${harnessId}`)
    const args = UPDATE_ARGS[harnessId]
    if (!args) {
      throw new Error(`No self-update command is configured for harness: ${harnessId}`)
    }
    const provider = this.providers.getAll().find((candidate) => candidate.id === harnessId)
    if (
      provider?.executionTarget?.kind === 'bundled' ||
      isAppOwnedInstall(provider?.resolvedPath)
    ) {
      throw new Error(`${definition.name} is bundled with CodeInOven   it updates with the app.`)
    }
    // Homebrew owns its installs outright: `brew upgrade` is the only command
    // that moves them, so it replaces the harness's own updater entirely.
    const brewArgs = await homebrewUpgradeArgsFor(provider)
    if (brewArgs) {
      const prepared = await prepareHarnessTerminalHandoff('brew', brewArgs)
      return {
        kind: 'terminal',
        command: prepared.command,
        args: prepared.args,
        title: `Update ${definition.name} with Homebrew`
      }
    }
    // OpenCode is the one harness whose current release is a different version
    // line under the same command, so a V1 install updates through the V2
    // installer instead of its own `upgrade`. WSL keeps the harness's own
    // command (the installer handoff cannot run there).
    const openCodeOverride =
      harnessId === 'opencode' && provider?.executionTarget?.kind !== 'wsl'
        ? openCodeUpdateHandoff(provider)
        : null
    const prepared =
      provider?.executionTarget?.kind === 'wsl' && provider.resolvedPath
        ? await prepareWslTerminalHandoff(
            provider.executionTarget.distribution,
            provider.resolvedPath,
            args
          )
        : await prepareHarnessTerminalHandoff(
            openCodeOverride?.command ??
              // An OpenCode self-update must land on the install the app drives.
              // The registry names the harness `opencode`, and the updater would
              // resolve that name through PATH, which is a different copy on a
              // machine whose PATH copy is the package manager's.
              (harnessId === 'opencode' ? resolvedOpenCodeCommand() : definition.command),
            openCodeOverride?.args ?? args
          )
    return {
      kind: 'terminal',
      command: prepared.command,
      args: prepared.args,
      title: `Update ${definition.name}`
    }
  }

  /**
   * Whether an ACP agent is behind the release its vendor publishes.
   *
   * Everything here is best-effort by design: a failed lookup, an agent with no
   * updater and an agent whose feed the app does not know all settle as `idle`,
   * so a network hiccup never paints a working agent as broken. `idle` still
   * leaves the agent's Update action available in its own menu.
   */
  private async runCheckAcpAgent(harnessId: string): Promise<HarnessUpdateStatus> {
    const base = idleStatus(harnessId)
    const agent = await findAcpAgent(harnessId)
    if (!agent) {
      return this.settle(harnessId, {
        ...base,
        state: 'error',
        detail: 'This ACP agent is no longer configured.'
      })
    }
    const provider = this.providers.getAll().find((candidate) => candidate.id === harnessId)
    if (provider?.status !== 'available') {
      return this.settle(harnessId, {
        ...base,
        state: 'error',
        detail: 'The agent is not installed   nothing to update.'
      })
    }
    const currentVersion = provider.version ? extractHarnessVersion(provider.version) : undefined
    const viaHomebrew = await this.homebrewUpdateStatus(harnessId, provider, currentVersion)
    if (viaHomebrew) return this.settle(harnessId, viaHomebrew)
    const updateCommand = acpUpdateCommandFor(agent)
    if (!updateCommand) {
      return this.settle(harnessId, {
        ...base,
        currentVersion,
        state: 'idle',
        detail: 'No update command is set for this agent.'
      })
    }
    const source = ACP_UPDATE_SOURCES[acpCommandName(agent.command)]
    if (!source) {
      return this.settle(harnessId, {
        ...base,
        currentVersion,
        state: 'idle',
        detail: 'The app does not track a published version for this agent.'
      })
    }
    let latestVersion: string | undefined
    try {
      latestVersion = await this.enqueueLookup(() => fetchLatest(source))
    } catch (error) {
      Logger.dev(`[harness-update] ${harnessId} lookup failed:`, error)
      return this.settle(harnessId, { ...base, currentVersion, state: 'idle' })
    }
    const latestClean = extractHarnessVersion(latestVersion) ?? latestVersion
    if (!currentVersion || !latestClean) {
      return this.settle(harnessId, { ...base, currentVersion, latestVersion, state: 'idle' })
    }
    const updateAvailable = compareVersions(latestClean, currentVersion) > 0
    return this.settle(harnessId, {
      ...base,
      currentVersion,
      latestVersion,
      state: updateAvailable ? 'update_available' : 'current'
    })
  }

  /** Hand the agent's own updater to the embedded terminal. */
  private async acpHandoff(harnessId: string): Promise<HarnessUpdateHandoff> {
    const agent = await findAcpAgent(harnessId)
    if (!agent) throw new Error('This ACP agent is no longer configured.')
    // An ACP agent is the user's own binary, so its install method decides how it
    // updates: a Homebrew-owned agent is upgraded by Homebrew like any harness.
    const provider = this.providers.getAll().find((candidate) => candidate.id === harnessId)
    const brewArgs = await homebrewUpgradeArgsFor(provider)
    if (brewArgs) {
      const prepared = await prepareHarnessTerminalHandoff('brew', brewArgs)
      return {
        kind: 'terminal',
        command: prepared.command,
        args: prepared.args,
        title: `Update ${agent.name} with Homebrew`
      }
    }
    const line = acpUpdateCommandFor(agent)
    if (!line) {
      throw new Error(`${agent.name} has no update command. Set one while editing the agent.`)
    }
    const { command, args } = splitAcpUpdateCommand(line)
    if (command.length === 0) {
      throw new Error(`${agent.name} has no update command. Set one while editing the agent.`)
    }
    const prepared = await prepareHarnessTerminalHandoff(command, args)
    return {
      kind: 'terminal',
      command: prepared.command,
      args: prepared.args,
      title: `Update ${agent.name}`
    }
  }

  private harnessId(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
      throw new TypeError('Harness ID is invalid')
    }
    return value.trim()
  }

  private settle(harnessId: string, status: HarnessUpdateStatus): HarnessUpdateStatus {
    const finalized = { ...status, checkedAt: Date.now() }
    this.results.set(harnessId, finalized)
    return finalized
  }

  private yieldToMainLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, UPDATE_YIELD_MS))
  }

  /** Serialize registry traffic even when windows or row actions overlap. */
  private enqueueLookup<T>(task: () => Promise<T>): Promise<T> {
    const preceding = this.lookupQueueTail
    let release: () => void = () => undefined
    this.lookupQueueTail = new Promise<void>((resolve) => {
      release = resolve
    })
    return preceding.then(task).finally(release)
  }
}
