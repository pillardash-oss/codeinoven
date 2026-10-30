import { resolveDeploymentProvider } from '../../../providers/registry'
import { validateEntityId } from '../../ipc-validation'
import { isRecord, requireString } from '../shared'
import { trustedIpcMain as ipcMain } from '../../trusted-ipc-main'
import {
  OWNERSHIP_SCAN_BATCH,
  mergeCloudDeploymentContainers,
  validateCloudDeploymentProviderKind,
  validateProviderBaseUrl,
  validateProviderToken
} from './cloud-handlers-deployment-validation'
import type { CloudDeploymentConfigStore } from './cloud-handlers-deployment-config'
import type {
  CloudDeploymentContainer,
  CloudDeploymentContainerOwner,
  CloudDeploymentProviderKind
} from '../../../../lib/types'
import type { DeploymentProviderContext } from '../../../providers/deployment-provider.interface'
import type { IpcHandlerContext } from '../context'

/**
 * Project-to-account binding and live container monitoring. The provider
 * adapter is resolved by kind through the registry, and its credential context
 * (verified base URL + vaulted token) is assembled here in main so plaintext
 * tokens never cross the IPC boundary. A provider with no attached configured
 * account is rejected up front.
 */
export function registerCloudDeploymentMonitoringHandlers(
  ctx: IpcHandlerContext,
  store: CloudDeploymentConfigStore
): void {
  const { storage, projectManager, vault } = ctx
  const { loadOrCreate: loadOrCreateCloudDeploymentConfig, persist: persistCloudDeploymentConfig } =
    store

  ipcMain.handle(
    'cloudDeploy:attachAccount',
    async (_, projectId: unknown, providerKind: unknown, accountId: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const kind = validateCloudDeploymentProviderKind(providerKind)
      const safeAccountId = requireString(accountId, 'Account ID', true)

      const registry = await storage.getCloudDeploymentAccounts()
      const account = registry.accounts.find((entry) => entry.id === safeAccountId)
      if (!account) throw new TypeError('Provider account not found')
      if (account.providerKind !== kind) {
        throw new TypeError(`Account "${account.label}" is not a ${kind} account`)
      }

      const config = await loadOrCreateCloudDeploymentConfig(safeProjectId)
      const providerAccounts = config.project.providerAccounts ?? {}
      const association = providerAccounts[kind] ?? {
        attachedAccountIds: [],
        activeAccountId: null
      }
      if (association.attachedAccountIds.includes(safeAccountId)) {
        throw new TypeError(`Account is already attached for ${kind}`)
      }
      association.attachedAccountIds.push(safeAccountId)
      if (association.activeAccountId === null) {
        association.activeAccountId = safeAccountId
      }
      config.project.providerAccounts = { ...providerAccounts, [kind]: association }
      if (!config.project.providers.includes(kind)) {
        config.project.providers = [...config.project.providers, kind]
      }
      config.updatedAt = Date.now()
      return persistCloudDeploymentConfig(safeProjectId, config)
    }
  )

  /**
   * Reconnect an account in one step: optionally replace its secret and base
   * URL, then make sure it is attached to the project and set active.
   * Deliberately idempotent, so updating the API key of an account that is
   * already attached updates it in place instead of failing on a duplicate
   * attach   the renderer rotating a secret and then attaching as two calls is
   * exactly what left a valid update reported as an error.
   */
  ipcMain.handle('cloudDeploy:reconnectAccount', async (_, input: unknown) => {
    if (!isRecord(input)) throw new TypeError('Reconnect input must be an object')
    const safeProjectId = validateEntityId(input.projectId, 'Project ID')
    const kind = validateCloudDeploymentProviderKind(input.providerKind)
    const safeAccountId = requireString(input.accountId, 'Account ID', true)

    const registry = await storage.getCloudDeploymentAccounts()
    const account = registry.accounts.find((entry) => entry.id === safeAccountId)
    if (!account) throw new TypeError('Provider account not found')
    if (account.providerKind !== kind) {
      throw new TypeError(`Account "${account.label}" is not a ${kind} account`)
    }

    // Both overrides are optional: a blank token keeps the stored secret, and a
    // blank base URL keeps the stored one.
    if (typeof input.token === 'string' && input.token.trim() !== '') {
      account.secretRef = await vault.saveProviderToken(
        safeAccountId,
        validateProviderToken(input.token)
      )
      account.configured = true
    }
    if (typeof input.baseUrl === 'string' && input.baseUrl.trim() !== '') {
      account.baseUrl = validateProviderBaseUrl(input.baseUrl, kind)
    }
    account.updatedAt = Date.now()
    await storage.saveCloudDeploymentAccounts(registry)

    const config = await loadOrCreateCloudDeploymentConfig(safeProjectId)
    const providerAccounts = config.project.providerAccounts ?? {}
    const association = providerAccounts[kind] ?? {
      attachedAccountIds: [],
      activeAccountId: null
    }
    if (!association.attachedAccountIds.includes(safeAccountId)) {
      association.attachedAccountIds = [...association.attachedAccountIds, safeAccountId]
    }
    association.activeAccountId = safeAccountId
    config.project.providerAccounts = { ...providerAccounts, [kind]: association }
    if (!config.project.providers.includes(kind)) {
      config.project.providers = [...config.project.providers, kind]
    }
    config.updatedAt = Date.now()
    const persisted = await persistCloudDeploymentConfig(safeProjectId, config)
    // The secret never crosses back to the renderer.
    return { account: { ...account, secretRef: '' }, config: persisted }
  })

  ipcMain.handle(
    'cloudDeploy:detachAccount',
    async (_, projectId: unknown, providerKind: unknown, accountId: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const kind = validateCloudDeploymentProviderKind(providerKind)
      const safeAccountId = requireString(accountId, 'Account ID', true)

      const config = await loadOrCreateCloudDeploymentConfig(safeProjectId)
      const providerAccounts = config.project.providerAccounts ?? {}
      const association = providerAccounts[kind]
      if (!association || !association.attachedAccountIds.includes(safeAccountId)) {
        throw new TypeError(`Account is not attached for ${kind}`)
      }
      const remaining = association.attachedAccountIds.filter((id) => id !== safeAccountId)
      const wasActive = association.activeAccountId === safeAccountId
      // Container mappings monitored through the detached account stop here:
      // explicitly bound mappings go with the account, and legacy unbound
      // mappings for this kind were monitored through it while it was active
      // and must not silently reattach to another account.
      config.project.containers = config.project.containers.filter((mapping) =>
        mapping.accountId !== undefined
          ? mapping.accountId !== safeAccountId
          : !(wasActive && mapping.providerKind === kind)
      )
      if (remaining.length === 0) {
        delete providerAccounts[kind]
        config.project.providerAccounts = providerAccounts
        config.project.providers = config.project.providers.filter((provider) => provider !== kind)
      } else {
        providerAccounts[kind] = {
          attachedAccountIds: remaining,
          activeAccountId: wasActive ? (remaining[0] ?? null) : association.activeAccountId
        }
        config.project.providerAccounts = providerAccounts
      }
      config.updatedAt = Date.now()
      return persistCloudDeploymentConfig(safeProjectId, config)
    }
  )

  ipcMain.handle(
    'cloudDeploy:setActiveAccount',
    async (_, projectId: unknown, providerKind: unknown, accountId: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const kind = validateCloudDeploymentProviderKind(providerKind)
      const safeAccountId = requireString(accountId, 'Account ID', true)

      const config = await loadOrCreateCloudDeploymentConfig(safeProjectId)
      const providerAccounts = config.project.providerAccounts ?? {}
      const association = providerAccounts[kind]
      if (!association || !association.attachedAccountIds.includes(safeAccountId)) {
        throw new TypeError(`Account is not attached for ${kind}`)
      }
      providerAccounts[kind] = { ...association, activeAccountId: safeAccountId }
      config.project.providerAccounts = providerAccounts
      config.updatedAt = Date.now()
      return persistCloudDeploymentConfig(safeProjectId, config)
    }
  )

  /**
   * Resolve the provider credential context for one project + provider kind.
   * When `accountId` is given it must be one of the project's attached accounts
   * for that kind (per-container account binding, so a second account of the
   * same kind keeps working independently of the active-account switch);
   * otherwise the project's active account for the kind is used.
   */
  const resolveDeploymentContext = async (
    projectId: string,
    kind: CloudDeploymentProviderKind,
    accountId?: string
  ): Promise<DeploymentProviderContext> => {
    const config = await storage.getCloudDeploymentConfig(projectId)
    const association = config?.project.providerAccounts?.[kind]
    const explicitAccountId = accountId ?? null
    if (
      explicitAccountId !== null &&
      !(association?.attachedAccountIds ?? []).includes(explicitAccountId)
    ) {
      throw new TypeError(`Cloud deployment account is not attached to this project for ${kind}`)
    }
    const activeAccountId = explicitAccountId ?? association?.activeAccountId ?? null
    const registry = activeAccountId === null ? null : await storage.getCloudDeploymentAccounts()
    const activeAccount =
      activeAccountId === null
        ? undefined
        : registry?.accounts.find((account) => account.id === activeAccountId)
    if (!activeAccount?.configured || !activeAccount.secretRef) {
      throw new TypeError(`Cloud deployment provider ${kind} is not configured for this project`)
    }
    if (!activeAccount.enabled) {
      throw new TypeError(`Cloud deployment account "${activeAccount.label}" is disabled`)
    }
    const token = await vault.resolveProviderToken(activeAccount.id)
    return {
      ...(activeAccount.baseUrl === undefined ? {} : { baseUrl: activeAccount.baseUrl }),
      token
    }
  }

  ipcMain.handle('cloudDeploy:overview', async (_, projectId: unknown, providerKind: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    const kind = validateCloudDeploymentProviderKind(providerKind)
    const hasDeployments = await storage.hasCloudDeployments(safeProjectId)
    const config = await loadOrCreateCloudDeploymentConfig(safeProjectId)
    // Every attached account for this kind contributes containers (active
    // first), so a second account of the same kind is monitored alongside the
    // first instead of being hidden behind the active-account switch.
    const association = config.project.providerAccounts?.[kind]
    const activeAccountId = association?.activeAccountId ?? null
    const attachedAccountIds = association?.attachedAccountIds ?? []
    const orderedAccountIds = [
      ...(activeAccountId !== null ? [activeAccountId] : []),
      ...attachedAccountIds.filter((accountId) => accountId !== activeAccountId)
    ]
    const registry = await storage.getCloudDeploymentAccounts()
    // Read-time guard for configs that still reference accounts deleted from
    // the global registry (e.g. removed before pruning existed): skip them and
    // the container mappings bound to them so dead accounts stop surfacing
    // errors or ghost containers.
    const knownAccountIds = new Set(registry.accounts.map((account) => account.id))
    const liveMappings = config.project.containers.filter(
      (mapping) => mapping.accountId === undefined || knownAccountIds.has(mapping.accountId)
    )
    const accountLabel = (accountId: string): string =>
      registry.accounts.find((account) => account.id === accountId)?.label ?? accountId

    if (orderedAccountIds.length === 0) {
      // Legacy shape: the kind is selected but no account association exists;
      // resolve through the single active-account path (its error surfaces).
      try {
        const provider = resolveDeploymentProvider(
          kind,
          await resolveDeploymentContext(safeProjectId, kind)
        )
        const liveContainers = await provider.listContainers()
        return {
          containers: mergeCloudDeploymentContainers(liveContainers, liveMappings, kind),
          fetchedAt: Date.now(),
          hasDeployments
        }
      } catch (error) {
        return {
          containers: [],
          fetchedAt: Date.now(),
          hasDeployments,
          accessError: error instanceof Error ? error.message : 'Provider request failed'
        }
      }
    }

    const fetchableAccountIds = orderedAccountIds.filter((accountId) =>
      knownAccountIds.has(accountId)
    )
    if (fetchableAccountIds.length === 0) {
      // Every attached account is gone from the registry (removed before the
      // prune existed, or edited outside the app). Saying so is the difference
      // between "nothing to monitor" and "your credentials went away": an
      // empty list alone renders as an empty panel and looks like the project's
      // containers were never configured.
      const missingLabels = orderedAccountIds.map(accountLabel)
      return {
        containers: [],
        fetchedAt: Date.now(),
        hasDeployments,
        accessError: `No attached ${kind} account could be found (${missingLabels.join(', ')}). Reconnect a ${kind} account to monitor this project's containers again.`
      }
    }

    const liveContainers: CloudDeploymentContainer[] = []
    const failures: string[] = []
    await Promise.all(
      fetchableAccountIds.map(async (accountId) => {
        try {
          const provider = resolveDeploymentProvider(
            kind,
            await resolveDeploymentContext(safeProjectId, kind, accountId)
          )
          const containers = await provider.listContainers()
          liveContainers.push(...containers.map((container) => ({ ...container, accountId })))
        } catch (error) {
          const label = accountLabel(accountId)
          failures.push(
            `${label}: ${error instanceof Error ? error.message : 'Provider request failed'}`
          )
        }
      })
    )
    const containers = mergeCloudDeploymentContainers(liveContainers, liveMappings, kind)
    return {
      containers,
      fetchedAt: Date.now(),
      hasDeployments,
      ...(failures.length > 0 ? { accessError: failures.join(' · ') } : {})
    }
  })

  ipcMain.handle(
    'cloudDeploy:availableContainers',
    async (_, projectId: unknown, providerKind: unknown, accountId?: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const kind = validateCloudDeploymentProviderKind(providerKind)
      const safeAccountId =
        accountId === undefined ? undefined : requireString(accountId, 'Account ID', true)
      try {
        const provider = resolveDeploymentProvider(
          kind,
          await resolveDeploymentContext(safeProjectId, kind, safeAccountId)
        )
        return await provider.listContainers()
      } catch (error) {
        return {
          accessError: error instanceof Error ? error.message : 'Provider request failed'
        }
      }
    }
  )

  /**
   * Resolve which OTHER projects already monitor a provider kind's containers.
   *
   * A provider account reports every container it hosts, across all of the
   * provider's own projects, so the picker cannot tell them apart on its own.
   * Ownership comes from the per-project mappings instead: a container id
   * already mapped by another project is that project's, and the picker marks
   * it as claimed so the same container is never pulled into this project
   * unnoticed by a batch add.
   *
   * Every project config is read, so the walk is batched rather than one await
   * per project: main must not sit on a chain of sequential file reads while
   * the renderer waits.
   */
  ipcMain.handle(
    'cloudDeploy:containerOwners',
    async (
      _,
      projectId: unknown,
      providerKind: unknown
    ): Promise<CloudDeploymentContainerOwner[]> => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const kind = validateCloudDeploymentProviderKind(providerKind)

      const projectIds = (await storage.listDirectories('projects')).filter(
        (candidate) => candidate !== safeProjectId
      )
      const ownerProjectIds = new Set<string>()
      const containerIdOwners = new Map<string, string>()
      for (let index = 0; index < projectIds.length; index += OWNERSHIP_SCAN_BATCH) {
        const batch = projectIds.slice(index, index + OWNERSHIP_SCAN_BATCH)
        const scanned = await Promise.all(
          batch.map(async (candidate) => ({
            projectId: candidate,
            config: await storage.getCloudDeploymentConfig(candidate)
          }))
        )
        for (const { projectId, config } of scanned) {
          if (!config) continue
          for (const mapping of config.project.containers) {
            if (mapping.providerKind !== kind) continue
            // The first project to claim an id wins, so the list stays one entry
            // per container even when two projects monitor it.
            if (containerIdOwners.has(mapping.id)) continue
            containerIdOwners.set(mapping.id, projectId)
            ownerProjectIds.add(projectId)
          }
        }
      }

      // Names are resolved once per owning project, not once per container.
      const names = new Map<string, string>()
      for (const ownerProjectId of ownerProjectIds) {
        const project = await projectManager.getProject(ownerProjectId)
        names.set(ownerProjectId, project?.name ?? ownerProjectId)
      }

      return [...containerIdOwners].map(([containerId, ownerProjectId]) => ({
        containerId,
        projectId: ownerProjectId,
        projectName: names.get(ownerProjectId) ?? ownerProjectId
      }))
    }
  )

  ipcMain.handle(
    'cloudDeploy:containerStatus',
    async (
      _,
      projectId: unknown,
      providerKind: unknown,
      containerId: unknown,
      accountId?: unknown
    ) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const kind = validateCloudDeploymentProviderKind(providerKind)
      const safeContainerId = requireString(containerId, 'Container ID')
      const safeAccountId =
        accountId === undefined ? undefined : requireString(accountId, 'Account ID', true)
      const provider = resolveDeploymentProvider(
        kind,
        await resolveDeploymentContext(safeProjectId, kind, safeAccountId)
      )
      return provider.getStatus(safeContainerId)
    }
  )

  ipcMain.handle(
    'cloudDeploy:containerLog',
    async (
      _,
      projectId: unknown,
      providerKind: unknown,
      containerId: unknown,
      deploymentId?: unknown,
      accountId?: unknown
    ) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const kind = validateCloudDeploymentProviderKind(providerKind)
      const safeContainerId = requireString(containerId, 'Container ID')
      const safeDeploymentId =
        deploymentId === undefined ? undefined : requireString(deploymentId, 'Deployment ID')
      const safeAccountId =
        accountId === undefined ? undefined : requireString(accountId, 'Account ID', true)
      const provider = resolveDeploymentProvider(
        kind,
        await resolveDeploymentContext(safeProjectId, kind, safeAccountId)
      )
      const log = await provider.getLogs(safeContainerId, safeDeploymentId)
      return { containerId: safeContainerId, deploymentId: safeDeploymentId ?? null, log }
    }
  )

  ipcMain.handle(
    'cloudDeploy:deployments',
    async (
      _,
      projectId: unknown,
      providerKind: unknown,
      containerId: unknown,
      accountId?: unknown
    ) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const kind = validateCloudDeploymentProviderKind(providerKind)
      const safeContainerId = requireString(containerId, 'Container ID')
      const safeAccountId =
        accountId === undefined ? undefined : requireString(accountId, 'Account ID', true)
      const provider = resolveDeploymentProvider(
        kind,
        await resolveDeploymentContext(safeProjectId, kind, safeAccountId)
      )
      return provider.listDeployments(safeContainerId)
    }
  )
}
