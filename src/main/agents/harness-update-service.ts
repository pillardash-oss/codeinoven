import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { app } from 'electron'
import { isAbsolute, relative } from 'node:path'
import type {
  HarnessUpdateHandoff,
  HarnessUpdateStatus,
  ProviderConnectionInfo
} from '../../lib/types'
import { findHarness, listHarnesses } from './harness-registry'
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
type UpdateSource = NpmSource | GitHubSource

/**
 * Where the latest published version of each harness lives. Sources were
 * verified against the harnesses' real install channels:
 *  - npm-distributed CLIs query the registry `latest` tag.
 *  - Antigravity ships a standalone binary; its releases are published on GitHub.
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

/** Pull the first `major.minor.patch` sequence out of a `--version` line. */
function extractVersion(output: string): string | undefined {
  return output.match(VERSION_PATTERN)?.[1]?.replace(/^v/u, '')
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
    return listHarnesses().map((harness) => this.results.get(harness.id) ?? idleStatus(harness.id))
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
    const harnesses = listHarnesses()
    for (const [index, harness] of harnesses.entries()) {
      results.push(await this.checkOne(harness.id))
      if (index < harnesses.length - 1) await this.yieldToMainLoop()
    }
    this.lastCheckedAt = Date.now()
    return results
  }

  private async runCheckOne(harnessId: string): Promise<HarnessUpdateStatus> {
    const provider = this.providers.getAll().find((candidate) => candidate.id === harnessId)
    const base = idleStatus(harnessId)
    if (!provider || provider.status !== 'available') {
      return this.settle(harnessId, {
        ...base,
        state: 'error',
        detail: 'Harness is not installed   nothing to update.'
      })
    }

    const currentVersion = provider.version ? extractVersion(provider.version) : undefined
    if (provider.executionTarget?.kind === 'bundled' || isAppOwnedInstall(provider.resolvedPath)) {
      return this.settle(harnessId, {
        ...base,
        currentVersion,
        state: 'current',
        detail: 'Bundled with CodeInOven   updates with the app.'
      })
    }
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

    const latestClean = extractVersion(latestVersion) ?? latestVersion
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

  /** Build, but do not execute, the update handoff for the embedded terminal. */
  async handoff(harnessId: string): Promise<HarnessUpdateHandoff> {
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
        ? prepareWslTerminalHandoff(
            provider.executionTarget.distribution,
            provider.resolvedPath,
            args
          )
        : await prepareHarnessTerminalHandoff(
            openCodeOverride?.command ?? definition.command,
            openCodeOverride?.args ?? args
          )
    return {
      kind: 'terminal',
      command: prepared.command,
      args: prepared.args,
      title: `Update ${definition.name}`
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
