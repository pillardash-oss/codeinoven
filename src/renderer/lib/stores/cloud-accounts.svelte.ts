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
 * operations backed by the IPC channels. Plaintext secrets never cross IPC —
 * main returns sanitized accounts and only the update/rotate operations accept
 * a token.
 */
class CloudAccountsState {
  accounts: CloudDeploymentProviderAccount[] = $state([])
  loaded = $state(false)
  loading = $state(false)
  saving = $state(false)
  error = $state<string | null>(null)

  accountById(id: string): CloudDeploymentProviderAccount | undefined {
    return this.accounts.find((account) => account.id === id)
  }

  accountsByProvider(kind: CloudDeploymentProviderKind): CloudDeploymentProviderAccount[] {
    return this.accounts.filter((account) => account.providerKind === kind)
  }

  async load(): Promise<void> {
    this.loading = true
    try {
      const registry: CloudDeploymentAccountRegistry = await invoke('cloudDeploy:listAccounts')
      this.accounts = registry.accounts
      this.error = null
    } catch (reason) {
      this.error = reason instanceof Error ? reason.message : 'Cloud accounts could not be loaded.'
    } finally {
      this.loading = false
      this.loaded = true
    }
  }

  async createAccount(
    kind: CloudDeploymentProviderKind,
    label: string,
    token: string,
    baseUrl?: string
  ): Promise<CloudDeploymentProviderAccount> {
    this.saving = true
    try {
      const account = await invoke('cloudDeploy:createAccount', kind, label, token, baseUrl)
      this.accounts = [...this.accounts, account]
      return account
    } finally {
      this.saving = false
    }
  }

  async updateAccount(
    accountId: string,
    patch: { label?: string; baseUrl?: string; enabled?: boolean }
  ): Promise<CloudDeploymentProviderAccount> {
    this.saving = true
    try {
      const updated = await invoke('cloudDeploy:updateAccount', accountId, patch)
      this.accounts = this.accounts.map((account) =>
        account.id === updated.id ? updated : account
      )
      return updated
    } finally {
      this.saving = false
    }
  }

  async setEnabled(accountId: string, enabled: boolean): Promise<void> {
    await this.updateAccount(accountId, { enabled })
  }

  async rotateSecret(accountId: string, token: string): Promise<void> {
    this.saving = true
    try {
      const updated = await invoke('cloudDeploy:rotateAccountSecret', accountId, token)
      this.accounts = this.accounts.map((account) =>
        account.id === updated.id ? updated : account
      )
    } finally {
      this.saving = false
    }
  }

  async removeAccount(accountId: string): Promise<void> {
    this.saving = true
    try {
      await invoke('cloudDeploy:removeAccount', accountId)
      this.accounts = this.accounts.filter((account) => account.id !== accountId)
    } finally {
      this.saving = false
    }
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
