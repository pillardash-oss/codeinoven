import { Logger } from '../../system/logger'
import { createOpenCodeHarnessDriver } from '../../drivers/opencode-harness-driver'
import { ClaudeCodeDriver } from '../../drivers/claude-code-driver'
import { CodexDriver } from '../../drivers/codex-driver'
import { AntigravityDriver } from '../../drivers/antigravity-driver'
import { PiDriver } from '../../drivers/pi-driver'
import { validateEntityId } from '../../ipc/ipc-validation'
import type { HarnessDriver } from '../../drivers/driver.interface'
import type { AuthoredWorkKind } from '../../../lib/ipc/design'
import { isCodeInOvenCustomProviderId, underlyingProviderId } from '../../../lib/custom-provider-id'
import { legacyHarnessAccountId } from '../../providers/harness-account-registry'
import type {
  AgentAccountUsage,
  AgentProviderIssue,
  CustomProviderUsage,
  ProviderCatalog
} from '../../../lib/types'
import { INBOX_PROJECT_ID } from '../../../lib/types'
import { openUsageProviderCandidates } from '../../usage/openusage-client'
import {
  classifyProviderIssue,
  isUsageResetWaitIssue,
  presentProviderError
} from '../../../lib/provider-issue'
import type { PersistedProviderCatalog } from './chat-engine-types'
import { mergeProviderCatalogs } from './chat-engine-message-merge'
import type { DriverDiscovery } from './chat-engine-message-merge'
import { PROVIDER_CATALOG_TTL_MS } from './chat-engine-constants'
import { filterInstalledProviderCatalogs, providerCatalogPath } from './chat-engine-pure'
import { ChatEngine } from '../chat-engine'

/** ChatEngine providers-accounts: one concern, moved verbatim from the composition root. */
export class ChatEngineProvidersAccounts {
  constructor(private readonly host: ChatEngine) {}

  createAccountDriver(harnessId: string, environment: NodeJS.ProcessEnv): HarnessDriver {
    switch (harnessId) {
      case 'opencode':
        return createOpenCodeHarnessDriver(
          this.host.state.baseUrlProviders,
          this.host.state.secretVault,
          environment
        )
      case 'codex':
        return new CodexDriver(
          this.host.storage,
          this.host.state.baseUrlProviders,
          this.host.state.secretVault,
          environment
        )
      case 'claude-code':
        return new ClaudeCodeDriver(
          this.host.storage,
          this.host.state.baseUrlProviders,
          this.host.state.secretVault,
          environment
        )
      case 'pi':
        return new PiDriver(
          this.host.storage,
          this.host.state.baseUrlProviders,
          this.host.state.secretVault,
          environment
        )
      case 'antigravity':
        return new AntigravityDriver(this.host.storage, environment)
      default:
        throw new Error(`${harnessId} does not support isolated account containers.`)
    }
  }

  async driverForAccount(harnessId: string, accountId?: string): Promise<HarnessDriver> {
    // The install probe decides which OpenCode transport a driver speaks, and
    // the post-paint boot deliberately starts it without awaiting so
    // `features:ready` is not held on the child processes. The driver map is
    // therefore built against whatever install is cached at that instant (empty
    // on a session's first launch, which selects V1). A turn that acquires an
    // OpenCode driver joins the same single-flight probe here and swaps the map
    // before it is handed out, so a V2-only install is never given V1 session
    // operations.
    if (harnessId === 'opencode') await this.host.units['turns'].resolveOpenCodeTransport()
    // Thread-bound ids can outlive their account: the account may be removed
    // while the thread keeps a persisted session binding (for example across
    // an app restart, when no live session-registry entry matches). Fall back
    // to the harness default account instead of failing every read; explicit
    // user-selection validation calls accountRegistry.resolve directly and
    // still reports a missing account loudly.
    const account = await this.host.state.accountRegistry
      .resolve(harnessId, accountId)
      .catch((error: unknown) =>
        accountId === undefined
          ? Promise.reject(error)
          : this.host.state.accountRegistry.resolve(harnessId)
      )
    if (account.containerKind === 'legacy-default') {
      const driver = this.host.drivers.get(harnessId)
      if (!driver) throw new Error(`Harness driver "${harnessId}" is not available.`)
      return driver
    }
    const existing = this.host.state.accountDrivers.get(account.id)
    if (existing) return existing
    const driver = this.createAccountDriver(
      harnessId,
      this.host.state.accountRegistry.environment(account)
    )
    driver.setProcessObserver?.(this.host.state.agentProcesses)
    driver.onEvent((event) => this.host.handleDriverEvent(driver.id, event, driver))
    this.host.state.accountDrivers.set(account.id, driver)
    return driver
  }

  async removeHarnessAccount(accountId: string): Promise<boolean> {
    const account = (await this.host.state.accountRegistry.list()).find(
      (candidate) => candidate.id === accountId
    )
    if (!account) return false
    const ownedSessions = [...this.host.sessionRegistry.entries()].filter(
      ([, info]) => info.accountId === accountId
    )
    await Promise.allSettled(
      ownedSessions.map(async ([sessionId, info]) => {
        const driver = this.host.units['turns-dispatch'].driverForRuntime(info.driverId, accountId)
        if (driver && this.host.sessionStatuses.get(sessionId)?.state === 'working') {
          this.host.state.userAbortedSessions.add(sessionId)
          await driver.abort(info.projectPath, sessionId)
          this.host.units['turns-sessions'].handleSessionIdleSignal(sessionId)
          await this.host.units['turns-sessions'].awaitSessionIdleFinalization(sessionId)
        }
        await this.host.units['utilities'].cleanupTurnUtilities(sessionId)
        await this.host.threadManager.clearSessionId(info.projectId, info.threadId)
        this.host.units['turns-sessions'].retireSessionState(sessionId)
      })
    )

    const clearedThreads = new Set(
      ownedSessions.map(([, info]) => `${info.projectId}:${info.threadId}`)
    )
    const fallbackAccountId =
      (await this.host.state.accountRegistry.list(account.harnessId)).find(
        (candidate) => candidate.id !== accountId
      )?.id ?? legacyHarnessAccountId(account.harnessId)
    const affectedThreads = (await this.host.threadManager.listAllThreads()).filter(
      (thread) => thread.settings?.accountId === accountId || thread.sessionAccountId === accountId
    )
    for (let offset = 0; offset < affectedThreads.length; offset += 25) {
      await Promise.all(
        affectedThreads.slice(offset, offset + 25).map(async (thread) => {
          const settings = thread.settings
          const hadSettingsSelection = settings?.accountId === accountId
          // Threads bound to a session under the removed account with no live
          // session-registry entry (for example after an app restart) keep a
          // dead binding. Unbind them so later reads stop chasing the removed
          // account container.
          if (
            thread.sessionAccountId === accountId &&
            !clearedThreads.has(`${thread.projectId}:${thread.id}`)
          ) {
            await this.host.threadManager.clearSessionId(thread.projectId, thread.id)
          }
          if (hadSettingsSelection && settings) {
            await this.host.threadManager.updateSettings(thread.projectId, thread.id, {
              ...settings,
              accountId: fallbackAccountId
            })
          }
        })
      )
    }

    if (account.containerKind === 'managed') {
      const driver = this.host.state.accountDrivers.get(accountId)
      driver?.dispose()
      this.host.state.accountDrivers.delete(accountId)
    }
    return this.host.state.accountRegistry.remove(accountId)
  }

  /**
   * Persist the authored-work session on the thread row.
   *
   * A thread row used to answer "is this a design or a video thread" by
   * scanning every listed thread's persisted messages for the session tag, which
   * read the whole `parts` column through a LIKE on every sidebar render. The
   * thread knows the moment it enters a session, so the kind is written here and
   * the existing `thread:updated` broadcast carries it to the row.
   *
   * The row draws one marker per session the thread has entered, so this records
   * the kind in the durable set as well as naming the session it is in now: a
   * thread that designed something and later cut a video about it keeps both
   * marks. The manager writes nothing for a kind the thread already holds.
   *
   * The row is also the session's durable record: the coordinator board reads it
   * to dock, and the next turn reads it to keep carrying the session's contract,
   * so a session the agent opened by picking the capability up is the same fact
   * to every reader as one the user opened with the tag. Best-effort: the work
   * itself is already happening and a failed write must never fail a turn.
   */
  async rememberAuthoredWorkKind(
    projectId: string,
    threadId: string,
    kind: AuthoredWorkKind
  ): Promise<void> {
    try {
      await this.host.threadManager.recordAuthoredWorkKind(projectId, threadId, kind)
    } catch (error) {
      Logger.dev('Authored-work kind persist failed:', error)
    }
  }

  /** One harness's on-demand account quota   the single telemetry chain
   *  (harness-native capture, then OpenUsage, then a custom provider's usage
   *  route) shared by thread, temporary-chat, and threadless reads. */
  async readHarnessAccountUsage(target: {
    harnessId: string
    providerId: string
    accountId: string
    accountEnvironment: NodeJS.ProcessEnv
    driver: HarnessDriver
    projectPath: string
  }): Promise<AgentAccountUsage | null> {
    const { harnessId, providerId, accountId, accountEnvironment, driver, projectPath } = target
    try {
      const isCustomProvider = isCodeInOvenCustomProviderId(providerId)
      // The driver remains useful for custom providers. Pi's native usage
      // extension captures response headers from the selected provider, so a
      // custom provider can report subscription windows even without a custom
      // usage route. A driver may also return context usage for the live
      // session, which should remain visible alongside quota data.
      // OpenUsage is keyed by PROVIDER, and the candidate order is owned by the
      // client so a harness-scoped plan (Antigravity, Claude Code, Codex) wins
      // over the provider its accounts happen to report. A custom provider ID is
      // a CodeInOven namespace, so also probe the underlying provider ID. Keep
      // the Pi fallback for Pi-backed providers when no provider integration
      // exists in OpenUsage.
      const openUsageProviderIds = [
        ...openUsageProviderCandidates(harnessId, providerId),
        ...(isCustomProvider ? [underlyingProviderId(providerId)] : []),
        ...(harnessId === 'pi' ? ['pi'] : [])
      ].filter((candidate): candidate is string => Boolean(candidate))
      const [nativeAttempt, openUsageAttempt, customAttempt] = await Promise.allSettled([
        driver.readAccountUsage
          ? driver.readAccountUsage(projectPath, providerId)
          : Promise.resolve(null),
        this.host.state.openUsage.readProviderUsage(
          openUsageProviderIds,
          accountId,
          accountEnvironment
        ),
        this.readCustomProviderUsage(harnessId, providerId)
      ])
      const nativeTelemetry = nativeAttempt.status === 'fulfilled' ? nativeAttempt.value : null
      const openUsage = openUsageAttempt.status === 'fulfilled' ? openUsageAttempt.value : null
      const customUsage = customAttempt.status === 'fulfilled' ? customAttempt.value : null
      if (nativeAttempt.status === 'rejected') {
        Logger.dev('Native account usage read unavailable:', nativeAttempt.reason)
      }
      if (openUsageAttempt.status === 'rejected') {
        Logger.dev('OpenUsage account read unavailable:', openUsageAttempt.reason)
      }
      if (customAttempt.status === 'rejected') {
        Logger.dev('Custom provider usage read unavailable:', customAttempt.reason)
      }
      // Custom routes have the highest priority for custom providers. If the
      // route is missing or returns no usable data, native Pi telemetry and
      // OpenUsage still get a chance to answer the same request.
      const orderedTelemetry = isCustomProvider
        ? [customUsage, nativeTelemetry, openUsage]
        : [nativeTelemetry, openUsage, customUsage]
      const rateLimitSource = orderedTelemetry.find(
        (candidate) => candidate && candidate.rateLimits.length > 0
      )
      const creditSource = orderedTelemetry.find((candidate) => candidate?.credits)
      const telemetry =
        rateLimitSource ||
        creditSource ||
        nativeTelemetry?.contextWindow !== undefined ||
        nativeTelemetry?.contextUsed !== undefined
          ? {
              rateLimits: rateLimitSource?.rateLimits ?? [],
              ...(creditSource?.credits ? { credits: creditSource.credits } : {}),
              ...(nativeTelemetry?.bankedResets
                ? { bankedResets: nativeTelemetry.bankedResets }
                : {}),
              ...(nativeTelemetry?.contextWindow === undefined
                ? {}
                : { contextWindow: nativeTelemetry.contextWindow }),
              ...(nativeTelemetry?.contextUsed === undefined
                ? {}
                : { contextUsed: nativeTelemetry.contextUsed }),
              ...(nativeTelemetry?.reauthenticationRequired
                ? { reauthenticationRequired: true }
                : {})
            }
          : null
      if (
        !telemetry ||
        (telemetry.rateLimits.length === 0 &&
          telemetry.contextWindow === undefined &&
          telemetry.contextUsed === undefined)
      ) {
        return null
      }
      return { harnessId, providerId, accountId, ...telemetry }
    } catch (error) {
      Logger.dev('On-demand account usage refresh unavailable:', error)
      return null
    }
  }

  /**
   * Read the thread's active custom provider's user-defined usage route, when
   * it declares one. Best-effort: a missing provider, no route, or a route
   * that parses to nothing returns null and the usage UI simply shows no bars.
   */
  async readCustomProviderUsage(
    harnessId: string,
    providerId: string | undefined
  ): Promise<CustomProviderUsage | null> {
    if (!providerId) return null
    try {
      const provider = await this.host.state.baseUrlProviders.getProvider(harnessId, providerId)
      if (!provider?.usagePath) return null
      const apiKey = provider.apiKeyRef
        ? await this.host.state.secretVault.resolve(provider.apiKeyRef)
        : await this.host.state.baseUrlProviders.readNativeApiKey(harnessId, providerId)
      return await this.host.state.customProviderUsage.read(
        provider.id,
        provider.harnessId,
        provider.baseURL,
        provider.usagePath,
        apiKey,
        provider.headers,
        provider.usageFormat
      )
    } catch (error) {
      Logger.dev('Custom provider usage read failed:', error)
      return null
    }
  }

  /**
   * On-demand authentication check for a harness, routed through the driver so
   * the claude-code probe stays inside the credential-refresh gate. Returns
   * null when the harness exposes no status probe (the renderer then shows
   * nothing); otherwise true when the stored credential authenticates.
   */
  async getHarnessAuthStatus(
    projectId: string,
    harnessId: string,
    accountId?: string
  ): Promise<boolean | null> {
    projectId = validateEntityId(projectId, 'Project ID')
    harnessId = validateEntityId(harnessId, 'Harness ID', 256)
    const { driver, projectPath } = await this.host.resolve(
      projectId,
      harnessId,
      undefined,
      accountId
    )
    if (!driver.getAuthStatus) return null
    const status = await driver.getAuthStatus(projectPath)
    return status.state === 'authenticated'
  }

  /** One app-wide discovery pass; all projects share installed harness models. */
  async discoverProviders(projectId: string): Promise<ProviderCatalog[]> {
    const projectPath = await this.host.units['turns'].discoveryWorkingDirectory(projectId)
    const drivers = await this.host.units['providers-catalog'].catalogDrivers()
    const previous =
      this.host.state.sharedProviderCatalog?.catalogs ??
      this.host.state.providerCache.get(projectId) ??
      []
    const results: DriverDiscovery[] = []
    for (let offset = 0; offset < drivers.length; offset += 4) {
      const batch = await Promise.all(
        drivers.slice(offset, offset + 4).map(async (driver): Promise<DriverDiscovery> => {
          try {
            return await this.discoverDriverProviders(driver, projectPath)
          } catch (error) {
            Logger.info('Harness provider discovery skipped', {
              driverId: driver.id,
              error: error instanceof Error ? error.message : String(error)
            })
            const catalogs = previous.filter((catalog) => catalog.harnessId === driver.id)
            return { catalogs, probe: Promise.resolve(catalogs) }
          }
        })
      )
      results.push(...batch)
    }
    const merged = mergeProviderCatalogs(
      results.flatMap((entry, index) => {
        // A timeout is not an empty catalog. Keep this harness's last result
        // until its in-flight probe supplies a replacement.
        return (
          entry.catalogs ?? previous.filter((catalog) => catalog.harnessId === drivers[index]?.id)
        )
      })
    )
    this.host.state.sharedProviderCatalog = {
      schemaVersion: 3,
      discoveredAt: Date.now(),
      catalogs: merged
    }
    // Discovery reflects the drivers' current catalog inputs; re-baseline so the
    // next drift comparison starts from these values.
    void this.host.units['providers-catalog'].recordCatalogFingerprints()
    this.host.state.providerCache.set(projectId, merged)
    void this.persistProviders(projectId, merged)
    // Drivers still probing when the budget expired keep working in the
    // background; await the same probe (never a second spawn) and broadcast the
    // enriched catalog once it lands.
    const pending = results.flatMap((entry, index) => {
      const driver = drivers[index]
      return entry.catalogs === undefined && driver ? [{ ...entry, driverId: driver.id }] : []
    })
    if (pending.length > 0) {
      void this.enrichProviders(projectId, pending)
    }
    return merged
  }

  /** Load the last persisted catalog snapshot, if any. */
  async loadPersistedProviders(): Promise<ProviderCatalog[] | null> {
    try {
      let stored: ProviderCatalog[] | PersistedProviderCatalog | null
      try {
        stored = await this.host.storage.read<ProviderCatalog[] | PersistedProviderCatalog>(
          providerCatalogPath()
        )
      } catch {
        return null
      }
      if (Array.isArray(stored)) {
        const catalogs = await filterInstalledProviderCatalogs(stored)
        this.host.state.sharedProviderCatalog = {
          schemaVersion: 3,
          discoveredAt: Date.now(),
          catalogs
        }
        return catalogs
      }
      if (
        stored?.schemaVersion === 3 &&
        Array.isArray(stored.catalogs) &&
        Date.now() - stored.discoveredAt < PROVIDER_CATALOG_TTL_MS
      ) {
        // The snapshot may predate catalog-input changes made while the app was
        // closed (e.g. a pi provider connected from the CLI); fingerprints
        // recorded with the snapshot catch that without contacting any harness.
        if (stored.catalogFingerprints) {
          const current =
            await this.host.units['providers-catalog'].readProviderCatalogFingerprints()
          if (
            current &&
            Object.entries(current).some(
              ([driverId, fingerprint]) => stored.catalogFingerprints?.[driverId] !== fingerprint
            )
          ) {
            return null
          }
        }
        const catalogs = await filterInstalledProviderCatalogs(stored.catalogs)
        this.host.state.sharedProviderCatalog = { ...stored, catalogs }
        if (stored.catalogFingerprints && this.host.state.catalogFingerprints.size === 0) {
          for (const [driverId, fingerprint] of Object.entries(stored.catalogFingerprints)) {
            this.host.state.catalogFingerprints.set(driverId, fingerprint)
          }
        }
        return catalogs
      }
      return null
    } catch {
      return null
    }
  }

  /** Persist a merged catalog snapshot so the next launch is instantly populated. */
  async persistProviders(projectId: string, catalogs: ProviderCatalog[]): Promise<void> {
    try {
      const base =
        this.host.state.sharedProviderCatalog ??
        ({
          schemaVersion: 3,
          discoveredAt: Date.now(),
          catalogs
        } satisfies PersistedProviderCatalog)
      const fingerprints = this.host.units['providers-catalog'].persistedCatalogFingerprints()
      const snapshot: PersistedProviderCatalog =
        fingerprints === undefined ? base : { ...base, catalogFingerprints: fingerprints }
      await this.host.storage.write(providerCatalogPath(), snapshot)
    } catch (error) {
      Logger.info('Provider catalog persistence skipped', {
        projectId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * Resolve one driver's catalog within a strict time budget.
   *
   * The `ensureReady` pre-probe spawns each harness's CLI (or, for OpenCode, a
   * local server) just to answer "is it installed?". Drivers' `listProviders`
   * already fall back to a bundled catalog when the CLI is missing or fails,
   * so the probe is skipped here   it only adds latency to the picker.
   *
   * When the budget expires `catalogs` resolves `undefined` but the driver's
   * probe keeps running; `enrichProviders` awaits that same promise so nothing
   * is spawned twice.
   */
  async discoverDriverProviders(
    driver: HarnessDriver,
    projectPath: string
  ): Promise<DriverDiscovery> {
    const budget = ChatEngine.CATALOG_DRIVER_BUDGET_MS
    const probe = this.host.state
      .catalogProbeQueue(() => driver.listProviders(projectPath))
      .then((catalogs) =>
        catalogs.map((catalog) => ({
          ...catalog,
          supportsAttachments: driver.capabilities.attachments
        }))
      )
      .then((catalogs) => this.host.modelPricing?.enrichMissingContext(catalogs) ?? catalogs)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const catalogs = await Promise.race([
        probe,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), budget)
        })
      ])
      return { catalogs, probe }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Await the still-running driver probes and broadcast a fresh catalog. */
  async enrichProviders(
    projectId: string,
    pending: (DriverDiscovery & { driverId: string })[]
  ): Promise<void> {
    const catalogs = await Promise.all(
      pending.map(async (entry) => {
        try {
          return { driverId: entry.driverId, catalogs: await entry.probe }
        } catch (error) {
          Logger.info('Harness provider enrichment skipped', {
            error: error instanceof Error ? error.message : String(error)
          })
          return null
        }
      })
    )
    // Successful probes replace their own harness, including a confirmed empty
    // result. Failed probes keep the old entries so a retry cannot blank them.
    const replacements = catalogs.filter((entry) => entry !== null)
    const replacedHarnesses = new Set(replacements.map((entry) => entry.driverId))
    const refreshed = mergeProviderCatalogs([
      ...(this.host.state.providerCache.get(projectId) ?? []).filter(
        (catalog) => !replacedHarnesses.has(catalog.harnessId)
      ),
      ...replacements.flatMap((entry) => entry.catalogs)
    ])
    this.host.state.sharedProviderCatalog = {
      schemaVersion: 3,
      discoveredAt: Date.now(),
      catalogs: refreshed
    }
    void this.host.units['providers-catalog'].recordCatalogFingerprints()
    // Background enrichment can surface new providers/models that own tools.
    this.host.state.toolCatalogCache.clear()
    this.host.state.providerCache.set(projectId, refreshed)
    void this.persistProviders(projectId, refreshed)
    this.host.broadcast({
      type: 'providerCatalog.updated',
      projectId,
      catalogs: refreshed
    })
  }

  /**
   * Every account that may summarize a thread for search, best credential first.
   *
   * A summary is index maintenance rather than conversation, so it is never
   * bound to the account its thread was created on: that account can stop
   * serving its provider (a lapsed subscription, a rotated key) while the model
   * answers perfectly on another account of the same harness, which otherwise
   * leaves every thread of the retired account without a summary on every
   * sweep. The order is the credential the app is using for work right now
   * first, then the provider's default, then every other account of that
   * harness and provider (most recently touched first), and the thread's own
   * account last, so a user with several accounts gets all of them tried.
   */
  async summaryAccountIds(
    harnessId: string,
    providerId: string | undefined,
    modelId: string | undefined,
    threadAccountId: string | undefined
  ): Promise<string[]> {
    const ordered: string[] = []
    const push = (id: string | undefined): void => {
      if (id && !ordered.includes(id)) ordered.push(id)
    }
    if (providerId && modelId) {
      for (const session of this.host.sessionRegistry.values()) {
        if (session.driverId !== harnessId || !session.accountId) continue
        // An Inbox session has no thread row to read the model back from.
        if (session.projectId === INBOX_PROJECT_ID || !session.threadId) continue
        const live = await this.host.threadManager.getThread(session.projectId, session.threadId)
        if (live?.settings?.providerId !== providerId || live.settings.modelId !== modelId) continue
        push(session.accountId)
      }
    }
    const accounts = await this.host.state.accountRegistry.list(harnessId).catch(() => [])
    const providerAccounts = providerId
      ? accounts.filter((account) => account.providerId === providerId)
      : []
    for (const account of providerAccounts) {
      if (account.isDefault) push(account.id)
    }
    for (const account of [...providerAccounts].sort(
      (left, right) => right.updatedAt - left.updatedAt
    )) {
      push(account.id)
    }
    // The thread's own account is the last resort, and only while it belongs to
    // this provider. An account the registry does not know is kept: a virtual
    // legacy account carries no provider record to compare, and dropping it
    // would leave a single-account harness with no credential to try.
    const known = accounts.find((account) => account.id === threadAccountId)
    if (!known || !providerId || known.providerId === providerId) push(threadAccountId)
    return ordered
  }

  fallbackProviderIssue(harnessId: string, message: string, rawError?: string): AgentProviderIssue {
    const kind = classifyProviderIssue(message)
    const detail = rawError?.trim() || message.trim()
    // `message` is display copy and `rawError` is diagnostic detail: a harness
    // that crashed inside its own runtime reports its stack trace as an
    // ordinary error string, which must never become the card body.
    const presentation = presentProviderError(message)
    return {
      kind,
      message:
        kind === 'authentication'
          ? `${this.host.drivers.get(harnessId)?.name ?? harnessId} sign-in expired. Sign in again, then retry this message.`
          : presentation.message,
      rawError: detail,
      harnessId,
      retryable: kind !== 'billing'
    }
  }

  async handleProviderFailure(
    sessionId: string,
    issue: AgentProviderIssue,
    error?: string
  ): Promise<void> {
    const connectionWait = this.host.units['runtime-connectivity'].asConnectionWaitIssue(issue)
    if (connectionWait !== issue) {
      // The device explains this failure, so it is the connection wait it is:
      // the same card, the same ledger entry, and the same automatic resume a
      // transport failure gets. Parking the thread here is what keeps the
      // reconnection worth anything.
      this.host.units['runtime-connectivity'].enterRetryWait(
        sessionId,
        connectionWait,
        error ?? issue.message
      )
      return
    }
    const retryScheduled = await this.host.units['runtime-connectivity'].scheduleAutomaticRetry(
      sessionId,
      issue
    )
    // Fallback: if scheduling did not produce a pending retry but the issue is
    // a retryable usage reset, still treat as paused so the thread does not
    // fall to failed and hide the will-retry state (ba9a... silent case).
    // scheduleAutomaticRetry already persisted working-paused in this branch,
    // so we just need to signal the caller that the thread is paused.
    // A user-stopped thread is exempt: schedule refused the record, and the
    // fallback here must not re-persist working-paused (or a later launch's
    // orphan-repair scan would re-arm a timer for the stopped thread).
    //
    // A connection wait is paused here for the same reason and with a stronger
    // one: its resume is not a clock the thread can wait out, it is the device
    // coming back, and a terminal error card is what stops the app from
    // listening for that. The wait never requires the failed turn to have been
    // retryable   the device, not the provider, owns whether it can run.
    const shouldStayPaused =
      !retryScheduled &&
      (issue.kind === 'network' || (isUsageResetWaitIssue(issue) && issue.retryable)) &&
      !(await this.host.threadManager.wasStoppedByUser(
        this.host.sessionRegistry.get(sessionId)?.projectId ?? '',
        this.host.sessionRegistry.get(sessionId)?.threadId ?? ''
      ))
    if (shouldStayPaused) {
      const info = this.host.sessionRegistry.get(sessionId)
      if (info && !info.ephemeral) {
        // Ensure the persisted status is paused even if schedule exited early
        // before the dedicated fallback above (e.g. scheduler disabled).
        const current = await this.host.threadManager.getThread(info.projectId, info.threadId)
        if (current && current.status !== 'working-paused') {
          await this.host.threadManager.setStatus(info.projectId, info.threadId, 'working-paused', {
            read: false
          })
        }
      }
      await this.host.units['turns-sessions'].onSessionError(sessionId, error, true, issue.rawError)
      return
    }
    await this.host.units['turns-sessions'].onSessionError(
      sessionId,
      error,
      retryScheduled,
      issue.rawError
    )
  }
}
