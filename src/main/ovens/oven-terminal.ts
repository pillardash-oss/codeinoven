import { mkdir } from 'node:fs/promises'
import type { Database } from '../database/database'
import { ProjectRepo } from '../database/repositories/project-repo'
import { resolveOvenThreadRoot } from './oven-thread-root'
import { ThreadRepo } from '../database/repositories/thread-repo'
import type { StorageEngine } from '../storage/storage-engine'
import type { SecretVault } from '../storage/secret-vault'
import type {
  PtyOvenShellLaunchHook,
  PtyRemoteLaunch,
  PtyRemoteLaunchHook
} from '../system/pty-service'
import { HarnessAccountRegistry } from '../providers/harness-account-registry'
import { OvenRegistry } from './oven-registry'
import { OvenService } from './oven-service'
import type { OvenSshInvocation } from './oven-ssh'
import { syncOvenAccount } from './oven-accounts'
import { detectRemoteShell } from './oven-remote-shell'
import { remoteTerminalCommand } from './oven-remote-command'

/**
 * Prepare one SSH PTY launch into an Oven.
 *
 * Every Oven terminal shares this tail: the credentials live in a scratch
 * directory that the launch disposes when the PTY exits, and the local cwd the
 * `ssh` process runs in lives under the app's own storage rather than an OS temp
 * folder. Factoring it keeps the thread checkout shell and the plain Oven shell
 * from drifting apart on cleanup.
 */
async function prepareOvenLaunch(
  storage: StorageEngine,
  launch: OvenSshInvocation,
  ovenId: string,
  remoteCwd: string
): Promise<PtyRemoteLaunch> {
  try {
    const localCwd = storage.resolve('ovens/terminals')
    await mkdir(localCwd, { recursive: true, mode: 0o700 })
    return {
      ovenId,
      executable: launch.executable,
      args: launch.args,
      environment: Object.fromEntries(
        Object.entries(launch.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      ),
      localCwd,
      remoteCwd,
      dispose: launch.dispose
    }
  } catch (error) {
    await launch.dispose()
    throw error
  }
}

/** Resolve terminal/action work to the chat's Oven before looking at local files. */
export function ovenTerminalLaunch(
  storage: StorageEngine,
  vault: SecretVault,
  database: Database
): PtyRemoteLaunchHook {
  const threads = new ThreadRepo(database)
  const projects = new ProjectRepo(database)
  const service = new OvenService(new OvenRegistry(storage, vault))
  const accounts = new HarnessAccountRegistry(storage)
  return async (projectId, threadId, directory, script, variables) => {
    const thread = await threads.getViaWorker(threadId)
    if (!thread || thread.projectId !== projectId)
      throw new Error('This terminal thread is unavailable.')
    const settings = thread.settings
    if (!settings?.ovenId || settings.ovenId === 'local') return null
    const ovenId = settings.ovenId
    let root = settings.ovenPath ?? ''
    if (script !== undefined || directory)
      root = (
        await resolveOvenThreadRoot(service, thread, {
          getProject: (id) => projects.getViaWorker(id)
        })
      ).root
    if (directory) {
      const checked = await service.workspace(ovenId, { operation: 'stat', root, path: directory })
      if (checked.file?.kind !== 'directory')
        throw new Error('Choose a directory inside the Oven workspace.')
      root = checked.file.path ? `${root}/${checked.file.path}` : root
    }
    let environment: Record<string, string> = {}
    if (script !== undefined) {
      const account = await accounts.resolveForProvider(
        settings.harnessId,
        settings.providerId,
        settings.accountId
      )
      environment = await syncOvenAccount(service, accounts, ovenId, account)
    }
    if (variables) {
      if (Object.keys(variables).length > 100) throw new Error('An action has too many variables.')
      for (const [name, value] of Object.entries(variables)) {
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
          typeof value !== 'string' ||
          value.length > 32_768 ||
          value.includes('\0')
        )
          throw new Error('An action variable is invalid.')
        environment[name] = value
      }
    }
    if (
      script !== undefined &&
      (!script.trim() || script.length > 100_000 || script.includes('\0'))
    )
      throw new Error('Action script is invalid.')
    // Detect the shell on every open instead of reading the cached answer. A
    // cached answer skips the round trip, and with it the only reachable check
    // this path makes: a down Oven then spawned a PTY whose ssh died at once,
    // which the renderer respawned into a wall of repeated failures. An explicit
    // detection fails here, before any PTY exists, so the panel shows one reason.
    const shell = await detectRemoteShell(service.ssh, ovenId)
    const command = remoteTerminalCommand({
      shell,
      root: root || undefined,
      environment,
      script
    })
    const launch = await service.ssh.prepare(ovenId, command, script === undefined, undefined, true)
    return prepareOvenLaunch(storage, launch, ovenId, root || '~')
  }
}

/**
 * Open an interactive login shell on one Oven's own home directory.
 *
 * This is the "Open Oven" shell: it is not tied to a chat or a checkout, so a
 * user can reach the machine itself   inspect a service, install a harness,
 * debug SSH   without first creating a project on it. The shell is detected on
 * every open, so an Oven that is down fails here, before a PTY exists and the
 * panel can show exactly one reason.
 */
export function ovenShellLaunch(
  storage: StorageEngine,
  vault: SecretVault
): PtyOvenShellLaunchHook {
  const service = new OvenService(new OvenRegistry(storage, vault))
  return async (ovenId) => {
    const shell = await detectRemoteShell(service.ssh, ovenId)
    const command = remoteTerminalCommand({
      shell,
      root: undefined,
      environment: {},
      script: undefined
    })
    const launch = await service.ssh.prepare(ovenId, command, true, undefined, true)
    return prepareOvenLaunch(storage, launch, ovenId, '~')
  }
}
