import { mkdir } from 'node:fs/promises'
import type { Database } from '../database/database'
import { ProjectRepo } from '../database/repositories/project-repo'
import { resolveOvenThreadRoot } from './oven-thread-root'
import { ThreadRepo } from '../database/repositories/thread-repo'
import type { StorageEngine } from '../storage/storage-engine'
import type { SecretVault } from '../storage/secret-vault'
import type { PtyRemoteLaunchHook } from '../system/pty-service'
import { HarnessAccountRegistry } from '../providers/harness-account-registry'
import { OvenRegistry } from './oven-registry'
import { OvenService } from './oven-service'
import { syncOvenAccount } from './oven-accounts'
import { remoteShell } from './oven-remote-shell'
import { remoteTerminalCommand } from './oven-remote-command'

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
    const command = remoteTerminalCommand({
      shell: await remoteShell(service.ssh, ovenId),
      root: root || undefined,
      environment,
      script
    })
    const launch = await service.ssh.prepare(ovenId, command, script === undefined, undefined, true)
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
        remoteCwd: root || '~',
        dispose: launch.dispose
      }
    } catch (error) {
      await launch.dispose()
      throw error
    }
  }
}
