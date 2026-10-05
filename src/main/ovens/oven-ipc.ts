import { registerOvenRootIpc } from './oven-root-ipc'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { OvenRegistry } from './oven-registry'
import { OvenService } from './oven-service'
import { inspectOvenConnection, testDraftConnection, localOvenConnection } from './oven-connection'
import { ovenId, validateSaveOven, validateIdentityPath } from './oven-validation'
import type { StorageEngine } from '../storage/storage-engine'
import type { SecretVault } from '../storage/secret-vault'
import type { ProjectManager } from '../../lib/engines/project-manager'
import type { ProjectFilesService } from '../editor/project-files-service'
import { app } from 'electron'
import { OvenTransfers } from './oven-transfers'
import { OvenPreview } from './oven-preview'
import type { OvenTransferInput, OvenWorkspaceRequest } from '../../lib/ovens'
import type { ThreadManager } from '../../lib/engines/thread-manager'
import { LOCAL_OVEN_ID } from '../../lib/ovens'
import { isThreadBusyStatus } from '../../lib/thread-status-policy'
import { OvenSetupService } from './oven-setup-service'
import { OvenHarnessService } from './oven-harness-service'
import { createOvenSetupPorts } from './oven-setup-ports'
import { HarnessAccountRegistry } from '../providers/harness-account-registry'
import { validateOvenHarnessId, validateStartOvenSetup } from './oven-validation'

export function registerOvenIpc(
  storage: StorageEngine,
  vault: SecretVault,
  threads: ThreadManager,
  resolveImagePath: (value: unknown) => Promise<string>,
  projects: ProjectManager,
  projectFiles: ProjectFilesService,
  scopeNames: (projectId: string) => Record<string, string>
): OvenService {
  const registry = new OvenRegistry(storage, vault)
  const service = new OvenService(registry)
  const transfers = new OvenTransfers(service)
  const previews = new OvenPreview(service)
  registerOvenRootIpc({
    service,
    threads,
    projects,
    projectFiles,
    transfers,
    previews,
    scopeNames,
    authorizePath: resolveImagePath
  })

  const setupRuntime = createOvenSetupPorts({
    service,
    accounts: new HarnessAccountRegistry(storage),
    vault
  })
  const setupService = new OvenSetupService(storage, setupRuntime)
  const harnessService = new OvenHarnessService(service, storage)
  harnessService.startAutoUpdates()
  app.once('before-quit', () => harnessService.stopAutoUpdates())
  /**
   * Local is a healthy harness host but has no oven service to configure, so a
   * full setup request for it is a caller mistake rather than a user error.
   */
  const requireRemoteOven = (value: unknown): string => {
    const id = ovenId(value)
    if (id === LOCAL_OVEN_ID) throw new Error('The Local oven does not run oven setup.')
    return id
  }
  ipcMain.handle('oven:testConnection', (_event, raw: unknown) =>
    testDraftConnection(registry, validateSaveOven(raw))
  )
  ipcMain.handle('oven:connectionHealth', async (_event, raw: unknown) => {
    const id = ovenId(raw)
    if (id === LOCAL_OVEN_ID) return localOvenConnection()
    const result = await inspectOvenConnection(service.ssh, id)
    await registry.recordConnectionHealth(id, result)
    return result
  })
  app.once('before-quit', () => previews.dispose())
  ipcMain.handle('oven:state', () => registry.state())
  ipcMain.handle('oven:validateIdentity', (_event, raw: unknown) => validateIdentityPath(raw))
  ipcMain.handle('oven:save', async (_event, raw: unknown) => {
    const input = validateSaveOven(raw)
    if (input.imagePath) input.imagePath = await resolveImagePath(input.imagePath)
    if (input.connection.authentication === 'identity')
      input.connection.identityFile = await validateIdentityPath(input.connection.identityFile)
    return registry.save(input)
  })
  ipcMain.handle('oven:remove', (_event, raw: unknown) => registry.remove(ovenId(raw)))
  ipcMain.handle('oven:setDefault', (_event, raw: unknown) => registry.setDefault(ovenId(raw)))
  ipcMain.handle('oven:install', (_event, raw: unknown) => service.install(ovenId(raw)))
  ipcMain.handle('oven:probe', async (_event, raw: unknown) => {
    const id = ovenId(raw)
    try {
      return await service.probe(id)
    } catch (error) {
      // Deliver probe failures to the UI without Electron logging a rejected handler.
      return {
        ovenProbeError: error instanceof Error ? error.message : 'Could not probe this Oven.'
      }
    }
  })
  ipcMain.handle('oven:runs', (_event, raw: unknown) => service.runs(ovenId(raw)))
  ipcMain.handle('oven:workspace', (_event, raw: unknown, input: unknown) => {
    if (!input || typeof input !== 'object' || JSON.stringify(input).length > 512 * 1024)
      throw new Error('Invalid workspace request.')
    return service.workspace(ovenId(raw), input as OvenWorkspaceRequest)
  })
  ipcMain.handle('oven:reviewTransfer', (_event, raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('Transfer settings are required.')
    const input = raw as OvenTransferInput
    for (const path of [input.sourceRoot, input.targetRoot])
      if (typeof path !== 'string' || path.length > 4096 || /[\0\r\n]/u.test(path))
        throw new Error('Invalid transfer path.')
    return transfers.review({
      ...input,
      sourceOvenId: ovenId(input.sourceOvenId),
      targetOvenId: ovenId(input.targetOvenId)
    })
  })
  ipcMain.handle('oven:transfer', (_event, raw: unknown) => transfers.execute(ovenId(raw)))
  ipcMain.handle('oven:previewPort', (_event, raw: unknown, port: unknown) => {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('Choose a valid server port.')
    return previews.openPort(ovenId(raw), port)
  })
  ipcMain.handle('oven:preview', (_event, raw: unknown, root: unknown) => {
    if (typeof root !== 'string' || root.length > 4096)
      throw new Error('Invalid preview directory.')
    return previews.open(ovenId(raw), root)
  })
  ipcMain.handle(
    'oven:selectThread',
    async (_event, project: unknown, threadId: unknown, raw: unknown, path: unknown) => {
      const projectId = ovenId(project)
      const id = ovenId(threadId)
      const oven = ovenId(raw)
      if (
        path !== undefined &&
        (typeof path !== 'string' || path.length > 4096 || /[\0\r\n]/u.test(path))
      )
        throw new Error('Invalid Oven workspace.')
      const thread = await threads.getThread(projectId, id)
      if (!thread?.settings) throw new Error('This thread is not ready for an Oven selection.')
      if (isThreadBusyStatus(thread.status))
        throw new Error('Stop or finish the active turn before changing Ovens.')
      const binding = await storage.read<{ finished: boolean; ovenId: string; runId: string }>(
        `ovens/threads/${projectId}/${id}.json`
      )
      if (binding && !binding.finished) {
        try {
          if ((await service.events(binding.ovenId, binding.runId, 0)).run.status === 'running')
            throw new Error(
              'The Oven is still working on this chat. Finish or stop its turn first.'
            )
        } catch (error) {
          if (!(error instanceof Error && error.message === 'The remote run does not exist.'))
            throw error
        }
      }
      if (oven !== LOCAL_OVEN_ID) await registry.require(oven)
      await threads.clearSessionId(projectId, id)
      return threads.updateSettings(projectId, id, {
        ...thread.settings,
        ovenId: oven,
        ovenPath:
          oven === LOCAL_OVEN_ID
            ? undefined
            : typeof path === 'string' && path.trim()
              ? path.trim()
              : undefined
      })
    }
  )
  ipcMain.handle('oven:setup:preflight', (_event, rawId: unknown) =>
    setupService.preflight(requireRemoteOven(rawId))
  )
  ipcMain.handle('oven:setup:start', async (_event, rawId: unknown, rawInput: unknown) => {
    const id = requireRemoteOven(rawId)
    const configuration = await validateStartOvenSetup(rawInput, vault)
    return setupService.startSetup(id, configuration)
  })
  ipcMain.handle('oven:setup:status', (_event, rawId: unknown) =>
    setupService.getOperationForOven(requireRemoteOven(rawId))
  )
  ipcMain.handle('oven:setup:progress', (_event, rawId: unknown, after: unknown) =>
    setupService.progress(
      requireRemoteOven(rawId),
      typeof after === 'number' && Number.isSafeInteger(after) && after >= 0 ? after : 0
    )
  )
  ipcMain.handle('oven:setup:cancel', (_event, rawId: unknown) =>
    setupService.cancelSetup(requireRemoteOven(rawId))
  )
  ipcMain.handle('oven:setup:retry', (_event, rawId: unknown) =>
    setupService.retrySetup(requireRemoteOven(rawId))
  )
  ipcMain.handle('oven:setup:gitVerify', async (_event, rawId: unknown) => {
    const id = requireRemoteOven(rawId)
    const report = await setupRuntime.preflight(id)
    return setupRuntime.gitIdentity.verify(id, report)
  })
  ipcMain.handle('oven:harness:inventory', (_event, rawId: unknown) =>
    harnessService.getInventory(ovenId(rawId))
  )
  ipcMain.handle('oven:harness:update', (_event, rawId: unknown, rawHarnessId: unknown) =>
    harnessService.updateHarness(ovenId(rawId), validateOvenHarnessId(rawHarnessId))
  )
  ipcMain.handle('oven:harness:uninstall', (_event, rawId: unknown, rawHarnessId: unknown) =>
    harnessService.uninstallHarness(ovenId(rawId), validateOvenHarnessId(rawHarnessId))
  )
  return service
}
