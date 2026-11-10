import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { validateEntityId } from '../ipc/ipc-validation'
import {
  type ProjectEnvApplyTextRequest,
  type ProjectEnvEntryRequest,
  type ProjectEnvFileRequest,
  type ProjectEnvImportRequest,
  type ProjectEnvPreviewRequest,
  type ProjectEnvThreadEntryRequest,
  type ProjectEnvThreadValueRequest,
  type ProjectEnvValueRequest
} from '../../lib/project-env'
import type { ProjectEnvService } from './project-env-service'

/** Longest env key or value the editor may submit. */
const NAME_LIMIT = 128
const VALUE_LIMIT = 16_384
/** Longest env body the editor may submit: generous for a large file, bounded. */
const TEXT_LIMIT = 256 * 1024
/** Longest project-relative file path an import may name. */
const PATH_LIMIT = 1_024

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maximum) throw new TypeError(`${label} is invalid`)
  return trimmed
}

function fileRequest(value: unknown): ProjectEnvFileRequest {
  const input = record(value, 'Env file request')
  return {
    projectId: validateEntityId(input['projectId'], 'Project ID'),
    group: typeof input['group'] === 'string' ? input['group'] : '',
    // The name is the user's; the service decides what a safe file name is.
    fileName: text(input['fileName'], 'Env file name', 128)
  }
}

function valueRequest(value: unknown): ProjectEnvValueRequest {
  const input = record(value, 'Env value request')
  const raw = input['value']
  if (typeof raw !== 'string') throw new TypeError('Env value must be a string')
  if (!raw || raw.length > VALUE_LIMIT) throw new TypeError('Env value is invalid')
  return {
    ...fileRequest(input),
    name: text(input['name'], 'Env key', NAME_LIMIT),
    // Values are never trimmed: whitespace can be part of a secret.
    value: raw
  }
}

function entryRequest(value: unknown): ProjectEnvEntryRequest {
  const input = record(value, 'Env entry request')
  return { ...fileRequest(input), name: text(input['name'], 'Env key', NAME_LIMIT) }
}

function applyTextRequest(value: unknown): ProjectEnvApplyTextRequest {
  const input = record(value, 'Env file body')
  const text = input['text']
  if (typeof text !== 'string') throw new TypeError('Env file body must be a string')
  if (text.length > TEXT_LIMIT) throw new TypeError('Env file body is too large')
  return { ...fileRequest(input), text }
}

function threadValueRequest(value: unknown): ProjectEnvThreadValueRequest {
  const input = record(value, 'Thread env value request')
  const raw = input['value']
  if (typeof raw !== 'string' || !raw || raw.length > VALUE_LIMIT) {
    throw new TypeError('Env value is invalid')
  }
  return {
    threadId: validateEntityId(input['threadId'], 'Thread ID'),
    name: text(input['name'], 'Env key', NAME_LIMIT),
    value: raw
  }
}

function threadEntryRequest(value: unknown): ProjectEnvThreadEntryRequest {
  const input = record(value, 'Thread env entry request')
  return {
    threadId: validateEntityId(input['threadId'], 'Thread ID'),
    name: text(input['name'], 'Env key', NAME_LIMIT)
  }
}

function previewRequest(value: unknown): ProjectEnvPreviewRequest {
  const input = record(value, 'Env preview request')
  return {
    projectId: validateEntityId(input['projectId'], 'Project ID'),
    directory: typeof input['directory'] === 'string' ? input['directory'] : '',
    ...(input['threadId'] === undefined
      ? {}
      : { threadId: validateEntityId(input['threadId'], 'Thread ID') })
  }
}

function importRequest(value: unknown): ProjectEnvImportRequest {
  const input = record(value, 'Env import request')
  if (typeof input['apply'] !== 'boolean')
    throw new TypeError('Env import needs apply to be boolean')
  return {
    ...fileRequest(input),
    path: text(input['path'], 'Env file path', PATH_LIMIT),
    apply: input['apply']
  }
}

/**
 * The renderer boundary for project ENV secrets.
 *
 * Every mutation answers with the manifests, never with a value, so the editor
 * cannot hold state the vault does not agree with.
 */
export function registerProjectEnvIpc(service: ProjectEnvService): void {
  ipcMain.handle('secrets:envList', (_, projectId: unknown) =>
    service.listProjectEnv(validateEntityId(projectId, 'Project ID'))
  )
  ipcMain.handle('secrets:envThreadList', (_, threadId: unknown) =>
    service.listThreadEnv(validateEntityId(threadId, 'Thread ID'))
  )
  ipcMain.handle('secrets:envSetValue', (_, request: unknown) =>
    service.setProjectEnvValue(valueRequest(request))
  )
  ipcMain.handle('secrets:envRemoveEntry', (_, request: unknown) =>
    service.removeProjectEnvEntry(entryRequest(request))
  )
  ipcMain.handle('secrets:envCreateFile', (_, request: unknown) =>
    service.createProjectEnvFile(fileRequest(request))
  )
  ipcMain.handle('secrets:envApplyText', (_, request: unknown) =>
    service.applyEnvText(applyTextRequest(request))
  )
  ipcMain.handle('secrets:envDeleteFile', (_, request: unknown) =>
    service.deleteProjectEnvFile(fileRequest(request))
  )
  ipcMain.handle('secrets:envSetThreadValue', (_, request: unknown) =>
    service.setThreadEnvValue(threadValueRequest(request))
  )
  ipcMain.handle('secrets:envRemoveThreadEntry', (_, request: unknown) =>
    service.removeThreadEnvEntry(threadEntryRequest(request))
  )
  ipcMain.handle('secrets:envPreview', async (_, request: unknown) => {
    const input = previewRequest(request)
    const projectPath = await service.projectPath(input.projectId)
    return service.previewLaunch({
      projectId: input.projectId,
      cwd: projectPath ? joinDirectory(projectPath, input.directory) : '',
      ...(input.threadId ? { threadId: input.threadId } : {})
    })
  })
  ipcMain.handle('secrets:envImport', (_, request: unknown) =>
    service.importProjectEnv(importRequest(request))
  )
}

function joinDirectory(projectPath: string, directory: string): string {
  const cleaned = directory
    .trim()
    .replace(/\\/gu, '/')
    .replace(/^\/+|\/+$/gu, '')
  if (!cleaned) return projectPath
  return `${projectPath.replace(/\/+$/u, '')}/${cleaned}`
}
