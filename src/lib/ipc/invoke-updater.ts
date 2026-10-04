import type { UpdateBlockers, UpdaterChangelog, UpdaterStatus } from './updater'
import type { Contract } from './contract-helpers'

export const invokeUpdaterContract = {
  'updater:check': {} as Contract<[explicit?: boolean], UpdaterStatus>,
  'updater:getStatus': {} as Contract<[], UpdaterStatus>,
  /** Release notes of the newest published release for the configured channel. */
  'updater:getChangelog': {} as Contract<[], UpdaterChangelog | null>,
  'updater:download': {} as Contract<[], void>,
  'updater:install': {} as Contract<[], void>,
  /** What a pending install is waiting on, for the force-install modal. */
  'updater:blockers': {} as Contract<[], UpdateBlockers>,
  /** Stop everything the gate is waiting on, then install without waiting. */
  'updater:forceInstall': {} as Contract<[], void>
}
