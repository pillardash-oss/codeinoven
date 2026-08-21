import { BrowserWindow } from 'electron'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { spawn } from 'child_process'
import type { ProviderConnectionInfo } from '../../lib/types'
import { buildProcessEnvironment, resolveExecutablePath } from '../drivers/cli-environment'
import { findHarness, listHarnesses, type HarnessDescriptor } from '../agents/harness-registry'
import { forwardRemoteEvent } from '../remote/remote-event-forwarder'
import { sendToRenderer } from '../ipc/renderer-delivery'

/** Probe timeout — harnesses that hang longer than this are marked as error. */
const PROBE_TIMEOUT_MS = 8000
/** Reopening Settings inside this window reuses the last completed probe pass. */
const PROBE_CACHE_TTL_MS = 60_000
/** A version command should emit one line. Cap broken CLIs before they consume RAM. */
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024
/** Give Electron's main loop time between child processes on low-end machines. */
const PROBE_YIELD_MS = 50
/** Coalesce renderer work while still reporting progress during a full pass. */
const PROBE_BROADCAST_BATCH_SIZE = 2

/**
 * The harness is installed but its detected version is not yet supported by
 * CodeInOven. The Harnesses page surfaces a notice; everywhere else the harness
 * is treated as not installed.
 */
export const OPENCODE_V2_UNSUPPORTED_DETAIL =
  'Open Code V2 support is not available at the moment. Pending the release of the stable release of Open Code V2.'

/** True when a `--version` line reports a major version >= 2 (OpenCode V2). */
function isOpenCodeV2(version: string): boolean {
  const match = /(\d+)/u.exec(version)
  const major = match ? Number.parseInt(match[1], 10) : Number.NaN
  return Number.isFinite(major) && major >= 2
}

/**
 * ProviderConnectionService — detects local AI harnesses by resolving their
 * binaries on an augmented PATH and verifying they respond to a version probe.
 * Broadcasts live status to all renderer windows over IPC. The harness list is
 * sourced from the harness registry — the single source of truth.
 */
export class ProviderConnectionService {
  private statuses = new Map<string, ProviderConnectionInfo>()
  private lastCheckedAt = 0
  private checkAllInFlight: Promise<ProviderConnectionInfo[]> | null = null
  private checkOneInFlight = new Map<string, Promise<ProviderConnectionInfo>>()
  private probeQueueTail: Promise<void> = Promise.resolve()

  constructor() {
    for (const harness of listHarnesses()) {
      this.statuses.set(harness.id, {
        id: harness.id,
        name: harness.name,
        command: harness.command,
        integration: harness.integration,
        supportsCustomProviders: harness.supportsCustomProviders,
        status: 'idle'
      })
    }
  }

  register(): void {
    ipcMain.handle('providers:getStatus', () => this.getAll())
    ipcMain.handle('providers:check', (_, id: string) => this.checkOne(id))
    ipcMain.handle('providers:checkAll', (_, force?: unknown) => this.checkAll(force === true))
  }

  getAll(): ProviderConnectionInfo[] {
    return Array.from(this.statuses.values())
  }

  async checkOne(id: string): Promise<ProviderConnectionInfo> {
    const active = this.checkOneInFlight.get(id)
    if (active) return active

    const check = this.runCheckOne(id)
    this.checkOneInFlight.set(id, check)
    try {
      return await check
    } finally {
      this.checkOneInFlight.delete(id)
    }
  }

  private async runCheckOne(id: string): Promise<ProviderConnectionInfo> {
    const def = findHarness(id)
    const current = this.statuses.get(id)
    if (!def || !current) {
      return (
        current ?? {
          id,
          name: id,
          command: id,
          integration: 'planned',
          supportsCustomProviders: false,
          status: 'error',
          detail: 'Unknown provider'
        }
      )
    }

    this.update({ ...current, status: 'checking', detail: undefined })
    const result = await this.enqueueProbe(() => this.probe(def, this.buildEnv()))
    this.update(result)
    return result
  }

  async checkAll(force = false): Promise<ProviderConnectionInfo[]> {
    if (!force && Date.now() - this.lastCheckedAt < PROBE_CACHE_TTL_MS) return this.getAll()
    if (this.checkAllInFlight) return this.checkAllInFlight

    const check = this.runCheckAll()
    this.checkAllInFlight = check
    try {
      return await check
    } finally {
      this.checkAllInFlight = null
    }
  }

  private async runCheckAll(): Promise<ProviderConnectionInfo[]> {
    const harnesses = listHarnesses()
    const env = this.buildEnv()

    for (const definition of harnesses) {
      const current = this.statuses.get(definition.id)
      if (current) {
        this.statuses.set(definition.id, {
          ...current,
          status: 'checking',
          detail: undefined
        })
      }
    }
    this.broadcast()

    for (const [index, definition] of harnesses.entries()) {
      const result = await this.enqueueProbe(() => this.probe(definition, env))
      this.statuses.set(result.id, result)
      if ((index + 1) % PROBE_BROADCAST_BATCH_SIZE === 0 || index === harnesses.length - 1) {
        this.broadcast()
      }
      if (index < harnesses.length - 1) await this.yieldToMainLoop()
    }

    this.lastCheckedAt = Date.now()
    return this.getAll()
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private update(info: ProviderConnectionInfo): void {
    this.statuses.set(info.id, info)
    this.broadcast()
  }

  private broadcast(): void {
    const payload = this.getAll()
    for (const win of BrowserWindow.getAllWindows()) {
      sendToRenderer(win.webContents, 'providers:status', payload)
    }
    forwardRemoteEvent('providers:status', payload)
  }

  /** Resolve the binary, then verify it actually responds to a version probe. */
  private async probe(
    def: HarnessDescriptor,
    env: NodeJS.ProcessEnv
  ): Promise<ProviderConnectionInfo> {
    const base: ProviderConnectionInfo = {
      id: def.id,
      name: def.name,
      command: def.command,
      integration: def.integration,
      supportsCustomProviders: def.supportsCustomProviders,
      status: 'idle'
    }

    const located = this.locateBinary(def.command, env)
    if (!located.found) {
      return { ...base, status: 'not_found', detail: `"${def.command}" not found on PATH` }
    }

    const versionResult = await this.probeVersion(def, located.path, env)
    if (versionResult.ok) {
      // OpenCode V2 is not yet supported: report it as installed-but-unsupported
      // so the Harnesses page can surface a notice while every availability
      // check treats it as not installed.
      if (def.id === 'opencode' && isOpenCodeV2(versionResult.version)) {
        return {
          ...base,
          status: 'error',
          resolvedPath: located.path,
          version: versionResult.version,
          unsupportedReason: 'opencode-v2',
          detail: OPENCODE_V2_UNSUPPORTED_DETAIL
        }
      }
      return {
        ...base,
        status: 'available',
        resolvedPath: located.path,
        version: versionResult.version
      }
    }

    return {
      ...base,
      status: 'error',
      resolvedPath: located.path,
      detail: versionResult.reason
    }
  }

  /** GUI apps don't inherit the shell PATH — augment with common install locations. */
  private buildEnv(): NodeJS.ProcessEnv {
    return buildProcessEnvironment()
  }

  private locateBinary(command: string, env: NodeJS.ProcessEnv): { found: boolean; path?: string } {
    const path = resolveExecutablePath(command, env)
    return path ? { found: true, path } : { found: false }
  }

  /** Execute `<command> --version` with a timeout to prove the harness responds. */
  private probeVersion(
    def: HarnessDescriptor,
    resolvedPath: string | undefined,
    env: NodeJS.ProcessEnv
  ): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
    return new Promise((resolve) => {
      const child = spawn(resolvedPath ?? def.command, def.versionArgs, {
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      let outputBytes = 0
      let settled = false
      const finish = (result: { ok: true; version: string } | { ok: false; reason: string }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const append = (current: string, chunk: Buffer): string => {
        outputBytes += chunk.byteLength
        if (outputBytes > MAX_PROBE_OUTPUT_BYTES) {
          child.kill()
          finish({ ok: false, reason: 'Version probe produced too much output' })
          return current
        }
        return current + chunk.toString()
      }
      const timer = setTimeout(() => {
        child.kill()
        finish({ ok: false, reason: `Timed out after ${PROBE_TIMEOUT_MS / 1000}s` })
      }, PROBE_TIMEOUT_MS)
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = append(stdout, chunk)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = append(stderr, chunk)
      })
      child.on('error', (error) => {
        finish({ ok: false, reason: error.message.split('\n')[0]?.trim() || 'unknown error' })
      })
      child.on('exit', (code) => {
        if (code !== 0) {
          const reason =
            (stderr || stdout).split('\n')[0]?.trim() || `Exited with code ${code ?? 'unknown'}`
          finish({ ok: false, reason })
          return
        }
        const version = (stdout || stderr).split('\n')[0]?.trim() ?? ''
        finish({ ok: true, version })
      })
    })
  }

  private yieldToMainLoop(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, PROBE_YIELD_MS))
  }

  /** Serialize every version process, including overlapping windows and row clicks. */
  private enqueueProbe<T>(task: () => Promise<T>): Promise<T> {
    const preceding = this.probeQueueTail
    let release: () => void = () => undefined
    this.probeQueueTail = new Promise<void>((resolve) => {
      release = resolve
    })
    return preceding.then(task).finally(release)
  }
}
