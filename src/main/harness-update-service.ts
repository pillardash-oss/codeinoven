import { trustedIpcMain as ipcMain } from './trusted-ipc-main'
import type { HarnessUpdateHandoff, HarnessUpdateStatus } from '../lib/types'
import { findHarness, listHarnesses } from './harness-registry'
import type { ProviderConnectionService } from './provider-connection'
import { Logger } from './logger'

/** Network timeout for a registry/release lookup — a slow network must never hang the UI. */
const FETCH_TIMEOUT_MS = 10_000

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
  opencode: { kind: 'npm', package: 'opencode-ai' },
  codex: { kind: 'npm', package: '@openai/codex' },
  'claude-code': { kind: 'npm', package: '@anthropic-ai/claude-code' },
  cline: { kind: 'npm', package: 'cline' },
  pi: { kind: 'npm', package: '@earendil-works/pi-coding-agent' },
  antigravity: { kind: 'github', repo: 'google-antigravity/antigravity-cli' }
}

/**
 * The harness's own self-update command, run by the user inside the embedded
 * terminal — CodeInOven never mutates a harness install on its own.
 */
const UPDATE_ARGS: Record<string, string[]> = {
  opencode: ['upgrade'],
  codex: ['update'],
  'claude-code': ['update'],
  cline: ['update'],
  pi: ['update'],
  antigravity: ['update']
}

const VERSION_PATTERN = /\b(v?\d+\.\d+\.\d+)/u

/** Pull the first `major.minor.patch` sequence out of a `--version` line. */
function extractVersion(output: string): string | undefined {
  return output.match(VERSION_PATTERN)?.[1]?.replace(/^v/u, '')
}

/**
 * Three-part numeric semver compare (prerelease/build metadata ignored). Returns
 * > 0 when `a` is newer than `b`, < 0 when older, 0 when equal.
 */
function compareVersions(a: string, b: string): number {
  const parse = (value: string): [number, number, number] => {
    const [major, minor, patch] = value.split('.').map((part) => Number.parseInt(part, 10))
    return [major ?? 0, minor ?? 0, patch ?? 0]
  }
  const [aMajor, aMinor, aPatch] = parse(a)
  const [bMajor, bMinor, bPatch] = parse(b)
  if (aMajor !== bMajor) return aMajor - bMajor
  if (aMinor !== bMinor) return aMinor - bMinor
  return aPatch - bPatch
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
 * version (ProviderConnectionService) against the latest published version —
 * none of the harnesses expose a reliable "check only" CLI flag.
 */
export class HarnessUpdateService {
  private results = new Map<string, HarnessUpdateStatus>()

  constructor(private providers: ProviderConnectionService) {}

  register(): void {
    ipcMain.handle('harnessUpdates:checkAll', () => this.checkAll())
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

  async checkAll(): Promise<HarnessUpdateStatus[]> {
    const results = await Promise.all(listHarnesses().map((harness) => this.checkOne(harness.id)))
    return results
  }

  async checkOne(harnessId: string): Promise<HarnessUpdateStatus> {
    const provider = this.providers.getAll().find((candidate) => candidate.id === harnessId)
    const base = idleStatus(harnessId)
    if (!provider || provider.status !== 'available') {
      return this.settle(harnessId, {
        ...base,
        state: 'error',
        detail: 'Harness is not installed — nothing to update.'
      })
    }

    const currentVersion = provider.version ? extractVersion(provider.version) : undefined
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
      latestVersion = await fetchLatest(source)
    } catch (error) {
      Logger.dev(`[harness-update] ${harnessId} lookup failed:`, error)
      return this.settle(harnessId, {
        ...base,
        currentVersion,
        state: 'error',
        detail: 'Update check failed — are you online?'
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
  handoff(harnessId: string): HarnessUpdateHandoff {
    const definition = findHarness(harnessId)
    if (!definition) throw new Error(`Unknown harness: ${harnessId}`)
    const args = UPDATE_ARGS[harnessId]
    if (!args) {
      throw new Error(`No self-update command is configured for harness: ${harnessId}`)
    }
    return {
      kind: 'terminal',
      command: definition.command,
      args,
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
}
