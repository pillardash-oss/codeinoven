import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { access, mkdir, open, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type {
  GatewayAdapterDefinition,
  GatewayCatalogSnapshot,
  GatewayInstallProgress,
  GatewayLifecycleState,
  GatewayModelInfo,
  GatewayPluginState,
  GatewayStatus
} from '../../lib/gateway-types'
import { getConfigRoot } from '../../lib/utils'
import type { StorageEngine } from '../storage/storage-engine'
import type { SecretVault } from '../storage/secret-vault'
import type { BaseUrlProviderService } from '../providers/base-url-provider-service'
import { Logger } from '../system/logger'
import { OwnedProcessJournal } from '../system/owned-process-journal'
import {
  buildProcessEnvironment,
  commandRequiresShell,
  resolveExecutablePath,
  resolvePackageCommand
} from '../drivers/cli-environment'
import {
  getGatewayAdapter,
  DEFAULT_GATEWAY_ADAPTER_ID,
  DEFAULT_GATEWAY_PLUGIN_ID
} from './gateway-adapters'
import { removeGatewayProviders, syncGatewayProviders } from './gateway-provider-sync'

const STATE_PATH = 'gateways/state.json'
const STATE_VERSION = 1
const INSTALL_TIMEOUT_MS = 300_000
const START_TIMEOUT_MS = 90_000
const HEALTH_POLL_INTERVAL_MS = 500
const STOP_GRACE_MS = 5_000
const CATALOG_TTL_MS = 60_000
const PORT_PROBE_ATTEMPTS = 50
const STDERR_TAIL_LINES = 40
const DASHBOARD_PASSWORD_BYTES = 24
const PROGRESS_EMIT_INTERVAL_MS = 250
const DOWNLOAD_TIMEOUT_MS = 600_000

interface GatewayStateStore {
  version: number
  plugins: Record<string, GatewayPluginState>
}

interface CatalogStore {
  version: number
  snapshot: GatewayCatalogSnapshot
}

interface RunningInstance {
  child: ChildProcess
  port: number
  adapter: GatewayAdapterDefinition
}

export type GatewayStateListener = (status: GatewayStatus) => void

/**
 * Owns the full lifecycle of managed local gateway processes: app-owned
 * installation via an available package manager, supervised launch on a loopback port, health gating,
 * model-catalog discovery, and syncing the discovered catalog into the harness
 * custom-provider store. CodeInOven — never the gateway — owns restarts,
 * ports, and cleanup; the root PID is journaled for crash reaping.
 */
export class GatewaySupervisorService {
  private readonly running = new Map<string, RunningInstance>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private readonly listeners = new Set<GatewayStateListener>()
  private readonly journal: OwnedProcessJournal | undefined
  private catalogCache = new Map<string, GatewayCatalogSnapshot>()
  private nodeVersionPromise: Promise<string> | null = null
  private readonly installProgress = new Map<string, GatewayInstallProgress>()
  private readonly lastProgressEmit = new Map<string, number>()
  private readonly lastProgressPhase = new Map<string, string | undefined>()

  constructor(
    private readonly storage: StorageEngine,
    private readonly providers: BaseUrlProviderService,
    private readonly vault?: SecretVault,
    journal?: OwnedProcessJournal
  ) {
    this.journal = journal
  }

  onStateChange(listener: GatewayStateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async listStatus(): Promise<GatewayStatus[]> {
    const store = await this.loadStore()
    return Promise.all(Object.values(store.plugins).map((state) => this.toStatus(state)))
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<GatewayStatus> {
    const state = await this.mutateState(pluginId, (current) => ({ ...current, enabled }))
    if (!enabled) await this.stop(pluginId)
    return this.toStatus(state)
  }

  /** Install (if needed) and start the gateway, gating readiness on health. */
  start(pluginId: string): Promise<GatewayStatus> {
    return this.serialize(pluginId, () => this.startInner(pluginId))
  }

  stop(pluginId: string): Promise<GatewayStatus> {
    return this.serialize(pluginId, () => this.stopInner(pluginId))
  }

  /**
   * Stop the gateway, remove every synced harness provider record, and delete
   * the app-owned install directory and catalog. The plugin stays seeded and
   * disabled so it can be installed again later.
   */
  uninstall(pluginId: string): Promise<GatewayStatus> {
    return this.serialize(pluginId, () => this.uninstallInner(pluginId))
  }

  /**
   * Reinstall at the adapter's pinned version (used when the pin moves). The
   * gateway is restarted automatically when it was running before the update.
   */
  update(pluginId: string): Promise<GatewayStatus> {
    return this.serialize(pluginId, () => this.updateInner(pluginId))
  }

  /** Resolve the provisioned dashboard password for clipboard copy. */
  async dashboardPassword(pluginId: string): Promise<string> {
    this.requireAdapter(pluginId)
    if (!this.vault) throw new Error('Secure credential storage is unavailable')
    return this.vault.resolve(dashboardPasswordRef(pluginId))
  }

  /** Force a fresh model-catalog fetch; requires a ready gateway. */
  async refreshCatalog(pluginId: string): Promise<GatewayModelInfo[]> {
    const instance = this.running.get(pluginId)
    const state = (await this.loadStore()).plugins[pluginId]
    if (!instance || !state) throw new Error('Gateway is not running')
    const snapshot = await this.fetchCatalog(instance.adapter, instance.port)
    await this.persistCatalog(pluginId, snapshot)
    this.catalogCache.set(pluginId, snapshot)
    await syncGatewayProviders(
      this.providers,
      pluginId,
      instance.adapter.name,
      `http://127.0.0.1:${instance.port}`,
      snapshot.models
    )
    return snapshot.models
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.running.keys()].map((pluginId) => this.stopInner(pluginId)))
  }

  /**
   * Kill gateway processes left orphaned by a crash or force-quit, then clear
   * the journal. A journaled PID is only killed when every check passes: the
   * live process is orphaned (dead parent), its command still matches the
   * gateway package, AND its working directory resolves to the journaled cwd
   * (the app-owned install directory). Any uncertainty — recycled PID running
   * an unrelated copy, undeterminable cwd — skips the kill. Must run before
   * any start on this launch.
   */
  async recoverOrphans(): Promise<{ killed: number[]; skipped: number[] }> {
    if (!this.journal) return { killed: [], skipped: [] }
    const roots = await this.journal.load()
    if (roots.length === 0) return { killed: [], skipped: [] }
    const snapshot = await processSnapshot()
    if (snapshot === null) {
      Logger.error('Gateway orphan recovery is unsupported on this platform', {
        platform: process.platform
      })
      return { killed: [], skipped: roots.map((root) => root.pid) }
    }
    const alive = new Set(snapshot.processes.keys())
    const killed: number[] = []
    const skipped: number[] = []
    for (const root of roots) {
      const entry = snapshot.processes.get(root.pid)
      if (!entry) {
        skipped.push(root.pid)
        continue
      }
      const orphaned = entry.parentPid <= 1 || !alive.has(entry.parentPid)
      if (!orphaned || !GATEWAY_PROCESS_PATTERN.test(entry.command)) {
        skipped.push(root.pid)
        continue
      }
      const liveCwd = await processWorkingDirectory(root.pid)
      if (liveCwd === null || !(await sameDirectory(root.cwd, liveCwd))) {
        Logger.dev('Gateway orphan recovery skipped a PID with a non-matching cwd', {
          pid: root.pid,
          journaledCwd: root.cwd,
          liveCwd
        })
        skipped.push(root.pid)
        continue
      }
      await killProcessTree(root.pid)
      killed.push(root.pid)
    }
    this.journal.clear()
    await this.journal.flush()
    if (killed.length > 0) {
      Logger.info('Reaped orphaned gateway processes', { killed })
    }
    return { killed, skipped }
  }

  /** Start every gateway whose plugin is enabled (used on app launch). */
  async autoStartEnabled(): Promise<void> {
    const store = await this.loadStore()
    for (const state of Object.values(store.plugins)) {
      if (!state.enabled || this.running.has(state.pluginId)) continue
      try {
        await this.start(state.pluginId)
      } catch (error) {
        Logger.error('Gateway auto-start failed', {
          pluginId: state.pluginId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  // ─── Lifecycle internals ────────────────────────────────────────────────────

  private async startInner(pluginId: string): Promise<GatewayStatus> {
    const adapter = this.requireAdapter(pluginId)
    if (this.running.has(pluginId)) {
      const state = (await this.loadStore()).plugins[pluginId]
      return this.toStatus(state)
    }
    try {
      await this.mutateState(pluginId, (current) => ({ ...current, lifecycle: 'starting', detail: undefined }))
      await this.mutateState(pluginId, (current) => ({ ...current, lifecycle: 'installing' }))
      const installDir = await this.ensureInstalled(pluginId, adapter)
      await this.mutateState(pluginId, (current) => ({ ...current, lifecycle: 'starting' }))
      const preferred = (await this.loadStore()).plugins[pluginId]?.preferredPort ?? 0
      const port = await this.allocatePort(preferred)
      const binPath = join(installDir, 'node_modules', adapter.npmPackage, adapter.binPath)
      await access(binPath)
      if (adapter.runtime === 'node') await this.assertNodeRuntime()
      const dashboardPassword = await this.ensureDashboardPassword(pluginId)

      const env = buildProcessEnvironment({
        ...process.env,
        ...(adapter.env ?? {}),
        PORT: String(port),
        DATA_DIR: this.dataDir(pluginId),
        ...(dashboardPassword === undefined ? {} : { INITIAL_PASSWORD: dashboardPassword })
      })
      const child = spawn(this.runtimeCommand(adapter, env), [binPath, ...adapter.serveArgs], {
        cwd: installDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const stderrTail = attachStderrTail(child)

      this.journal?.register(
        child.pid ?? 0,
        `codeinoven-gateway ${adapter.npmPackage} PORT=${port}`,
        installDir
      )
      this.running.set(pluginId, { child, port, adapter })

      child.once('exit', () => {
        this.running.delete(pluginId)
        this.journal?.unregister(child.pid ?? 0)
        void this.handleUnexpectedExit(pluginId, stderrTail())
      })

      await this.awaitHealthy(adapter, port, child)
      const snapshot = await this.fetchCatalog(adapter, port)
      await this.persistCatalog(pluginId, snapshot)
      this.catalogCache.set(pluginId, snapshot)
      await syncGatewayProviders(
        this.providers,
        pluginId,
        adapter.name,
        `http://127.0.0.1:${port}`,
        snapshot.models
      )
      const state = await this.mutateState(pluginId, (current) => ({
        ...current,
        lifecycle: 'ready',
        detail: undefined,
        boundPort: port,
        preferredPort: port,
        installedVersion: adapter.version,
        lastReadyAt: Date.now()
      }))
      return this.toStatus(state)
    } catch (error) {
      this.setProgress(pluginId, undefined)
      this.running.get(pluginId)?.child.kill('SIGTERM')
      this.running.delete(pluginId)
      const message = error instanceof Error ? error.message : String(error)
      const state = await this.mutateState(pluginId, (current) => ({
        ...current,
        lifecycle: 'error',
        detail: message
      }))
      return this.toStatus(state)
    }
  }

  private async stopInner(pluginId: string): Promise<GatewayStatus> {
    const instance = this.running.get(pluginId)
    if (instance) {
      this.setState(pluginId, { lifecycle: 'stopping' })
      const child = instance.child
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, STOP_GRACE_MS)
        child.once('exit', () => {
          clearTimeout(killTimer)
          resolve()
        })
        child.kill('SIGTERM')
      })
      this.running.delete(pluginId)
      this.journal?.unregister(child.pid ?? 0)
    }
    // The endpoint is dead either way: synced harness provider records must not
    // survive a stop, or harnesses keep offering models backed by a closed port.
    await removeGatewayProviders(this.providers, pluginId).catch((error) => {
      Logger.error('Gateway provider removal failed', {
        pluginId,
        error: error instanceof Error ? error.message : String(error)
      })
    })
    const state = await this.mutateState(pluginId, (current) => ({
      ...current,
      lifecycle: 'stopped',
      detail: undefined,
      boundPort: undefined
    }))
    return this.toStatus(state)
  }

  private async handleUnexpectedExit(pluginId: string, tail: string[]): Promise<void> {
    const store = await this.loadStore()
    const state = store.plugins[pluginId]
    if (!state || state.lifecycle === 'stopping' || state.lifecycle === 'stopped') return
    // The endpoint died with the process: synced harness provider records must
    // not survive a crash either, or harnesses keep offering dead models.
    await removeGatewayProviders(this.providers, pluginId).catch((error) => {
      Logger.error('Gateway provider removal failed after unexpected exit', {
        pluginId,
        error: error instanceof Error ? error.message : String(error)
      })
    })
    await this.mutateState(pluginId, (current) => ({
      ...current,
      lifecycle: 'error',
      detail: tail.length > 0 ? tail.join('\n') : 'Gateway process exited unexpectedly'
    }))
  }

  private async uninstallInner(pluginId: string): Promise<GatewayStatus> {
    this.requireAdapter(pluginId)
    await this.stopInner(pluginId)
    await removeGatewayProviders(this.providers, pluginId)
    if (this.vault) await this.vault.remove(dashboardPasswordRef(pluginId))
    const pluginDir = join(getConfigRoot(), 'gateways', pluginId)
    await rm(join(pluginDir, 'install'), { recursive: true, force: true })
    await rm(join(pluginDir, 'data'), { recursive: true, force: true })
    await rm(join(pluginDir, 'cache'), { recursive: true, force: true })
    await rm(join(pluginDir, 'catalog.json'), { force: true })
    this.catalogCache.delete(pluginId)
    return this.toStatus(
      await this.mutateState(pluginId, (current) => ({
        ...current,
        lifecycle: 'not_installed',
        detail: undefined,
        boundPort: undefined,
        installedVersion: undefined,
        lastReadyAt: undefined
      }))
    )
  }

  private async updateInner(pluginId: string): Promise<GatewayStatus> {
    const adapter = this.requireAdapter(pluginId)
    const wasRunning = this.running.has(pluginId)
    await this.stopInner(pluginId)
    const dir = this.installDir(pluginId)
    for (const entry of await readdir(dir).catch(() => [])) {
      if (entry.startsWith('.codeinoven-installed-')) {
        await rm(join(dir, entry), { force: true })
      }
    }
    await this.ensureInstalled(pluginId, adapter)
    if (wasRunning) return this.startInner(pluginId)
    return this.toStatus((await this.loadStore()).plugins[pluginId])
  }

  /**
   * Ensure a strong dashboard password exists in the vault. OmniRoute consumes
   * it via the INITIAL_PASSWORD env var (headless deploy: skips the onboarding
   * wizard and enables requireLogin).
   */
  private async ensureDashboardPassword(pluginId: string): Promise<string | undefined> {
    if (!this.vault) return undefined
    const ref = dashboardPasswordRef(pluginId)
    if (!(await this.vault.exists(ref))) {
      await this.vault.save(generatePassword(), ref)
    }
    try {
      return await this.vault.resolve(ref)
    } catch (error) {
      Logger.error('Gateway dashboard password unavailable', {
        pluginId,
        error: error instanceof Error ? error.message : String(error)
      })
      return undefined
    }
  }

  // ─── Installation ───────────────────────────────────────────────────────────

  private installDir(pluginId: string): string {
    return join(getConfigRoot(), 'gateways', pluginId, 'install')
  }

  private dataDir(pluginId: string): string {
    return join(getConfigRoot(), 'gateways', pluginId, 'data')
  }

  private runtimeCommand(adapter: GatewayAdapterDefinition, env: NodeJS.ProcessEnv): string {
    const command = adapter.runtime === 'bun' ? 'bun' : 'node'
    const resolved = resolveExecutablePath(command, env)
    if (!resolved) {
      throw new Error(`${command} was not found in the desktop process environment`)
    }
    return resolved
  }

  private async ensureInstalled(
    pluginId: string,
    adapter: GatewayAdapterDefinition
  ): Promise<string> {
    const dir = this.installDir(pluginId)
    const markerPath = join(dir, `.codeinoven-installed-${adapter.version}`)
    try {
      await access(markerPath)
      return dir
    } catch {
      // Not installed yet — fall through to the install path.
    }
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: `codeinoven-${pluginId}`, private: true }, null, 2)}\n`,
      'utf8'
    )
    let installTarget = `${adapter.npmPackage}@${adapter.version}`
    try {
      const tarballPath = await this.downloadPinnedTarball(pluginId, adapter)
      if (tarballPath) {
        // Installing from the already-downloaded file keeps the package
        // manager offline for the heavy part and makes retries cheap.
        installTarget = tarballPath
      }
    } catch (error) {
      this.setProgress(pluginId, undefined)
      Logger.error('Gateway tarball download failed; falling back to direct install', {
        pluginId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    this.setProgress(pluginId, { phase: 'installing' })
    const install = resolvePackageCommand('install', installTarget)
    await this.runCommand(install.command, install.args, dir, INSTALL_TIMEOUT_MS)
    this.setProgress(pluginId, undefined)
    await writeFile(markerPath, `${adapter.version}\n`, 'utf8')
    return dir
  }

  /**
   * Download the pinned version's tarball through the registry metadata so the
   * UI can show a true byte percentage, and verify its integrity digest before
   * handing it to the package manager. Returns null when the registry is
   * unreachable — callers then fall back to a direct `add pkg@version`.
   */
  private async downloadPinnedTarball(
    pluginId: string,
    adapter: GatewayAdapterDefinition
  ): Promise<string | null> {
    const metadata = await fetchPackageMetadata(adapter.npmPackage, adapter.version)
    if (!metadata) return null
    const cacheDir = join(getConfigRoot(), 'gateways', pluginId, 'cache')
    await mkdir(cacheDir, { recursive: true })
    const tarballPath = join(cacheDir, `${adapter.npmPackage}-${adapter.version}.tgz`)
    await downloadTarball(metadata, tarballPath, (downloadedBytes, totalBytes) => {
      this.setProgress(pluginId, {
        phase: 'downloading',
        ...(totalBytes > 0
          ? { percent: Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100)) }
          : {}),
        downloadedBytes,
        totalBytes,
        detail: `${adapter.name} ${adapter.version}`
      })
    })
    return tarballPath
  }

  /** Publish install progress to state listeners, throttled during streaming. */
  private setProgress(pluginId: string, progress: GatewayInstallProgress | undefined): void {
    if (progress === undefined) this.installProgress.delete(pluginId)
    else this.installProgress.set(pluginId, progress)

    const now = Date.now()
    const last = this.lastProgressEmit.get(pluginId) ?? 0
    const phaseChanged = progress?.phase !== this.lastProgressPhase.get(pluginId)
    if (!phaseChanged && progress !== undefined && now - last < PROGRESS_EMIT_INTERVAL_MS) return
    this.lastProgressEmit.set(pluginId, now)
    this.lastProgressPhase.set(pluginId, progress?.phase)
    void this.loadStore()
      .then((store) => {
        const state = store.plugins[pluginId]
        if (state) void this.emitStatus(state)
      })
      .catch((error) => {
        Logger.error('Gateway progress emit failed', {
          pluginId,
          error: error instanceof Error ? error.message : String(error)
        })
      })
  }

  /**
   * Gateway servers run on the system Node, not Bun: OmniRoute's SQLite
   * migrations fail under `bun:sqlite`, and Electron's embedded Node has a
   * different native-module ABI than the prebuilt better-sqlite3 shipped in
   * the package.
   */
  private async assertNodeRuntime(): Promise<void> {
    if (!this.nodeVersionPromise) {
      this.nodeVersionPromise = this.runCommand('node', ['--version'], getConfigRoot(), 15_000)
    }
    const version = await this.nodeVersionPromise
    const major = Number.parseInt(version.replace(/^v/u, ''), 10)
    if (!Number.isSafeInteger(major) || major < 22) {
      throw new Error(
        `The gateway requires Node.js 22 or newer on PATH (found ${version || 'none'})`
      )
    }
  }

  private runCommand(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const env = buildProcessEnvironment()
      const resolved = resolveExecutablePath(command, env)
      if (!resolved) {
        reject(new Error(`${command} was not found in the desktop process environment`))
        return
      }
      const child = spawn(resolved, args, {
        cwd,
        env,
        shell: commandRequiresShell(resolved),
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(stdout.trim())
        else
          reject(
            new Error(
              `${command} ${args.join(' ')} failed (${code ?? 'signal'}): ${stderr.slice(-2_000)}`
            )
          )
      })
    })
  }

  // ─── Networking ─────────────────────────────────────────────────────────────

  private async allocatePort(preferred: number): Promise<number> {
    const base = Number.isSafeInteger(preferred) && preferred > 0 ? preferred : 20_128
    for (let offset = 0; offset < PORT_PROBE_ATTEMPTS; offset += 1) {
      const candidate = base + offset
      if (candidate > 65_535) break
      if (await isLoopbackPortFree(candidate)) return candidate
    }
    throw new Error('No free loopback port is available for the gateway')
  }

  private async awaitHealthy(
    adapter: GatewayAdapterDefinition,
    port: number,
    child: ChildProcess
  ): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error('Gateway process exited before becoming healthy')
      }
      for (const healthPath of adapter.healthPaths) {
        if (await probeOk(`http://127.0.0.1:${port}${healthPath}`)) return
      }
      await sleep(HEALTH_POLL_INTERVAL_MS)
    }
    throw new Error(`Gateway did not become healthy within ${START_TIMEOUT_MS / 1_000}s`)
  }

  private async fetchCatalog(
    adapter: GatewayAdapterDefinition,
    port: number
  ): Promise<GatewayCatalogSnapshot> {
    const response = await fetch(`http://127.0.0.1:${port}${adapter.modelsPath}`)
    if (!response.ok) {
      throw new Error(`Model catalog request failed with status ${response.status}`)
    }
    const payload: unknown = await response.json()
    return { models: parseModelsPayload(payload), fetchedAt: Date.now() }
  }

  private async persistCatalog(pluginId: string, snapshot: GatewayCatalogSnapshot): Promise<void> {
    const store: CatalogStore = { version: 1, snapshot }
    await this.storage.write(`gateways/${pluginId}/catalog.json`, store)
  }

  private async cachedCatalog(pluginId: string): Promise<GatewayCatalogSnapshot | null> {
    const memory = this.catalogCache.get(pluginId)
    if (memory && Date.now() - memory.fetchedAt < CATALOG_TTL_MS) return memory
    const persisted = await this.storage.read<CatalogStore>(`gateways/${pluginId}/catalog.json`)
    if (!persisted?.snapshot) return null
    this.catalogCache.set(pluginId, persisted.snapshot)
    return persisted.snapshot
  }

  // ─── State ──────────────────────────────────────────────────────────────────

  private async loadStore(): Promise<GatewayStateStore> {
    const raw = await this.storage.read<GatewayStateStore>(STATE_PATH)
    if (raw?.plugins) return raw
    const seeded: GatewayStateStore = {
      version: STATE_VERSION,
      plugins: {
        [DEFAULT_GATEWAY_PLUGIN_ID]: {
          pluginId: DEFAULT_GATEWAY_PLUGIN_ID,
          adapterId: DEFAULT_GATEWAY_ADAPTER_ID,
          enabled: false,
          lifecycle: 'not_installed',
          preferredPort: 20_128,
          updatedAt: Date.now()
        }
      }
    }
    await this.storage.write(STATE_PATH, seeded)
    return seeded
  }

  private async mutateState(
    pluginId: string,
    patch: (current: GatewayPluginState) => GatewayPluginState
  ): Promise<GatewayPluginState> {
    const store = await this.loadStore()
    const current = store.plugins[pluginId]
    if (!current) throw new Error(`Unknown gateway plugin: ${pluginId}`)
    const next = patch(current)
    store.plugins[pluginId] = { ...next, updatedAt: Date.now() }
    await this.storage.write(STATE_PATH, store)
    void this.emitStatus(store.plugins[pluginId])
    return store.plugins[pluginId]
  }

  private setState(
    pluginId: string,
    patch: Partial<Pick<GatewayPluginState, 'lifecycle' | 'detail'>>
  ): void {
    void this.mutateState(pluginId, (current) => ({ ...current, ...patch })).catch((error) => {
      Logger.error('Gateway state update failed', {
        pluginId,
        error: error instanceof Error ? error.message : String(error)
      })
    })
  }

  private requireAdapter(pluginId: string): GatewayAdapterDefinition {
    const adapter = getGatewayAdapter(DEFAULT_GATEWAY_ADAPTER_ID)
    if (pluginId !== DEFAULT_GATEWAY_PLUGIN_ID || !adapter) {
      throw new Error(`Unknown gateway plugin: ${pluginId}`)
    }
    return adapter
  }

  private serialize<T>(pluginId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(pluginId) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    this.operations.set(
      pluginId,
      next.then(
        () => undefined,
        () => undefined
      )
    )
    return next
  }

  private async toStatus(state: GatewayPluginState): Promise<GatewayStatus> {
    const adapter = getGatewayAdapter(state.adapterId)
    const snapshot = await this.cachedCatalog(state.pluginId)
    const running = this.running.get(state.pluginId)
    const lifecycle = running ? state.lifecycle : normalizeStopped(state)
    const port = running?.port
    return {
      pluginId: state.pluginId,
      adapterId: state.adapterId,
      adapterName: adapter?.name ?? state.adapterId,
      enabled: state.enabled,
      lifecycle,
      ...(state.detail === undefined ? {} : { detail: state.detail }),
      ...(port === undefined ? {} : { port }),
      ...(port === undefined || lifecycle !== 'ready'
        ? {}
        : { dashboardUrl: `http://127.0.0.1:${port}${adapter?.dashboardPath ?? '/'}` }),
      ...(state.installedVersion === undefined ? {} : { installedVersion: state.installedVersion }),
      availableVersion: adapter?.version ?? '',
      modelCount: snapshot?.models.length ?? 0,
      syncedHarnessIds: [],
      ...(this.installProgress.get(state.pluginId) !== undefined
        ? { progress: this.installProgress.get(state.pluginId) }
        : lifecycle === 'installing' || lifecycle === 'starting'
          ? { progress: this.installProgress.get(state.pluginId) }
          : {})
    }
  }

  private async emitStatus(state: GatewayPluginState): Promise<void> {
    const status = await this.toStatus(state)
    for (const listener of this.listeners) {
      try {
        listener(status)
      } catch (error) {
        Logger.error('Gateway state listener failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
}

function normalizeStopped(state: GatewayPluginState): GatewayLifecycleState {
  if (state.lifecycle === 'starting' || state.lifecycle === 'ready') return 'stopped'
  return state.lifecycle
}

function dashboardPasswordRef(pluginId: string): string {
  return `gateway_${pluginId}_dashboard`
}

interface PackageTarballMetadata {
  tarballUrl: string
  /** Registry-reported tarball byte size; absent on some packages. */
  size?: number
  shasum: string
}

/**
 * Fetch registry metadata for one exact package version (tarball URL,
 * integrity digest, optional byte size). Returns null when the registry is
 * unreachable so callers can fall back to a direct package-manager install.
 */
export async function fetchPackageMetadata(
  npmPackage: string,
  version: string
): Promise<PackageTarballMetadata | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${npmPackage}/${version}`, {
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json' }
    })
    if (!response.ok) return null
    const payload: unknown = await response.json()
    if (typeof payload !== 'object' || payload === null) return null
    const dist = (payload as Record<string, unknown>)['dist']
    if (typeof dist !== 'object' || dist === null) return null
    const raw = dist as Record<string, unknown>
    const tarballUrl = raw['tarball']
    const size = raw['size']
    const shasum = raw['shasum']
    if (
      typeof tarballUrl !== 'string' ||
      !tarballUrl.startsWith('https://') ||
      typeof shasum !== 'string' ||
      !/^[a-f0-9]{40}$/u.test(shasum)
    ) {
      return null
    }
    const resolvedSize =
      typeof size === 'number' && size > 0 ? size : await probeTarballSize(tarballUrl)
    return {
      tarballUrl,
      shasum,
      ...(resolvedSize === undefined ? {} : { size: resolvedSize })
    }
  } catch {
    return null
  }
}

/**
 * The registry omits both dist.size and Content-Length for many packages, so
 * a 1-byte range request is used to learn the exact total for the progress
 * percentage. Returns undefined when the probe fails — progress then degrades
 * to indeterminate rather than showing a wrong percentage.
 */
async function probeTarballSize(tarballUrl: string): Promise<number | undefined> {
  try {
    const response = await fetch(tarballUrl, {
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(15_000)
    })
    const contentRange = response.headers.get('content-range')
    if (response.status !== 206 || !contentRange) return undefined
    const total = Number(contentRange.split('/')[1])
    return Number.isSafeInteger(total) && total > 0 ? total : undefined
  } catch {
    return undefined
  }
}

/**
 * Stream the tarball to disk, reporting true byte progress from the response
 * length, and verify the registry's sha1 digest before resolving. The partial
 * file is removed on any failure.
 */
export async function downloadTarball(
  metadata: PackageTarballMetadata,
  destination: string,
  onProgress: (downloadedBytes: number, totalBytes: number) => void
): Promise<void> {
  const response = await fetch(metadata.tarballUrl, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  })
  if (!response.ok || !response.body) {
    throw new Error(`Tarball download failed with status ${response.status}`)
  }
  const contentLength = Number(response.headers.get('content-length'))
  const totalBytes =
    contentLength > 0 ? contentLength : (metadata.size ?? 0)
  const hash = createHash('sha1')
  const handle = await open(destination, 'w')
  let downloadedBytes = 0
  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      await handle.write(value)
      hash.update(value)
      downloadedBytes += value.byteLength
      onProgress(downloadedBytes, totalBytes)
    }
    const digest = hash.digest('hex')
    if (digest !== metadata.shasum) {
      throw new Error('Tarball integrity check failed (sha1 mismatch)')
    }
  } catch (error) {
    await rm(destination, { force: true })
    throw error
  } finally {
    await handle.close()
  }
}

/** Live gateway server commands carry the package name (see journal entries). */
const GATEWAY_PROCESS_PATTERN = /node_modules[/\\]omniroute|codeinoven-gateway/u

interface ProcessSnapshot {
  processes: Map<number, { parentPid: number; command: string }>
}

const execFileAsync = promisify(execFile)

/**
 * Run a read-only inspection binary through the app's process-resolution
 * boundary (App-Bible rule for every PATH-based main-process command).
 * Returns null when the binary is unavailable or fails — callers must treat
 * that as "cannot verify" and never guess.
 */
async function runInspectionCommand(command: string, args: string[]): Promise<string | null> {
  const resolved = resolveExecutablePath(command)
  if (!resolved) return null
  try {
    const { stdout } = await execFileAsync(resolved, args, { env: buildProcessEnvironment() })
    return stdout
  } catch {
    return null
  }
}

/**
 * Unix process snapshot for orphan verification. Returns null on platforms or
 * failures where a reliable parentage view is unavailable, disabling recovery
 * rather than risking a recycled-PID kill.
 */
async function processSnapshot(): Promise<ProcessSnapshot | null> {
  if (process.platform === 'win32') return null
  const stdout = await runInspectionCommand('ps', ['-axo', 'pid=,ppid=,command='])
  if (stdout === null) {
    Logger.error('Gateway process snapshot failed', { reason: 'ps unavailable or failed' })
    return null
  }
  const processes = new Map<number, { parentPid: number; command: string }>()
  for (const line of stdout.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u)
    if (!match) continue
    processes.set(Number(match[1]), {
      parentPid: Number(match[2]),
      command: match[3]?.trim() || ''
    })
  }
  return { processes }
}

/**
 * Resolve the working directory of a live PID via lsof. Returns null when it
 * cannot be determined — callers must skip rather than kill on uncertainty.
 */
async function processWorkingDirectory(pid: number): Promise<string | null> {
  const stdout = await runInspectionCommand('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
  if (stdout === null) return null
  for (const line of stdout.split(/\r?\n/u)) {
    // lsof -Fn prints the path on an `n` record: `n/path/to/cwd`.
    if (line.startsWith('n/')) return line.slice(1)
  }
  return null
}

async function sameDirectory(left: string, right: string): Promise<boolean> {
  if (left === right) return true
  const [resolvedLeft, resolvedRight] = await Promise.all(
    [left, right].map((candidate) => realpath(candidate).catch(() => candidate))
  )
  return resolvedLeft === resolvedRight
}

async function killProcessTree(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  await sleep(STOP_GRACE_MS)
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

function generatePassword(): string {
  return randomBytes(DASHBOARD_PASSWORD_BYTES).toString('base64url')
}

function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

async function probeOk(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
    return response.ok
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function attachStderrTail(child: ChildProcess): () => string[] {
  const lines: string[] = []
  child.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue
      lines.push(line)
      if (lines.length > STDERR_TAIL_LINES) lines.shift()
    }
  })
  return () => [...lines]
}

function parseModelsPayload(payload: unknown): GatewayModelInfo[] {
  if (typeof payload !== 'object' || payload === null) return []
  const data = (payload as Record<string, unknown>)['data']
  if (!Array.isArray(data)) return []
  const models: GatewayModelInfo[] = []
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue
    const raw = entry as Record<string, unknown>
    const id = raw['id']
    if (typeof id !== 'string' || id.length === 0 || id.length > 256) continue
    const contextWindow = optionalPositiveInteger(raw['context_length'] ?? raw['contextWindow'])
    const maxOutputTokens = optionalPositiveInteger(
      raw['max_output_tokens'] ?? raw['maxOutputTokens']
    )
    const capabilities =
      typeof raw['capabilities'] === 'object' && raw['capabilities'] !== null
        ? (raw['capabilities'] as Record<string, unknown>)
        : {}
    models.push({
      id,
      name: id,
      reasoning: capabilities['reasoning'] === true,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens })
    })
  }
  return models
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return undefined
  return value
}
