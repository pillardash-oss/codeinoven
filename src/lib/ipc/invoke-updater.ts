import type { UpdaterChangelog, UpdaterStatus } from './updater'
import type { Contract } from './contract-helpers'

export const invokeUpdaterContract = {
  'updater:check': {} as Contract<[explicit?: boolean], UpdaterStatus>,
  'updater:getStatus': {} as Contract<[], UpdaterStatus>,
  /** Release notes of the newest published release for the configured channel. */
  'updater:getChangelog': {} as Contract<[], UpdaterChangelog | null>,
  'updater:download': {} as Contract<[], void>,
  'updater:install': {} as Contract<[], void>
}
