/**
 * "New Instance": open a second CodeInOven window on the same data.
 *
 * A new instance is a real second process, not another window, because that is
 * what the app already supports: one config root, one owner of the scheduled
 * work, and any number of secondary windows into the same database. The only
 * thing the platform demands is a distinct Electron `userData`, so each extra
 * instance claims a reusable slot profile (see `instance-slots`).
 *
 * The launch is detached: the instance outlives nothing, it simply does not
 * share this process's console, stdio or lifetime, so quitting the instance that
 * opened it leaves it running exactly like a second launch from Finder would.
 */

import { spawn } from 'node:child_process'
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Logger } from './logger'
import {
  INSTANCE_SLOT_ENV,
  MAX_INSTANCE_SLOTS,
  instanceSlotPidFile,
  instanceSlotProfileDirectory
} from './instance-slots'

/** What the menu needs to tell the user when a new instance cannot be opened. */
export type NewInstanceOutcome =
  { ok: true; slot: number } | { ok: false; reason: 'limit' | 'spawn'; detail?: string }

/**
 * Is the process that claimed this slot still running?
 *
 * `process.kill(pid, 0)` probes without sending a signal. A pid the process
 * cannot signal is still alive (EPERM), and a pid that does not exist is free.
 */
function isSlotHolderAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

/** The process that claimed one slot, or null when the slot is free. */
function slotHolderPid(slot: number): number | null {
  const file = instanceSlotPidFile(slot)
  if (!existsSync(file)) return null
  try {
    const pid = Number(readFileSync(file, 'utf8').trim())
    return isSlotHolderAlive(pid) ? pid : null
  } catch {
    return null
  }
}

/** The lowest slot no live process holds, so dead slots are reused first. */
export function findFreeInstanceSlot(): number | null {
  for (let slot = 1; slot <= MAX_INSTANCE_SLOTS; slot += 1) {
    if (slotHolderPid(slot) === null) return slot
  }
  return null
}

/**
 * Launch one more instance beside this one.
 *
 * The child is told which slot to occupy; its own startup then redirects the
 * Chromium profile into that slot before `ready`. This writes the marker first,
 * so a second click a moment later cannot claim the same slot while the child is
 * still booting.
 */
export function spawnNewInstance(): NewInstanceOutcome {
  const slot = findFreeInstanceSlot()
  if (slot === null) return { ok: false, reason: 'limit' }

  const profileDirectory = instanceSlotProfileDirectory(slot)
  try {
    mkdirSync(profileDirectory, { recursive: true })
  } catch (error: unknown) {
    Logger.error('Could not prepare the new instance profile', error)
    return {
      ok: false,
      reason: 'spawn',
      detail: error instanceof Error ? error.message : String(error)
    }
  }

  try {
    // A development launch runs Electron itself and needs the app path as its
    // first argument; a packaged launch is the app's own executable.
    const args = app.isPackaged ? [] : [app.getAppPath()]
    const child = spawn(app.getPath('exe'), args, {
      env: { ...process.env, [INSTANCE_SLOT_ENV]: String(slot) },
      detached: true,
      stdio: 'ignore'
    })
    child.on('error', (error) => Logger.error('New instance could not start', error))
    if (child.pid) {
      writeFileSync(instanceSlotPidFile(slot), String(child.pid), 'utf8')
    }
    child.unref()
    Logger.info('Opened a new instance', { slot, pid: child.pid ?? 0 })
    return { ok: true, slot }
  } catch (error: unknown) {
    Logger.error('New instance could not start', error)
    return {
      ok: false,
      reason: 'spawn',
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}
