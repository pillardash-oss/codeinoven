import { createHash } from 'node:crypto'
import { homedir } from 'node:os'

/**
 * Every app-managed file on an Oven lives under this directory.
 *
 * The same convention is used by the remote service entry, the workspace
 * transfers, and the checkout resolver, so an Oven never scatters app state
 * outside one removable folder inside the user's home.
 */
export const OVEN_DATA_DIRECTORY = '.config/pillardash/codeinoven-oven'

/** One stable, collision-resistant directory name for an id. */
export function ovenDirKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20)
}

/**
 * The checkout directory for one project scope on an Oven.
 *
 * Anchored to a hash of the project and scope ids instead of their text, so a
 * name can be any character GitHub allows without becoming a path traversal.
 */
export function ovenScopeRoot(home: string, projectId: string, scopeId: string): string {
  return `${home}/${OVEN_DATA_DIRECTORY}/scopes/${ovenDirKey(projectId)}/${ovenDirKey(scopeId)}`
}

/** Where remote file removals are parked so a mistake stays recoverable. */
export function ovenTrashDirectory(): string {
  return `${homedir()}/${OVEN_DATA_DIRECTORY}/trash`
}
