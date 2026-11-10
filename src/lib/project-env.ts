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

/** Run modes a manifest can describe. `default` is plain `.env`. */
export const PROJECT_ENV_MODES = [
  'default',
  'local',
  'development',
  'production',
  'selfhost',
  'test'
] as const

/** A run mode a manifest can describe. */
export type ProjectEnvMode = (typeof PROJECT_ENV_MODES)[number]

/**
 * Order in which the files of one directory group are applied. A later file wins,
 * which is what makes `.env.local` beat `.env` without either restating the other.
 */
export const PROJECT_ENV_MODE_ORDER: Readonly<Record<ProjectEnvMode, number>> = {
  default: 0,
  local: 10,
  development: 20,
  test: 30,
  production: 40,
  selfhost: 50
}

/** The file name a mode describes, for the UI and for import. */
export function projectEnvModeFileName(mode: ProjectEnvMode): string {
  return mode === 'default' ? '.env' : `.env.${mode}`
}

/** Parse a user-typed mode slug, refusing anything that is not one of the modes. */
export function parseProjectEnvMode(value: unknown): ProjectEnvMode | null {
  if (typeof value !== 'string') return null
  const candidate = value.trim().toLowerCase()
  return PROJECT_ENV_MODES.find((mode) => mode === candidate) ?? null
}

/** One key of a manifest: the name, and where its value lives. */
export interface ProjectEnvEntry {
  name: string
  /** Opaque vault reference; the value itself never leaves the main process. */
  secretRef: string
  updatedAt: number
  /** True when the referenced value is no longer in the vault. */
  missing?: boolean
}

/** One managed ENV file: a directory group plus a run mode. */
export interface ProjectEnvFile {
  /** Project-relative directory, '' for the project root. */
  group: string
  mode: ProjectEnvMode
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
  mode: ProjectEnvMode
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
  mode: ProjectEnvMode
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
