/**
 * Addresses for the extra instances the user can open beside the first one.
 *
 * CodeInOven is built to run more than one process against one config root: the
 * database is shared, one process wins the owner election and runs the scheduled
 * work, and every other one is a `secondary` window into the same data
 * (`instance-registry`, `thread:foreignRuns`, the handoff bus). What the platform
 * forces is a distinct Electron `userData` per process, because
 * `app.requestSingleInstanceLock()` is keyed by that path: two launches sharing
 * one profile collapse into one process by design.
 *
 * A slot is therefore a reusable Chromium profile: `slot-1`, `slot-2`, ... Each
 * carries its own `instance.pid` marker so the launcher only reuses a slot whose
 * process is gone. App data never lives here; only the Chromium profile does,
 * and the config root stays shared.
 */

import { join } from 'node:path'
import { getConfigRoot } from '../../lib/utils'

/**
 * Environment variable naming the slot a launch must occupy.
 *
 * Set by "New Instance" when it spawns a sibling, and read before `ready` by
 * `configureElectronDataRoot`. It only redirects the Chromium profile, never the
 * app data root, so an unexpected value in the environment cannot move a user's
 * database, projects or threads.
 */
export const INSTANCE_SLOT_ENV = 'CODEINOVEN_INSTANCE_SLOT'

/** How many extra instances can run at once, first instance excluded. */
export const MAX_INSTANCE_SLOTS = 8

/** Marker file inside a slot profile recording the process that holds it. */
const SLOT_PID_FILE = 'instance.pid'

/** The directory holding every slot profile. */
export function instanceSlotsDirectory(): string {
  return join(getConfigRoot(), 'electron-instances')
}

/** The Chromium profile directory for one slot. */
export function instanceSlotProfileDirectory(slot: number): string {
  return join(instanceSlotsDirectory(), `slot-${slot}`)
}

/** The marker file recording which process holds one slot. */
export function instanceSlotPidFile(slot: number): string {
  return join(instanceSlotProfileDirectory(slot), SLOT_PID_FILE)
}

/** Read the slot this launch was told to occupy, or null for a normal launch. */
export function requestedInstanceSlot(): number | null {
  const raw = process.env[INSTANCE_SLOT_ENV]?.trim()
  if (!raw) return null
  if (!/^[1-9][0-9]?$/.test(raw)) return null
  const slot = Number(raw)
  return slot >= 1 && slot <= MAX_INSTANCE_SLOTS ? slot : null
}

/** Whether this launch is an extra instance opened from a running one. */
export function isExtraInstanceLaunch(): boolean {
  return requestedInstanceSlot() !== null
}
