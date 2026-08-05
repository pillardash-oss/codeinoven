import { BrowserWindow, ipcMain } from 'electron'
import { execFile, spawn } from 'child_process'
import type { ProviderConnectionInfo } from '../lib/types'
import { buildHarnessEnvironment } from './drivers/cli-environment'
import { findHarness, listHarnesses, type HarnessDescriptor } from './harness-registry'

/** Probe timeout — harnesses that hang longer than this are marked as error. */
const PROBE_TIMEOUT_MS = 8000

/**
 * ProviderConnectionService — detects local AI harnesses by resolving their
 * binaries on an augmented PATH and verifying they respond to a version probe.
 * Broadcasts live status to all renderer windows over IPC. The harness list is
 * sourced from the harness registry — the single source of truth.
 */
export class ProviderConnectionService {
  private statuses = new Map<string, ProviderConnectionInfo>()

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
    ipcMain.handle('providers:checkAll', () => this.checkAll())
  }

  getAll(): ProviderConnectionInfo[] {
    return Array.from(this.statuses.values())
  }

  async checkOne(id: string): Promise<ProviderConnectionInfo> {
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
    const result = await this.probe(def)
    this.update(result)
    return result
  }

  async checkAll(): Promise<ProviderConnectionInfo[]> {
    const checks = listHarnesses().map((def) => {
      const current = this.statuses.get(def.id)
      if (current) this.update({ ...current, status: 'checking', detail: undefined })
      return this.probe(def)
    })
    const results = await Promise.all(checks)
    for (const result of results) {
      this.update(result)
    }
    return this.getAll()
  }

  /** Run the initial detection pass (fire-and-forget on app start). */
  warmUp(): void {
    void this.checkAll()
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private update(info: ProviderConnectionInfo): void {
    this.statuses.set(info.id, info)
    this.broadcast()
  }

  private broadcast(): void {
    const payload = this.getAll()
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('providers:status', payload)
    }
  }

  /** Resolve the binary, then verify it actually responds to a version probe. */
  private async probe(def: HarnessDescriptor): Promise<ProviderConnectionInfo> {
    const base: ProviderConnectionInfo = {
      id: def.id,
      name: def.name,
      command: def.command,
      integration: def.integration,
      supportsCustomProviders: def.supportsCustomProviders,
      status: 'idle'
    }

    const located = await this.locateBinary(def.command)
    if (!located.found) {
      return { ...base, status: 'not_found', detail: `"${def.command}" not found on PATH` }
    }

    const versionResult = await this.probeVersion(def)
    if (versionResult.ok) {
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
    return buildHarnessEnvironment()
  }

  private locateBinary(command: string): Promise<{ found: boolean; path?: string }> {
    const probe = process.platform === 'win32' ? 'where' : 'which'
    return new Promise((resolve) => {
      execFile(probe, [command], { env: this.buildEnv(), timeout: 5000 }, (error, stdout) => {
        if (error) {
          resolve({ found: false })
          return
        }
        const resolved = stdout.split('\n')[0]?.trim() ?? ''
        resolve({ found: true, path: resolved || undefined })
      })
    })
  }

  /** Execute `<command> --version` with a timeout to prove the harness responds. */
  private probeVersion(
    def: HarnessDescriptor
  ): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
    return new Promise((resolve) => {
      const child = spawn(def.command, def.versionArgs, {
        env: this.buildEnv(),
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill()
        resolve({ ok: false, reason: `Timed out after ${PROBE_TIMEOUT_MS / 1000}s` })
      }, PROBE_TIMEOUT_MS)
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        resolve({ ok: false, reason: error.message.split('\n')[0]?.trim() || 'unknown error' })
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          const reason =
            (stderr || stdout).split('\n')[0]?.trim() || `Exited with code ${code ?? 'unknown'}`
          resolve({ ok: false, reason })
          return
        }
        const version = (stdout || stderr).split('\n')[0]?.trim() ?? ''
        resolve({ ok: true, version })
      })
    })
  }
}
