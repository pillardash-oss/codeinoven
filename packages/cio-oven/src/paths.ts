import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { OVEN_DATA_DIRECTORY } from '../../../src/main/ovens/remote/oven-root-paths'

/** Every path this CLI and the Oven service agree on, for one data root. */
export interface OvenLayout {
  dataRoot: string
  serviceFile: string
  registrationFile: string
  pidFile: string
}

/**
 * Resolve one data root into the exact files the service uses.
 *
 * The names match the app's own Oven service layout, so a machine prepared by
 * this CLI is reachable by CodeInOven without moving anything.
 */
export function ovenLayout(dataRoot: string): OvenLayout {
  const root = resolve(dataRoot)
  return {
    dataRoot: root,
    serviceFile: join(root, 'service.mjs'),
    registrationFile: join(root, 'agent-registration.json'),
    pidFile: join(root, 'service.pid')
  }
}

/** The same default data root the Oven service and the app installer use. */
export function defaultDataRoot(): string {
  return join(homedir(), OVEN_DATA_DIRECTORY)
}

/**
 * The dedicated identity this CLI provisions.
 *
 * The name is shared with the app's own agent installer, so re-running either
 * path reuses one key instead of scattering identities through `~/.ssh`.
 */
export function identityKeyPath(): string {
  return join(homedir(), '.ssh', 'codeinoven-oven-agent')
}
