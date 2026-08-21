import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  GatewayAdapterDefinition,
  GatewayCatalogSnapshot,
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
import { getGatewayAdapter, DEFAULT_GATEWAY_ADAPTER_ID, DEFAULT_GATEWAY_PLUGIN_ID } from './gateway-adapters'
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
 * installation via Bun, supervised launch on a loopback port, health gating,
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
  private bunVersionPromise: Promise<string> | null = null
  private nodeVersionPromise: Promise<string> | null = null

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
    return Promise.all(
      Object.values(store.plugins).map((state) => this.toStatus(state))
    )
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

  // ─── Lifecycle internals ────────────────────────────────────────────────────

  private async startInner(pluginId: string): Promise<GatewayStatus> {
    const adapter = this.requireAdapter(pluginId)
    if (this.running.has(pluginId)) {
      const state = (await this.loadStore()).plugins[pluginId]
      return this.toStatus(state)
    }
    try {
      this.setState(pluginId, { lifecycle: 'starting', detail: undefined })
      const installDir = await this.ensureInstalled(pluginId, adapter)
      const preferred = (await this.loadStore()).plugins[pluginId]?.preferredPort ?? 0
      const port = await this.allocatePort(preferred)
      const binPath = join(installDir, 'node_modules', adapter.npmPackage, adapter.binPath)
      await access(binPath)
      if (adapter.runtime === 'node') await this.assertNodeRuntime()
      const dashboardPassword = await this.ensureDashboardPassword(pluginId)

      const child = spawn(this.runtimeCommand(adapter), [binPath, ...adapter.serveArgs], {
        cwd: installDir,
        env: {
          ...process.env,
          ...(adapter.env ?? {}),
          PORT: String(port),
          DATA_DIR: this.dataDir(pluginId),
          ...(dashboardPassword === undefined ? {} : { INITIAL_PASSWORD: dashboardPassword })
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const stderrTail = attachStderrTail(child)

      this.journal?.register(child.pid ?? 0, `node ${adapter.npmPackage} (PORT=${port})`, installDir)
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
    if (!instance) {
      const state = (await this.loadStore()).plugins[pluginId]
      if (!state) throw new Error(`Unknown gateway plugin: ${pluginId}`)
      return this.toStatus({ ...state, lifecycle: 'stopped' })
    }
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
    const state = await this.mutateState(pluginId, (current) => ({
      ...current,
      lifecycle: 'stopped',
      boundPort: undefined
    }))
    return this.toStatus(state)
  }

  private async handleUnexpectedExit(pluginId: string, tail: string[]): Promise<void> {
    const store = await this.loadStore()
    const state = store.plugins[pluginId]
    if (!state || state.lifecycle === 'stopping' || state.lifecycle === 'stopped') return
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
    const pluginDir = join(getConfigRoot(), 'gateways', pluginId)
    await rm(join(pluginDir, 'install'), { recursive: true, force: true })
    await rm(join(pluginDir, 'data'), { recursive: true, force: true })
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

  private runtimeCommand(adapter: GatewayAdapterDefinition): string {
    if (adapter.runtime === 'bun') return 'bun'
    return 'node'
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
    await this.assertBunAvailable()
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: `codeinoven-${pluginId}`, private: true }, null, 2)}\n`,
      'utf8'
    )
    await this.runCommand(
      'bun',
      ['add', `${adapter.npmPackage}@${adapter.version}`],
      dir,
      INSTALL_TIMEOUT_MS
    )
    await writeFile(markerPath, `${adapter.version}\n`, 'utf8')
    return dir
  }

  private async assertBunAvailable(): Promise<string> {
    if (!this.bunVersionPromise) {
      this.bunVersionPromise = this.runCommand('bun', ['--version'], getConfigRoot(), 15_000)
    }
    return this.bunVersionPromise
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
      const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
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
        else reject(new Error(`${command} ${args.join(' ')} failed (${code ?? 'signal'}): ${stderr.slice(-2_000)}`))
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
    const port =
      state.lifecycle === 'ready' ? state.boundPort : this.running.get(state.pluginId)?.port
    return {
      pluginId: state.pluginId,
      adapterId: state.adapterId,
      adapterName: adapter?.name ?? state.adapterId,
      enabled: state.enabled,
      lifecycle: this.running.has(state.pluginId) ? state.lifecycle : normalizeStopped(state),
      ...(state.detail === undefined ? {} : { detail: state.detail }),
      ...(port === undefined ? {} : { port }),
      ...(port === undefined
        ? {}
        : { dashboardUrl: `http://127.0.0.1:${port}${adapter?.dashboardPath ?? '/'}` }),
      ...(state.installedVersion === undefined ? {} : { installedVersion: state.installedVersion }),
      availableVersion: adapter?.version ?? '',
      modelCount: snapshot?.models.length ?? 0,
      syncedHarnessIds: []
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
