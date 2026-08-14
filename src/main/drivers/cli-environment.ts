import { readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** NVM installs binaries under versioned node directories, not `current`. */
function nvmVersionedBins(): string[] {
  const root = join(homedir(), '.nvm', 'versions', 'node')
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, 'bin'))
  } catch {
    return []
  }
}

/** Marker env var set on every process spawned for a harness so a startup
 * reaper can identify app-owned processes without touching a user's own
 * external claude-code/opencode sessions. Inherited by agent-spawned children. */
export const OWNED_PROCESS_MARKER = 'CODEINOVEN_OWNED'

/**
 * Desktop apps do not inherit a login shell PATH. Keep the augmented harness
 * environment in one place so probing and process-backed drivers agree.
 */
export function buildHarnessEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = base['HOME'] ?? ''
  const extraPaths = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    `${home}/.local/bin`,
    `${home}/.bun/bin`,
    `${home}/.cargo/bin`,
    `${home}/.npm-global/bin`,
    `${home}/.nvm/current/bin`,
    ...nvmVersionedBins()
  ]
  return {
    ...base,
    PATH: `${base['PATH'] ?? ''}:${extraPaths.join(':')}`,
    [OWNED_PROCESS_MARKER]: '1'
  }
}
