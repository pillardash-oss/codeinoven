import { invoke } from '$lib/ipc.svelte'
import type {
  CloudDeploymentAccountRegistry,
  CloudDeploymentConfig,
  CloudDeploymentProviderAccount,
  CloudDeploymentProviderKind
} from '$shared/types'

/**
 * Renderer store for the GLOBAL cloud provider account registry and each
 * project's account association. Provider accounts are created once, labelled,
 * and reused across projects; this store exposes the registry plus the
 * create/update/rotate/remove and per-project attach/detach/set-active
 * operations backed by the IPC channels.
 */
class CloudAccountsState {
  accounts: CloudDeploymentProviderAccount[] = $state([])
  loaded = $state(false)
  error = $state<string | null>(null)

  accountById(id: string): CloudDeploymentProviderAccount | undefined {
    return this.accounts.find((account) => account.id === id)
  }

  accountsByProvider(kind: CloudDeploymentProviderKind): CloudDeploymentProviderAccount[] {
    return this.accounts.filter((account) => account.providerKind === kind)
  }

  async load(): Promise<void> {
    try {
      const registry: CloudDeploymentAccountRegistry = await invoke('cloudDeploy:listAccounts')
      this.accounts = registry.accounts
      this.error = null
    } catch (reason) {
      this.error = reason instanceof Error ? reason.message : 'Cloud accounts could not be loaded.'
    } finally {
      this.loaded = true
    }
  }

  async createAccount(
    kind: CloudDeploymentProviderKind,
    label: string,
    token: string,
    baseUrl?: string
  ): Promise<CloudDeploymentProviderAccount> {
    const account = await invoke('cloudDeploy:createAccount', kind, label, token, baseUrl)
    await this.load()
    return account
  }

  async updateLabel(accountId: string, label: string): Promise<void> {
    await invoke('cloudDeploy:updateAccountLabel', accountId, label)
    await this.load()
  }

  async rotateSecret(accountId: string, token: string): Promise<void> {
    await invoke('cloudDeploy:rotateAccountSecret', accountId, token)
    await this.load()
  }

  async removeAccount(accountId: string): Promise<void> {
    await invoke('cloudDeploy:removeAccount', accountId)
    await this.load()
  }

  async attachAccount(
    projectId: string,
    kind: CloudDeploymentProviderKind,
    accountId: string
  ): Promise<CloudDeploymentConfig> {
    return invoke('cloudDeploy:attachAccount', projectId, kind, accountId)
  }

  async detachAccount(
    projectId: string,
    kind: CloudDeploymentProviderKind,
    accountId: string
  ): Promise<CloudDeploymentConfig> {
    return invoke('cloudDeploy:detachAccount', projectId, kind, accountId)
  }

  async setActiveAccount(
    projectId: string,
    kind: CloudDeploymentProviderKind,
    accountId: string
  ): Promise<CloudDeploymentConfig> {
    return invoke('cloudDeploy:setActiveAccount', projectId, kind, accountId)
  }
}

export const cloudAccountsState = new CloudAccountsState()
