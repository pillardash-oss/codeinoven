import { randomUUID } from 'node:crypto'
import { resolveDeploymentProvider } from '../../../providers/registry'
import { isRecord, requireString } from '../shared'
import { trustedIpcMain as ipcMain } from '../../trusted-ipc-main'
import {
  validateAccountLabel,
  validateCloudDeploymentProviderKind,
  validateProviderBaseUrl,
  validateProviderToken
} from './cloud-handlers-deployment-validation'
import type { CloudDeploymentConfigStore } from './cloud-handlers-deployment-config'
import type {
  CloudDeploymentProviderAccount,
  CloudDeploymentProviderKind
} from '../../../../lib/types'
import type { IpcHandlerContext } from '../context'

/**
 * The GLOBAL provider account registry: reusable across projects, with each
 * account's token vaulted by account id. A project's config only records which
 * accounts it attaches and which is active per provider.
 */
export function registerCloudDeploymentAccountHandlers(
  ctx: IpcHandlerContext,
  store: CloudDeploymentConfigStore
): void {
  const { storage, vault } = ctx
  const { syncFlag: syncCloudDeploymentsFlag } = store

  ipcMain.handle('cloudDeploy:listAccounts', async () => storage.getCloudDeploymentAccounts())

  ipcMain.handle(
    'cloudDeploy:createAccount',
    async (
      _,
      providerKind: unknown,
      accountLabel: unknown,
      token: unknown,
      rawBaseUrl?: unknown
    ) => {
      const kind = validateCloudDeploymentProviderKind(providerKind)
      const safeLabel = validateAccountLabel(accountLabel)
      const safeToken = validateProviderToken(token)
      const baseUrl =
        rawBaseUrl === undefined ? undefined : validateProviderBaseUrl(rawBaseUrl, kind)

      const registry = await storage.getCloudDeploymentAccounts()
      if (registry.accounts.some((account) => account.label === safeLabel)) {
        throw new TypeError(`A provider account named "${safeLabel}" already exists`)
      }
      const accountId = randomUUID()
      const secretRef = await vault.saveProviderToken(accountId, safeToken)
      const now = Date.now()
      const account: CloudDeploymentProviderAccount = {
        id: accountId,
        label: safeLabel,
        providerKind: kind,
        secretRef,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        configured: true,
        enabled: true,
        createdAt: now,
        updatedAt: now
      }
      registry.accounts.push(account)
      await storage.saveCloudDeploymentAccounts(registry)
      // The secret is never returned to the renderer.
      return { ...account, secretRef: '' }
    }
  )

  /**
   * Update a global provider account's metadata: label, base URL, and enabled
   * state. The secret is handled by `cloudDeploy:rotateAccountSecret` and is
   * never touched here.
   */
  ipcMain.handle(
    'cloudDeploy:updateAccount',
    async (_, accountId: unknown, patch: unknown): Promise<CloudDeploymentProviderAccount> => {
      const safeAccountId = requireString(accountId, 'Account ID', true)
      if (!isRecord(patch)) throw new TypeError('Provider account update must be an object')
      const registry = await storage.getCloudDeploymentAccounts()
      const account = registry.accounts.find((entry) => entry.id === safeAccountId)
      if (!account) throw new TypeError('Provider account not found')

      if (patch.label !== undefined) {
        const safeLabel = validateAccountLabel(patch.label)
        if (
          registry.accounts.some((entry) => entry.id !== safeAccountId && entry.label === safeLabel)
        ) {
          throw new TypeError(`A provider account named "${safeLabel}" already exists`)
        }
        account.label = safeLabel
      }
      if (patch.baseUrl !== undefined) {
        account.baseUrl = validateProviderBaseUrl(patch.baseUrl, account.providerKind)
      }
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') {
          throw new TypeError('Provider account enabled flag must be a boolean')
        }
        account.enabled = patch.enabled
      }
      account.updatedAt = Date.now()
      await storage.saveCloudDeploymentAccounts(registry)
      return { ...account, secretRef: '' }
    }
  )

  ipcMain.handle(
    'cloudDeploy:rotateAccountSecret',
    async (_, accountId: unknown, token: unknown) => {
      const safeAccountId = requireString(accountId, 'Account ID', true)
      const safeToken = validateProviderToken(token)
      const registry = await storage.getCloudDeploymentAccounts()
      const account = registry.accounts.find((entry) => entry.id === safeAccountId)
      if (!account) throw new TypeError('Provider account not found')
      account.secretRef = await vault.saveProviderToken(safeAccountId, safeToken)
      account.configured = true
      account.updatedAt = Date.now()
      await storage.saveCloudDeploymentAccounts(registry)
      // The secret is update-only; never return it. Return the sanitized account.
      return { ...account, secretRef: '' }
    }
  )

  /**
   * Verify a provider account's credentials without saving anything. Tests a
   * saved account by id (vaulted token) or inline kind + baseUrl + token from
   * an unsaved form. A light `listContainers` read is the probe: it exercises
   * auth, host reachability, and token scope in one call.
   */
  ipcMain.handle('cloudDeploy:testAccount', async (_, input: unknown) => {
    if (!isRecord(input)) throw new TypeError('Connection test input must be an object')
    let kind: CloudDeploymentProviderKind
    let baseUrl: string | undefined
    let token: string
    if (typeof input.accountId === 'string' && input.accountId.trim() !== '') {
      const safeAccountId = requireString(input.accountId, 'Account ID', true)
      const registry = await storage.getCloudDeploymentAccounts()
      const account = registry.accounts.find((entry) => entry.id === safeAccountId)
      if (!account) throw new TypeError('Provider account not found')
      if (!account.enabled) {
        throw new TypeError(`Cloud deployment account "${account.label}" is disabled`)
      }
      kind = account.providerKind
      baseUrl = account.baseUrl
      // An explicit token in the form replaces the vaulted one for the test so
      // edits can be verified before they are saved.
      token =
        typeof input.token === 'string' && input.token.trim() !== ''
          ? validateProviderToken(input.token)
          : await vault.resolveProviderToken(account.id)
      if (typeof input.baseUrl === 'string' && input.baseUrl.trim() !== '') {
        baseUrl = validateProviderBaseUrl(input.baseUrl, kind)
      }
    } else {
      kind = validateCloudDeploymentProviderKind(input.providerKind)
      if (typeof input.baseUrl !== 'string' || input.baseUrl.trim() === '') {
        throw new TypeError(`Enter the ${kind} base URL before testing.`)
      }
      baseUrl = validateProviderBaseUrl(input.baseUrl, kind)
      if (typeof input.token !== 'string' || input.token.trim() === '') {
        throw new TypeError('Enter an API token before testing.')
      }
      token = validateProviderToken(input.token)
    }
    const provider = resolveDeploymentProvider(kind, {
      ...(baseUrl === undefined ? {} : { baseUrl }),
      token
    })
    const containers = await provider.listContainers()
    return { containerCount: containers.length }
  })

  /**
   * Remove every trace of a provider account from one project's cloud
   * deployment config: its attachment, its active-account role, and every
   * container mapping monitored through it (explicitly bound mappings, plus
   * legacy unbound mappings for kinds where it was the active account).
   * Mirrors `cloudDeploy:detachAccount` cleanup so deleting an account
   * globally leaves no orphaned containers behind.
   */
  const pruneAccountFromCloudDeploymentConfig = async (accountId: string): Promise<void> => {
    for (const projectId of await storage.listDirectories('projects')) {
      const config = await storage.getCloudDeploymentConfig(projectId)
      const providerAccounts = config?.project.providerAccounts
      if (!config || !providerAccounts) continue
      let changed = false
      for (const key of Object.keys(providerAccounts) as CloudDeploymentProviderKind[]) {
        const association = providerAccounts[key]
        if (!association || !association.attachedAccountIds.includes(accountId)) continue
        const wasActive = association.activeAccountId === accountId
        const remaining = association.attachedAccountIds.filter((id) => id !== accountId)
        const containers = config.project.containers.filter((mapping) =>
          mapping.accountId !== undefined
            ? mapping.accountId !== accountId
            : // Legacy unbound mappings were monitored through the kind's
              // active account; they belong to the removed account when it was
              // active and must not silently reattach to another account.
              !(wasActive && mapping.providerKind === key)
        )
        if (containers.length !== config.project.containers.length) {
          config.project.containers = containers
        }
        if (remaining.length === 0) {
          delete providerAccounts[key]
          config.project.providers = config.project.providers.filter((provider) => provider !== key)
        } else {
          providerAccounts[key] = {
            attachedAccountIds: remaining,
            activeAccountId: wasActive ? (remaining[0] ?? null) : association.activeAccountId
          }
        }
        changed = true
      }
      if (!changed) continue
      config.updatedAt = Date.now()
      await storage.saveCloudDeploymentConfig(projectId, config)
      await syncCloudDeploymentsFlag(projectId)
    }
  }

  ipcMain.handle('cloudDeploy:removeAccount', async (_, accountId: unknown) => {
    const safeAccountId = requireString(accountId, 'Account ID', true)
    const registry = await storage.getCloudDeploymentAccounts()
    if (!registry.accounts.some((entry) => entry.id === safeAccountId)) {
      throw new TypeError('Provider account not found')
    }
    registry.accounts = registry.accounts.filter((entry) => entry.id !== safeAccountId)
    await storage.saveCloudDeploymentAccounts(registry)
    await vault.removeProviderToken(safeAccountId)
    // Detach the account from every project and drop the container mappings
    // monitored through it, so no project keeps polling (or erroring on) an
    // account that no longer exists.
    await pruneAccountFromCloudDeploymentConfig(safeAccountId)
  })
}
