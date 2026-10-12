import type { OvenPreflightReport, OvenSetupGitConfiguration } from '../../lib/ovens'
import { collectPreflight } from './oven-setup-bootstrap'
import { syncOvenClock, syncOvenTimezone } from './oven-timezone'
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
  /**
   * The most recent completed check for one Oven, when it is young enough to
   * authorize a setup. Setup reuses it instead of opening its own read, so a
   * dialog the user just watched check does not check again on Start.
   */
  recentReport?: (ovenId: string) => OvenPreflightReport | null
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
    ...(dependencies.recentReport ? { recentReport: dependencies.recentReport } : {}),
    waitForHarnessIdle: async (ovenId, command) => {
      while (
        (await dependencies.service.runs(ovenId)).some(
          (run) => run.command === command && run.status === 'running'
        )
      )
        await new Promise((resolve) => setTimeout(resolve, 1_000))
    },
    preflight: async (ovenId) => {
      const report = await collectPreflight(dependencies.service.ssh, ovenId)
      reports.set(ovenId, report)
      return report
    },
    installService: async (ovenId) => {
      await dependencies.service.install(ovenId)
    },
    syncTimezone: async (ovenId, zone, observation) => {
      /* The absolute clock and the zone are separate problems: `apt` reads the
         first and the user reads the second, so this step corrects both. */
      const clock = await syncOvenClock(dependencies.service.ssh, ovenId, observation)
      const timezone = await syncOvenTimezone(dependencies.service.ssh, ovenId, zone, observation)
      const changed =
        clock.status === 'updated'
          ? [clock.message, ...(timezone.status === 'updated' ? [timezone.message] : [])]
          : timezone.status === 'updated'
            ? [timezone.message]
            : []
      const unsupported =
        changed.length === 0 && clock.status === 'unsupported' ? clock.message : null
      const result = {
        status: (changed.length > 0 ? 'updated' : unsupported ? 'unsupported' : 'current') as
          'updated' | 'current' | 'unsupported',
        zone: timezone.zone,
        message: changed.length > 0 ? changed.join(' ') : (unsupported ?? timezone.message)
      }
      Logger.info('Oven clock matched', {
        ovenId,
        zone: result.zone,
        status: result.status,
        offset: clock.message
      })
      return result
    },
    syncAccounts: async (ovenId, selections, synchronizeConfiguration) => {
      const issues: string[] = []
      const harnessIds = new Set(selections.map((selection) => selection.harnessId))
      if (harnessIds.size === 0) return issues
      // Copy accounts sequentially into their isolated remote account directories.
      const accounts = await dependencies.accounts.list()
      for (const account of accounts) {
        if (!harnessIds.has(account.harnessId)) continue
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
            harnessId: account.harnessId,
            error: message
          })
          issues.push(`Could not copy the ${account.harnessId} account into the Oven: ${message}`)
        }
      }
      return issues
    },
    configureGit: async (ovenId, configuration: OvenSetupGitConfiguration) => {
      if (!configuration.enabled) return []
      if (!configuration.privateKeyRef && !configuration.publicKey)
        return ['Paste a dedicated SSH private key before Git setup can run.']
      const report =
        reports.get(ovenId) ?? (await collectPreflight(dependencies.service.ssh, ovenId))
      reports.set(ovenId, report)
      return gitIdentity.configure(ovenId, configuration, report)
    }
  }
}
