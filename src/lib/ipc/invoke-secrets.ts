import type {
  ProjectEnvApplyTextRequest,
  ProjectEnvApplyTextResult,
  ProjectEnvEntry,
  ProjectEnvFile,
  ProjectEnvFileRequest,
  ProjectEnvEntryRequest,
  ProjectEnvImportRequest,
  ProjectEnvImportResult,
  ProjectEnvLaunchPreview,
  ProjectEnvPreviewRequest,
  ProjectEnvThreadEntryRequest,
  ProjectEnvThreadValueRequest,
  ProjectEnvValueRequest
} from '../project-env'
import type { Contract } from './contract-helpers'

/**
 * Renderer boundary for the secrets a user manages.
 *
 * The boundary is one-way for values: `envSetValue` accepts a value as transient
 * input, and every reply is a manifest. No channel ever returns a stored plaintext
 * to the renderer.
 */
export const invokeSecretsContract = {
  /** Managed ENV files of one project, and one thread's own entries. */
  'secrets:envList': {} as Contract<[projectId: string], ProjectEnvFile[]>,
  'secrets:envThreadList': {} as Contract<[threadId: string], ProjectEnvEntry[]>,
  'secrets:envSetValue': {} as Contract<[request: ProjectEnvValueRequest], ProjectEnvFile[]>,
  'secrets:envRemoveEntry': {} as Contract<[request: ProjectEnvEntryRequest], ProjectEnvFile[]>,
  'secrets:envCreateFile': {} as Contract<[request: ProjectEnvFileRequest], ProjectEnvFile[]>,
  /** Replace one managed file with the lines of a typed `.env` body. */
  'secrets:envApplyText': {} as Contract<
    [request: ProjectEnvApplyTextRequest],
    ProjectEnvApplyTextResult
  >,
  'secrets:envDeleteFile': {} as Contract<[request: ProjectEnvFileRequest], ProjectEnvFile[]>,
  'secrets:envSetThreadValue': {} as Contract<
    [request: ProjectEnvThreadValueRequest],
    ProjectEnvEntry[]
  >,
  'secrets:envRemoveThreadEntry': {} as Contract<
    [request: ProjectEnvThreadEntryRequest],
    ProjectEnvEntry[]
  >,
  /** What a launch at this directory would inject, described without values. */
  'secrets:envPreview': {} as Contract<
    [request: ProjectEnvPreviewRequest],
    ProjectEnvLaunchPreview
  >,
  'secrets:envImport': {} as Contract<[request: ProjectEnvImportRequest], ProjectEnvImportResult>
}
