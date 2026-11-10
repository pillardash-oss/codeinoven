/**
 * Project-owned ENV secrets.
 *
 * A user's `.env` family belongs to the project, not to the app, and its values
 * must never sit in the repository or in an agent's context. The model here is
 * the one the app enforces on both sides of IPC:
 *
 * - A stored file is a *manifest*: a run mode plus a directory group, holding
 *   `NAME` to secret-ref pairs. It carries no values.
 * - On disk an ENV line reads `NAME=cio://<secret-ref>`, so the file is safe to
 *   commit and every value lives in the encrypted store.
 * - A launch resolves names nearest-first: thread, the deepest matching directory
 *   group, then the project root, with `default` before `local` before a named
 *   mode.
 */

/** The value prefix a managed ENV line uses instead of a plaintext value. */
export const PROJECT_ENV_REFERENCE_PREFIX = 'cio://'

/** The name a new file starts with; a user may rename it to whatever they want. */
export const DEFAULT_ENV_FILE_NAME = '.env'

/** Longest file name a managed env file may take. */
export const ENV_FILE_NAME_LIMIT = 64

const ENV_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u

/**
 * Validate the name of one managed env file.
 *
 * Any plain file name is allowed, because the name is the user's: `.env`,
 * `.env.production`, `.env.selfhost.local`, `local.env`. What is refused is
 * anything that would escape the group (a separator, a parent segment) or that a
 * filesystem cannot tell apart from its own metadata.
 */
export function validateEnvFileName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new TypeError('An env file needs a name')
  if (trimmed.length > ENV_FILE_NAME_LIMIT) {
    throw new TypeError(`An env file name must be at most ${ENV_FILE_NAME_LIMIT} characters`)
  }
  if (trimmed === '.' || trimmed === '..' || !ENV_FILE_NAME_PATTERN.test(trimmed)) {
    throw new TypeError(
      'An env file name may only use letters, digits, dots, dashes and underscores'
    )
  }
  return trimmed
}

/**
 * Order two files of one group, earliest applied first.
 *
 * `.env` is the base every other name layers on top of, and the rest follow by
 * name so the order never depends on when a file was created.
 */
export function compareEnvFileNames(left: string, right: string): number {
  if (left === DEFAULT_ENV_FILE_NAME) return right === DEFAULT_ENV_FILE_NAME ? 0 : -1
  if (right === DEFAULT_ENV_FILE_NAME) return 1
  return left.localeCompare(right)
}

/** One key of a manifest: the name, and where its value lives. */ /** One key of a manifest: the name, and where its value lives. */
export interface ProjectEnvEntry {
  name: string
  /** Opaque vault reference; the value itself never leaves the main process. */
  secretRef: string
  updatedAt: number
  /** True when the referenced value is no longer in the vault. */
  missing?: boolean
}

/** One managed ENV file: a directory group plus a file name. */
export interface ProjectEnvFile {
  /** Project-relative directory, '' for the project root. */
  group: string
  /** The file name the user gave it, e.g. `.env` or `.env.production`. */
  fileName: string
  entries: ProjectEnvEntry[]
  updatedAt: number
  /** Project-relative path the values were imported from, when they were. */
  importedFrom?: string
}

/** What a launch will inject, described without any value. */
export interface ProjectEnvLaunchPreviewEntry {
  name: string
  /** Directory group that supplied the winning value, '' for the root. */
  group: string
  /** File the value came from. */
  fileName: string
  /** 'thread' when a thread-scoped entry won. */
  scope: 'project' | 'thread'
}

/** What a launch will inject, and what it refused. */
export interface ProjectEnvLaunchPreview {
  entries: ProjectEnvLaunchPreviewEntry[]
  skipped: { name: string; reason: string }[]
}

/** One key as the editor sees it, with the source that wins for this directory. */
export interface ProjectEnvEditorState {
  projectId: string
  files: ProjectEnvFile[]
  /** Every value referenced by this project is present in the vault. */
  allResolved: boolean
}

/** A secret-free description of what an import would do. */
export interface ProjectEnvImportPreview {
  /** Project-relative file being imported. */
  path: string
  /** Keys found in the file, in file order. */
  names: string[]
  /** Keys that would create a new secret, versus rotate an existing one. */
  created: string[]
  replaced: string[]
  /**
   * The shape the managed file takes, with placeholder refs: real references are
   * only assigned when the import is applied, because that is when the values are
   * encrypted and stored.
   */
  rewritten: string
  /** Lines the parser ignored, so the user can see nothing was invented. */
  skipped: { line: number; reason: string }[]
}

/** Result of an import, previewed or applied. */
export interface ProjectEnvImportResult {
  preview: ProjectEnvImportPreview
  files: ProjectEnvFile[]
  /** Where the untouched original was kept, when the import was applied. */
  backupPath?: string
}

/** A request that names one managed env file. */
export interface ProjectEnvFileRequest {
  projectId: string
  group: string
  fileName: string
}

/** A request that writes one key of a managed env file. */
export interface ProjectEnvValueRequest extends ProjectEnvFileRequest {
  name: string
  value: string
}

/** A request that removes one key of a managed env file. */
export interface ProjectEnvEntryRequest extends ProjectEnvFileRequest {
  name: string
}

/** A request that replaces one managed file with the lines of a `.env` body. */
export interface ProjectEnvApplyTextRequest extends ProjectEnvFileRequest {
  /** The whole file body, as the user typed it. */
  text: string
}

/** What one bulk apply did, described without any value. */
export interface ProjectEnvApplyTextResult {
  files: ProjectEnvFile[]
  /** Keys whose value was written or replaced. */
  stored: string[]
  /** Keys left exactly as they were because their line carried no value. */
  kept: string[]
  /** Keys removed because their line is gone. */
  removed: string[]
  /** Lines that could not be used, so nothing there is guessed. */
  skipped: { line: number; reason: string }[]
}

/** A request that imports an existing plaintext env file. */
export interface ProjectEnvImportRequest extends ProjectEnvFileRequest {
  /** Project-relative path of the file. */
  path: string
  /** False previews the rewrite, true writes it. */
  apply: boolean
}

/** A request for one thread's own env entries. */
export interface ProjectEnvThreadValueRequest {
  threadId: string
  name: string
  value: string
}

/** A request that removes one entry of a thread's own env. */
export interface ProjectEnvThreadEntryRequest {
  threadId: string
  name: string
}

/** A request for what a launch would inject, and what it would skip. */
export interface ProjectEnvPreviewRequest {
  projectId: string
  /** Project-relative directory the process would start in, '' for the root. */
  directory: string
  threadId?: string
}

/** The managed reference a value line carries. */
export function projectEnvReference(secretRef: string): string {
  return `${PROJECT_ENV_REFERENCE_PREFIX}${secretRef}`
}

/** Whether a value is a managed reference rather than a plaintext value. */
export function isProjectEnvReference(value: string): boolean {
  return value.trim().startsWith(PROJECT_ENV_REFERENCE_PREFIX)
}

/** The secret ref a managed value carries, or null for a plaintext value. */
export function projectEnvReferenceTarget(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith(PROJECT_ENV_REFERENCE_PREFIX)) return null
  const ref = trimmed.slice(PROJECT_ENV_REFERENCE_PREFIX.length).trim()
  return ref.length > 0 ? ref : null
}

/** One parsed line of an ENV file. */
export type ProjectEnvLine =
  | { kind: 'blank'; text: string }
  | { kind: 'comment'; text: string }
  | { kind: 'assignment'; name: string; value: string; text: string }
  | { kind: 'invalid'; text: string; reason: string }

/**
 * Read an ENV file into lines, keeping every comment and blank line so a rewrite
 * can put the file back exactly as the user wrote it.
 */
export function parseProjectEnvFile(contents: string): ProjectEnvLine[] {
  return contents.split(/\r?\n/u).map((text): ProjectEnvLine => {
    const trimmed = text.trim()
    if (!trimmed) return { kind: 'blank', text }
    if (trimmed.startsWith('#')) return { kind: 'comment', text }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u.exec(trimmed)
    if (!match) return { kind: 'invalid', text, reason: 'Not a NAME=value line' }
    const name = match[1] ?? ''
    const rawValue = (match[2] ?? '').trim()
    return { kind: 'assignment', name, value: unquote(rawValue), text }
  })
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' || first === "'") && first === last) return value.slice(1, -1)
  }
  return value
}
