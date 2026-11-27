import { mapInBatches } from '../../../lib/bounded-work'
import { Logger } from '../../system/logger'
import {
  createOpenCodeHarnessDriver,
  isOpenCodeV2Installed
} from '../../drivers/opencode-harness-driver'
import { findHarness } from '../../agents/harness-registry'
import { buildProcessEnvironmentAsync } from '../../drivers/cli-environment'
import { isHarnessAvailableAsync } from '../../drivers/harness-runtime'
import { validateEntityId } from '../../ipc/ipc-validation'
import type { HarnessDriver } from '../../drivers/driver.interface'
import { isCodeInOvenCustomProviderId } from '../../../lib/custom-provider-id'
import { refreshCustomProviderModels } from '../../providers/base-url-model-refresh'
import type {
  AgentAccountUsage,
  AgentAccountUsageOverrides,
  ProviderCatalog,
  ProviderCatalogRefreshOptions
} from '../../../lib/types'
import { INBOX_PROJECT_ID } from '../../../lib/types'
import { CHATS_CWD_DIR } from '../../../lib/project-artifacts'
import { PROVIDER_CATALOG_TTL_MS } from './chat-engine-constants'
import { filterInstalledProviderCatalogs } from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'
import {
  currentAcpAgents,
  ensureAcpAgentsLoaded,
  isAcpAgentId
} from '../../drivers/acp/acp-agents-store'

/** ChatEngine providers-catalog: one concern, moved verbatim from the composition root. */
export class ChatEngineProvidersCatalog {
  /** Signature of the agent record each ACP driver was built from. */
  private readonly acpDriverSignatures = new Map<string, string>()

  constructor(private readonly host: ChatEngine) {}

  /**
   * Rebuild the ACP drivers from the agents the user saved.
   *
   * Adding, editing or removing an ACP agent changes which harnesses exist, and
   * those drivers are not in the harness registry's factory table: they are
   * created here, per record, so the model picker and the next turn see exactly
   * what the Harnesses page shows.
   */
  async refreshAcpHarnesses(): Promise<void> {
    await ensureAcpAgentsLoaded()
    const agents = currentAcpAgents().filter((agent) => agent.enabled !== false)
    const wanted = new Set(agents.map((agent) => agent.id))
    for (const [id, driver] of [...this.host.drivers]) {
      if (!isAcpAgentId(id) || wanted.has(id)) continue
      driver.dispose()
      this.host.drivers.delete(id)
      this.acpDriverSignatures.delete(id)
    }
    const create = this.host.state.acpDriverFactory
    if (!create) return
    for (const agent of agents) {
      const signature = `${agent.name}|${agent.command}|${agent.args.join(' ')}`
      const existing = this.host.drivers.get(agent.id)
      if (existing && this.acpDriverSignatures.get(agent.id) === signature) continue
      if (existing) {
        // Keep a running turn alive: its driver is swapped on the next refresh.
        if (
          existing.hasActiveTurn &&
          this.host.units['providers-harness'].harnessHasActiveTurn(agent.id)
        ) {
          continue
        }
        existing.dispose()
      }
      const driver = create(agent)
      driver.setProcessObserver?.(this.host.state.agentProcesses)
      driver.onEvent((event) => this.host.handleDriverEvent(driver.id, event, driver))
      this.host.drivers.set(agent.id, driver)
      this.acpDriverSignatures.set(agent.id, signature)
    }
    await this.invalidateProviderCatalogs()
  }

  /**
   * Replace one ACP agent's live process so the next probe reads fresh state.
   *
   * An agent caches its signed-in state per process: Cursor reports
   * `isAuthenticated` from the moment it started, so a sign-in performed by the
   * app's auth probe leaves every agent process started before it still refusing
   * `session/new`. That is why the model picker kept asking for a sign-in while
   * `cursor-agent update` (and a fresh probe) already worked. Disposing the
   * driver drops that process, and the refresh below builds a new one that
   * reads the credentials the sign-in just stored.
   */
  async restartAcpAgent(harnessId: string): Promise<void> {
    if (!isAcpAgentId(harnessId)) return
    const driver = this.host.drivers.get(harnessId)
    if (!driver) return
    // A turn in flight is using this process; its next turn re-reads auth anyway.
    if (
      driver.hasActiveTurn &&
      this.host.units['providers-harness'].harnessHasActiveTurn(harnessId)
    ) {
      return
    }
    driver.dispose()
    this.host.drivers.delete(harnessId)
    this.acpDriverSignatures.delete(harnessId)
    await this.refreshAcpHarnesses()
  }

  // ─── Public API (IPC surface) ─────────────────────────────────────────────

  /**
   * List harness providers and their models for a project.
   *
   * This must never block the model picker on a slow harness (a CLI spawn or
   * Cline's remote network catalog). Each driver gets a bounded time budget:
   * whatever resolves within it is merged and returned immediately; drivers
   * that exceed it are re-merged in the background and pushed to open pickers
   * via `providerCatalog.updated`.
   */
  async listProviders(projectId: string, force = false): Promise<ProviderCatalog[]> {
    projectId = validateEntityId(projectId, 'Project ID')
    // An explicit provider refresh can change which models/drivers expose tools.
    if (force) this.host.state.toolCatalogCache.clear()
    const stale = force || (await this.providerCatalogInputsChanged())
    if (
      !stale &&
      this.host.state.sharedProviderCatalog &&
      Date.now() - this.host.state.sharedProviderCatalog.discoveredAt < PROVIDER_CATALOG_TTL_MS
    ) {
      const catalogs = await filterInstalledProviderCatalogs(
        this.host.state.sharedProviderCatalog.catalogs
      )
      this.host.state.providerCache.set(projectId, catalogs)
      return catalogs
    }
    if (!stale) {
      // Cold start: reuse the persisted snapshot so the model picker is
      // populated immediately without contacting any harness.
      const persisted = await this.host.units['providers-accounts'].loadPersistedProviders()
      if (persisted) {
        this.host.state.providerCache.set(projectId, persisted)
        return persisted
      }
    }
    if (this.host.state.providerDiscovery) return this.host.state.providerDiscovery
    const discovery = this.host.units['providers-accounts'].discoverProviders(projectId)
    this.host.state.providerDiscovery = discovery
    try {
      return await discovery
    } finally {
      if (this.host.state.providerDiscovery === discovery) this.host.state.providerDiscovery = null
    }
  }

  /**
   * Compute every implementing driver's provider-catalog input fingerprint and
   * compare it with the last recorded one. Returns (and records) whether any
   * driver's inputs drifted   e.g. the user connected or disconnected a Pi
   * provider, so cached catalogs no longer match reality. The first observation
   * only records the baseline.
   */
  async providerCatalogInputsChanged(): Promise<boolean> {
    const current = await this.readProviderCatalogFingerprints()
    if (current === null) return false
    let changed = false
    for (const [driverId, fingerprint] of Object.entries(current)) {
      const previous = this.host.state.catalogFingerprints.get(driverId)
      if (previous !== undefined && previous !== fingerprint) changed = true
      this.host.state.catalogFingerprints.set(driverId, fingerprint)
    }
    return changed
  }

  /** Fresh fingerprints from every driver that implements the capability. */
  async readProviderCatalogFingerprints(): Promise<Record<string, string> | null> {
    const capable = [...this.host.drivers.values()].filter(
      (driver) => driver.providerCatalogFingerprint !== undefined
    )
    if (capable.length === 0) return null
    const entries = await Promise.all(
      capable.map(async (driver): Promise<[string, string] | null> => {
        try {
          const fingerprint = await driver.providerCatalogFingerprint?.()
          return fingerprint === null || fingerprint === undefined
            ? null
            : ([driver.id, fingerprint] as const)
        } catch {
          // Cannot determine   treat as unchanged rather than forcing a refresh.
          return null
        }
      })
    )
    const record: Record<string, string> = {}
    for (const entry of entries) {
      if (entry) record[entry[0]] = entry[1]
    }
    return Object.keys(record).length > 0 ? record : null
  }

  /** Re-record driver fingerprints after a discovery pass so drift baselines stay current. */
  async recordCatalogFingerprints(): Promise<void> {
    const current = await this.readProviderCatalogFingerprints()
    if (!current) return
    for (const [driverId, fingerprint] of Object.entries(current)) {
      this.host.state.catalogFingerprints.set(driverId, fingerprint)
    }
  }

  /** Last recorded fingerprints, persisted alongside the catalog snapshot. */
  persistedCatalogFingerprints(): Record<string, string> | undefined {
    return this.host.state.catalogFingerprints.size > 0
      ? Object.fromEntries(this.host.state.catalogFingerprints)
      : undefined
  }

  /**
   * A harness probe reported a changed install state (status/version), or a
   * provider was added to, hidden from or removed from a harness. Both change
   * which providers and models a harness offers, so the cached catalog is no
   * longer true and discovery runs again right here instead of being deferred
   * to whichever surface reads the catalog next.
   */
  async invalidateProviderCatalogs(): Promise<void> {
    if (this.host.state.catalogInvalidationInFlight)
      return this.host.state.catalogInvalidationInFlight
    const run = this.rebroadcastUpdatedCatalogs().finally(() => {
      if (this.host.state.catalogInvalidationInFlight === run)
        this.host.state.catalogInvalidationInFlight = null
    })
    this.host.state.catalogInvalidationInFlight = run
    return run
  }

  /**
   * Rebuild the single `opencode` driver when the detected install crossed the
   * V1/V2 line while the app was running (for example right after the user ran
   * the harness's own updater). A swap mid-turn would route the in-flight turn's
   * events to the new driver, so it is deferred until the harness is idle. A
   * deferred swap is remembered and retried on the next idle signal or the next
   * driver acquisition, so it always converges instead of being dropped.
   */
  refreshOpenCodeHarness(): void {
    if (!this.host.drivers.has('opencode')) return
    const desiredV2 = isOpenCodeV2Installed()
    if (desiredV2 === this.host.state.openCodeDriverIsV2) {
      this.host.state.openCodeHarnessSwapPending = false
      return
    }
    // A swap mid-turn would route the in-flight turn's events to the new
    // driver, so it waits. It is not dropped: mark it pending so the next idle
    // signal or the next driver acquisition retries it and the transport
    // converges once the harness goes quiet.
    if (this.host.units['providers-harness'].harnessHasActiveTurn('opencode')) {
      this.host.state.openCodeHarnessSwapPending = true
      return
    }
    this.host.state.openCodeHarnessSwapPending = false
    const driver = createOpenCodeHarnessDriver(
      this.host.state.baseUrlProviders,
      this.host.state.secretVault
    )
    driver.setProcessObserver?.(this.host.state.agentProcesses)
    driver.onEvent((event) => this.host.handleDriverEvent(driver.id, event, driver))
    this.host.drivers.set('opencode', driver)
    // Account-scoped drivers cache the transport they were built with, so a
    // managed account would keep speaking the old API until restart. Drop them
    // and let the next use rebuild against the detected line.
    for (const [accountId, accountDriver] of [...this.host.state.accountDrivers]) {
      if (accountDriver.id !== 'opencode') continue
      accountDriver.dispose()
      this.host.state.accountDrivers.delete(accountId)
    }
    this.host.state.openCodeDriverIsV2 = desiredV2
  }

  /**
   * Fetch the current account quota on demand. Account usage is
   * PROVIDER-level account state   it has nothing to do with any thread or
   * conversation context   so one channel answers for every surface (project
   * threads, inbox chats, temporary chats, the new-chat composer) and every
   * surface reads the same cache. The caller names the harness/provider the
   * UI is currently showing; the shared telemetry chain does the rest.
   */
  async refreshAccountUsage(overrides?: AgentAccountUsageOverrides): Promise<AgentAccountUsage[]> {
    const harnessId = overrides?.harnessId
    if (!harnessId) return []
    const providerId = overrides?.providerId ?? harnessId
    const account = await this.host.state.accountRegistry.resolveForProvider(
      harnessId,
      providerId,
      overrides?.accountId
    )
    const accountEnvironment = this.host.state.accountRegistry.environment(account)
    // This machine answers first, always. Only a harness the registry knows as
    // a CLI and this machine does not have sends the question to the Oven,
    // where the same account's harness can answer it. A reading the local
    // harness reports as empty stays empty: being signed out here is not a
    // reason to ask a different machine, and a harness this app does not know
    // as a CLI (an ACP agent) has no Oven counterpart to ask. The install
    // check resolves a command on this machine's PATH, so the account's own
    // HOME-style overrides are layered onto the process environment rather
    // than replacing it.
    const localEnvironment = {
      ...(await buildProcessEnvironmentAsync()),
      ...accountEnvironment
    }
    const descriptor = findHarness(harnessId)
    const installedHere =
      descriptor === undefined ||
      (await isHarnessAvailableAsync(harnessId, descriptor.command, localEnvironment))
    if (!installedHere) {
      const remote = await this.host.state.ovenChat.readAccountUsage({
        ...(overrides?.ovenId ? { ovenId: overrides.ovenId } : {}),
        harnessId,
        providerId,
        accountId: account.id
      })
      return remote ? [remote] : []
    }
    const conversationSessionId = await this.conversationSessionId(overrides)
    const driver = await this.host.driverForAccount(harnessId, account.id).catch(() => undefined)
    if (!driver) {
      Logger.dev(`On-demand account usage refresh: unknown harness "${harnessId}"`)
      return []
    }
    // Quota reads never depend on where a conversation lives. Read against the
    // shared chats working directory so every surface gets the same answer.
    let projectPath: string
    try {
      projectPath = await this.host.units['turns'].resolveProjectPath(INBOX_PROJECT_ID)
    } catch {
      await this.host.storage.ensureDirectory(CHATS_CWD_DIR)
      projectPath = this.host.storage.resolve(CHATS_CWD_DIR)
    }
    const entry = await this.host.units['providers-accounts'].readHarnessAccountUsage({
      harnessId,
      providerId,
      // A custom base-URL provider has no authenticated account row: the
      // registry hands back the harness's virtual legacy account for every
      // provider, so several custom providers in one harness would share one
      // id and clobber each other's cached quota. Key the read by the provider
      // id instead, which the battery hover and the Accounts rows both match.
      accountId: isCodeInOvenCustomProviderId(providerId) ? providerId : account.id,
      accountEnvironment,
      driver,
      projectPath,
      // The thread the hover belongs to, so a driver can state THAT thread's
      // occupancy from its own session. Without it the read would answer for
      // whichever session it reached, which is how a hover on an empty thread
      // once showed another conversation's 17%.
      ...(conversationSessionId ? { conversationSessionId } : {})
    })
    return entry ? [entry] : []
  }

  /**
   * The harness session bound to the thread asking for usage, when that session
   * belongs to the requested harness. A session never moves across harnesses,
   * so a stamp that names another harness means there is no session to read.
   */
  private async conversationSessionId(
    overrides: AgentAccountUsageOverrides | undefined
  ): Promise<string | undefined> {
    const { projectId, threadId, harnessId } = overrides ?? {}
    if (!projectId || !threadId || !harnessId) return undefined
    try {
      const thread = await this.host.threadManager.getThread(projectId, threadId)
      if (!thread?.sessionId) return undefined
      const owner = thread.sessionHarnessId ?? thread.settings?.harnessId
      return owner === harnessId ? thread.sessionId : undefined
    } catch {
      return undefined
    }
  }

  /**
   * The drivers that take part in app-wide provider discovery: every installed
   * default driver, plus one driver per managed account container. Discovery
   * and the explicit model-catalog refresh must cover the same set, so both
   * read it from here instead of keeping their own copy of the rule.
   */
  async catalogDrivers(): Promise<HarnessDriver[]> {
    const harnessEnv = await buildProcessEnvironmentAsync()
    const defaultDrivers: HarnessDriver[] = []
    for (const driver of this.host.drivers.values()) {
      const command = findHarness(driver.id)?.command
      if (await isHarnessAvailableAsync(driver.id, command, harnessEnv)) defaultDrivers.push(driver)
    }

    const managedAccounts = (await this.host.state.accountRegistry.list()).filter(
      (account) =>
        account.containerKind === 'managed' &&
        defaultDrivers.some((driver) => driver.id === account.harnessId) &&
        ['pi', 'opencode', 'codex', 'claude-code'].includes(account.harnessId)
    )
    const managedDrivers = await mapInBatches(managedAccounts, 2, (account) =>
      this.host.driverForAccount(account.harnessId, account.id)
    )
    return [...defaultDrivers, ...managedDrivers]
  }

  /**
   * Force every harness that keeps its own model catalog to re-fetch it from
   * upstream before the next discovery. Only an explicit user-triggered
   * refresh pays for this   it is a network round trip per provider   so the
   * TTL sweeps, retries and picker opens never call it.
   */
  async refreshHarnessModelCatalogs(): Promise<void> {
    let drivers: HarnessDriver[]
    try {
      drivers = (await this.catalogDrivers()).filter(
        (driver) => driver.refreshModelCatalog !== undefined
      )
    } catch (error) {
      Logger.info('Harness model catalog refresh skipped', {
        error: error instanceof Error ? error.message : String(error)
      })
      return
    }
    await Promise.allSettled(
      drivers.map(async (driver) => {
        try {
          await driver.refreshModelCatalog?.()
        } catch (error) {
          // A failed upstream pass leaves the harness's stored catalog in
          // place, so discovery still returns the best list available.
          Logger.info('Harness model catalog refresh failed', {
            driverId: driver.id,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      })
    )
  }

  /**
   * Discover a project's provider catalogs, optionally forcing every upstream
   * model list to be fetched again first.
   *
   * Shared by the model picker's refresh channel and by an orchestration
   * dispatch that named a model the current snapshot does not carry: a launch
   * before the first discovery reports every id as unknown, and discovery is the
   * actual fix, not a different id.
   */
  async refreshProviderCatalog(
    projectId: string,
    options: ProviderCatalogRefreshOptions = {}
  ): Promise<ProviderCatalog[]> {
    const force = options.force ?? true
    if (force) {
      // A forced picker refresh also re-probes every custom provider's model
      // endpoint so newly added/removed upstream models reach the catalog.
      // An explicit user refresh additionally forces each harness to
      // re-fetch its own model catalog from upstream first; the two are
      // independent network passes, so they run together.
      await Promise.all([
        refreshCustomProviderModels(
          this.host.state.baseUrlProviders,
          this.host.state.secretVault
        ).catch(() => {
          // Per-provider failures already preserve their old model lists.
        }),
        options.refreshModelCatalogs === true
          ? this.refreshHarnessModelCatalogs()
          : Promise.resolve()
      ])
    }
    return this.host.listProviders(projectId, force)
  }

  /**
   * Return the last persisted catalog snapshot for a project   or an empty list
   * when none exists   without contacting any harness or spawning a server.
   * Startup warm-up uses this to populate the model picker instantly for every
   * project while provisioning an `opencode serve` process only for the project
   * the user actually had open when the app closed.
   */
  async listProviderSnapshot(projectId: string): Promise<ProviderCatalog[]> {
    projectId = validateEntityId(projectId, 'Project ID')
    if (
      this.host.state.sharedProviderCatalog &&
      Date.now() - this.host.state.sharedProviderCatalog.discoveredAt < PROVIDER_CATALOG_TTL_MS
    ) {
      const catalogs = await filterInstalledProviderCatalogs(
        this.host.state.sharedProviderCatalog.catalogs
      )
      this.host.state.providerCache.set(projectId, catalogs)
      return catalogs
    }
    const persisted = await this.host.units['providers-accounts'].loadPersistedProviders()
    if (persisted) this.host.state.providerCache.set(projectId, persisted)
    return persisted ?? []
  }

  /**
   * A driver enriched its catalog in the background (e.g. Cline fetched its
   * remote list). Re-merge every project that already has a cached catalog and
   * broadcast the update so open model pickers refresh without being reopened.
   */
  async rebroadcastUpdatedCatalogs(): Promise<void> {
    // The shared snapshot is dropped even when no project has a cached catalog:
    // it is a cache of a set that just changed, and the next reader must not be
    // served the providers that no longer (or do not yet) exist.
    this.host.state.sharedProviderCatalog = null
    const projectIds = [...this.host.state.providerCache.keys()]
    if (projectIds.length === 0) return
    let catalogs: ProviderCatalog[]
    try {
      catalogs = await this.host.listProviders(projectIds[0] as string, true)
    } catch (error) {
      Logger.info('Provider catalog refresh after harness update skipped', {
        error: error instanceof Error ? error.message : String(error)
      })
      return
    }
    for (const projectId of projectIds) {
      this.host.state.providerCache.set(projectId, catalogs)
      this.host.broadcast({
        type: 'providerCatalog.updated',
        projectId,
        catalogs
      })
    }
    // The harness catalog changed on disk (e.g. after an install); tools may differ.
    this.host.state.toolCatalogCache.clear()
  }
}
