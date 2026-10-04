import type { OvenPreflightReport, OvenSetupGitConfiguration, OvenSetupSelectedHarness } from '../../lib/ovens'
import { collectPreflight } from './oven-setup-bootstrap'
import { OvenGitIdentityService } from './oven-git-identity'
import { syncOvenAccount } from './oven-accounts'
import type { OvenSetupPorts } from './oven-setup-service'
import type { OvenService } from './oven-service'
import type { HarnessAccountRegistry } from '../providers/harness-account-registry'
import type { SecretVault } from '../storage/secret-vault'
import { Logger } from '../system/logger'

export interface OvenSetupPortDependencies {
  service: OvenService
  accounts: HarnessAccountRegistry
  vault: SecretVault
}

export type OvenSetupRuntime = OvenSetupPorts & { gitIdentity: OvenGitIdentityService }

/**
 * Bind the setup engine to the real environment.
 *
 * The service itself is transport-agnostic and unit-testable; everything that
 * touches an Oven, the vault, or the account registry lives here. The most
 * recent preflight report per oven is cached so the Git step can reuse the
 * observation the setup already paid for instead of adding another round trip.
 */
export function createOvenSetupPorts(dependencies: OvenSetupPortDependencies): OvenSetupRuntime {
  const gitIdentity = new OvenGitIdentityService({
    ssh: dependencies.service.ssh,
    vault: dependencies.vault
  })
  const reports = new Map<string, OvenPreflightReport>()

  return {
    gitIdentity,
    ssh: dependencies.service.ssh,
    preflight: async (ovenId) => {
      const report = await collectPreflight(dependencies.service.ssh, ovenId)
      reports.set(ovenId, report)
      return report
    },
    installService: async (ovenId) => {
      await dependencies.service.install(ovenId)
    },
    syncAccounts: async (ovenId, selections, synchronizeConfiguration) => {
      const issues: string[] = []
      const unique = new Map<string, OvenSetupSelectedHarness>()
      for (const selection of selections) {
        if (!selection.accountId) continue
        unique.set(selection.accountId, selection)
      }
      if (unique.size === 0) return issues
      // Accounts are copied one at a time. The account registry read is cheap,
      // but the upload is not, and the transport already serializes per oven.
      const accounts = await dependencies.accounts.list()
      for (const [accountId, selection] of unique) {
        const account = accounts.find((entry) => entry.id === accountId)
        if (!account) {
          issues.push(`The selected account for ${selection.harnessId} no longer exists on this computer.`)
          continue
        }
        try {
          await syncOvenAccount(
            dependencies.service,
            dependencies.accounts,
            ovenId,
            account,
            synchronizeConfiguration
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          Logger.error('Could not synchronize an account into the oven', {
            ovenId,
            harnessId: selection.harnessId,
            error: message
          })
          issues.push(`Could not copy the ${selection.harnessId} account into the Oven: ${message}`)
        }
      }
      return issues
    },
    configureGit: async (ovenId, configuration: OvenSetupGitConfiguration) => {
      if (!configuration.enabled) return []
      if (!configuration.privateKeyRef && !configuration.publicKey)
        return ['Paste a dedicated SSH private key before Git setup can run.']
      const report = reports.get(ovenId) ?? (await collectPreflight(dependencies.service.ssh, ovenId))
      reports.set(ovenId, report)
      return gitIdentity.configure(ovenId, configuration, report)
    }
  }
}
