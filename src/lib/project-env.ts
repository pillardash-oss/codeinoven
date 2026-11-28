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

/**
 * The comment marker a turned-off key is written with.
 *
 * A key the user does not want injected but does want to keep is commented out as
 * `#cio-cmt NAME=value`. The marker is the app's own, so every other comment in a
 * file is the user's and is preserved without ever becoming a key.
 */
export const PROJECT_ENV_DISABLED_PREFIX = '#cio-cmt'

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
 * The names a new file may take, in the order they are offered.
 *
 * Each one is a name people already run with, so a second file is never a name
 * typed from scratch: `.env` is where everything starts, and the rest layer on it.
 */
export const SUGGESTED_ENV_FILE_NAMES: readonly string[] = [
  DEFAULT_ENV_FILE_NAME,
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test'
]

/**
 * True when two file names would land on the same path.
 *
 * The managed file is written into the project, and a filesystem that ignores
 * case (macOS, Windows) cannot hold `.env` and `.ENV` as two files, so two
 * manifests must never carry names that only differ in case.
 */
export function sameEnvFileName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

/** True when `name` is already one of the names taken in a directory group. */
export function isEnvFileNameTaken(taken: readonly string[], name: string): boolean {
  const wanted = name.trim()
  return taken.some((candidate) => sameEnvFileName(candidate, wanted))
}

/**
 * The first name a group does not already use.
 *
 * A dialog starts here, so pressing Create twice never targets a file that is
 * already there: `.env` when the path is empty, then `.env.local`, then the rest
 * of the suggested names, then `.env.2`, `.env.3` and so on.
 */
export function suggestEnvFileName(taken: readonly string[]): string {
  for (const candidate of SUGGESTED_ENV_FILE_NAMES) {
    if (!isEnvFileNameTaken(taken, candidate)) return candidate
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${DEFAULT_ENV_FILE_NAME}.${index}`
    if (!isEnvFileNameTaken(taken, candidate)) return candidate
  }
  throw new Error('This directory already holds too many env files')
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
  /**
   * True when the key is kept but turned off: its value stays stored, and no
   * process started from this project receives it.
   */
  disabled?: boolean
}

/** What writing a managed file into the project changed. */
export interface ProjectEnvWriteResult {
  /** Project-relative path that was written. */
  path: string
  /** Where the previous content was kept, when there was any. */
  backupPath?: string
  /** False when the file already held exactly these references. */
  changed: boolean
}

/** Longest inject rule body one env file may carry, in characters. */
export const ENV_INJECT_RULE_TEXT_LIMIT = 8_192

/**
 * The commands an inject rule names, one per line, blanks and comments dropped.
 *
 * The rule is stored as its lines rather than as the typed body, so the stored
 * shape never depends on trailing whitespace or a blank line at the end of a
 * textarea, and a future launch check can compare commands directly.
 */
export function normalizeInjectRuleLines(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

/** One managed ENV file: a directory group plus a file name. */
export interface ProjectEnvFile {
  /** Project-relative directory, '' for the project root. */
  group: string
  /** The file name the user gave it, e.g. `.env` or `.env.production`. */
  fileName: string
  entries: ProjectEnvEntry[]
  updatedAt: number
  /**
   * The commands this file's keys may be injected into, one per line.
   *
   * Empty means the file is not limited to any command, which is how every file
   * behaves until its owner writes a rule.
   */
  injectRule?: string[]
  /** Project-relative path the values were imported from, when they were. */
  importedFrom?: string
  /** Project-relative path this file was last written to in the repository. */
  writtenTo?: string
  /**
   * The file's own line ordering, so the editor can show it again.
   *
   * A manifest holds names, not a body, so the comments and blank lines a user wrote
   * would otherwise be gone the next time the file is opened. Absent means the file
   * has no layout yet and its keys are simply listed.
   */
  layout?: ProjectEnvLayoutLine[]
}

/**
 * One line of a stored file's layout.
 *
 * Only the shape is kept: a line the app does not own keeps its text, and a key
 * keeps its place by name. Values live in the vault, so a layout is value-free and
 * the store can keep a user's comments without ever holding a secret.
 */
export type ProjectEnvLayoutLine = { kind: 'text'; text: string } | { kind: 'key'; name: string }

/** What one key of a file stands for while the text is being rebuilt. */
export interface ProjectEnvKeyInput {
  name: string
  value: string
  disabled?: boolean
}

/** What rebuilding a file's text has to know about one stored key. */
export interface ProjectEnvTextKey {
  name: string
  disabled?: boolean
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

/** What a launch will inject, what it turned off, and what it refused. */
export interface ProjectEnvLaunchPreview {
  entries: ProjectEnvLaunchPreviewEntry[]
  /** Keys a file keeps but switched off, so they are never injected. */
  disabled: ProjectEnvLaunchPreviewEntry[]
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

/** A request that turns one key on or off without losing its value. */
export interface ProjectEnvEntryToggleRequest extends ProjectEnvEntryRequest {
  disabled: boolean
}

/** A request that replaces the commands one managed env file is limited to. */
export interface ProjectEnvInjectRuleRequest extends ProjectEnvFileRequest {
  /** The scripts, one per line, as the rule editor holds them. */
  text: string
}

/** A request that replaces one managed file with the lines of a `.env` body. */
export interface ProjectEnvApplyTextRequest extends ProjectEnvFileRequest {
  /** The whole file body, as the user typed it. */
  text: string
  /**
   * Names whose line the user did not touch. Their stored value is kept as it is
   * instead of being encrypted again, so opening a file and saving it costs
   * nothing and cannot rotate a value by accident.
   */
  keep?: readonly string[]
}

/** One stored value, handed to the app's own editor so the user can see it again. */
export interface ProjectEnvValueEntry {
  name: string
  /** The decrypted value, or null when the vault no longer holds it. */
  value: string | null
}

/**
 * Every value of one managed file.
 *
 * This shape is only ever produced for the app's own env editor: it is the one
 * place a stored value is shown back to the person who stored it, and the channel
 * that returns it is deliberately unreachable for an agent.
 */
export interface ProjectEnvValues {
  group: string
  fileName: string
  entries: ProjectEnvValueEntry[]
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

/**
 * The directory groups an action script runs in.
 *
 * An action launches at the project root, but a monorepo script almost always
 * `cd`s into a package (or is the only package there is), and that package's env
 * file is what its process needs. The root group is applied by the caller, so only
 * the package groups the script reaches are returned, in the order it reaches them.
 */
export function actionEnvironmentDirectories(script: string, groups: readonly string[]): string[] {
  const candidates = [...new Set(groups.filter((group) => group.length > 0))]
  if (candidates.length === 0) return []
  const mentioned = new Set<string>()
  for (const line of script.split(/\r?\n/u)) {
    for (const match of line.matchAll(/\bcd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gu)) {
      const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim().replace(/\/+$/u, '')
      if (!raw || raw === '.' || raw === '..') continue
      if (raw.startsWith('~') || raw.startsWith('/') || raw.startsWith('$')) continue
      const target = raw.replace(/^\.\//u, '')
      const group = candidates.find(
        (candidate) =>
          candidate === target ||
          target.startsWith(`${candidate}/`) ||
          candidate.startsWith(`${target}/`)
      )
      if (group) mentioned.add(group)
    }
  }
  if (mentioned.size > 0) return [...mentioned]
  // A project with one env group has one package to run, so its group applies even
  // when the script never spells the path out.
  return candidates.length === 1 ? candidates : []
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
  | { kind: 'assignment'; name: string; value: string; text: string; disabled: boolean }
  | { kind: 'invalid'; text: string; reason: string }

/**
 * Read an ENV file into lines, keeping every comment and blank line so a rewrite
 * can put the file back exactly as the user wrote it.
 *
 * A line commented with the app's own marker is an assignment that is turned off,
 * not a comment: the key stays in the file and keeps its value, and a launch skips
 * it. Every other comment is preserved untouched and never becomes a key.
 */
export function parseProjectEnvFile(contents: string): ProjectEnvLine[] {
  return contents.split(/\r?\n/u).map((text): ProjectEnvLine => {
    const trimmed = text.trim()
    if (!trimmed) return { kind: 'blank', text }
    if (trimmed.startsWith('#')) {
      const body = trimmed.slice(PROJECT_ENV_DISABLED_PREFIX.length)
      // The marker is a word, so `#cio-cmt-notes` and `#cio-cmtx` stay comments.
      if (trimmed.startsWith(PROJECT_ENV_DISABLED_PREFIX) && /^\s/u.test(body)) {
        const turnedOff = parseAssignment(body.trim())
        if (turnedOff) return { kind: 'assignment', ...turnedOff, text, disabled: true }
      }
      return { kind: 'comment', text }
    }
    const assignment = parseAssignment(trimmed)
    if (!assignment) return { kind: 'invalid', text, reason: 'Not a NAME=value line' }
    return { kind: 'assignment', ...assignment, text, disabled: false }
  })
}

function appendEnvLines(lines: string[], appended: readonly string[]): string {
  if (appended.length === 0) return lines.join('\n')
  // New keys go after the file's last real line, not below a blank tail.
  let at = lines.length
  while (at > 0 && (lines[at - 1] ?? '').trim().length === 0) at -= 1
  lines.splice(at, 0, ...appended)
  return lines.join('\n')
}

/**
 * The layout of a body: its own lines, with each key reduced to its name and place.
 *
 * This is what the store keeps instead of the body. It holds no value, so saving a
 * file with a comment in it stays as value-free as saving one without.
 */
export function projectEnvLayout(contents: string): ProjectEnvLayoutLine[] {
  return parseProjectEnvFile(contents).map((line) =>
    line.kind === 'assignment'
      ? { kind: 'key', name: line.name }
      : { kind: 'text', text: line.text }
  )
}

/**
 * Render a stored file back into the body the editor shows.
 *
 * The layout decides the order and keeps every comment and blank line its owner
 * wrote, and each key line is filled with the value the vault holds for that name. A
 * key added since the last save is appended, and a layout key whose entry is gone is
 * dropped, so the file never declares something the manifest does not hold.
 */
export function projectEnvFileText(
  file: { layout?: readonly ProjectEnvLayoutLine[]; entries: readonly ProjectEnvTextKey[] },
  values: ReadonlyMap<string, string | null>
): string {
  const lines: string[] = []
  const written = new Set<string>()
  const byName = new Map(file.entries.map((entry) => [entry.name, entry]))
  for (const line of file.layout ?? []) {
    if (line.kind === 'text') {
      lines.push(line.text)
      continue
    }
    const entry = byName.get(line.name)
    // The entry's own name is written, never the layout's, so a stored manifest can
    // never put a line in the file that it does not actually hold as a key.
    if (!entry || written.has(entry.name)) continue
    written.add(entry.name)
    lines.push(
      formatProjectEnvLine(entry.name, values.get(entry.name) ?? '', entry.disabled === true)
    )
  }
  const appended = file.entries
    .filter((entry) => !written.has(entry.name))
    .map((entry) =>
      formatProjectEnvLine(entry.name, values.get(entry.name) ?? '', entry.disabled === true)
    )
  return appendEnvLines(lines, appended)
}

/**
 * Write key rows into a body, keeping every line the rows do not own.
 *
 * Comments, blank lines and lines that cannot be read belong to the user, so they
 * stay exactly where they are and a save no longer drops them. A row takes the place
 * of the line that declared its name, a name no row holds loses its line, and a new
 * key is appended after the last line the file already has.
 */
export function mergeProjectEnvRows(contents: string, rows: readonly ProjectEnvKeyInput[]): string {
  const pending = new Map<string, ProjectEnvKeyInput>()
  for (const row of rows) {
    const name = row.name.trim()
    if (!name || pending.has(name)) continue
    pending.set(name, { name, value: row.value, disabled: row.disabled === true })
  }
  const lines: string[] = []
  const written = new Set<string>()
  for (const line of parseProjectEnvFile(contents)) {
    if (line.kind !== 'assignment') {
      lines.push(line.text)
      continue
    }
    const row = pending.get(line.name)
    // A name no row holds any more was removed; a name the file declared twice is
    // one key, so only its first line keeps the slot.
    if (!row || written.has(line.name)) continue
    written.add(line.name)
    lines.push(formatProjectEnvLine(row.name, row.value, row.disabled === true))
  }
  const appended = [...pending.values()]
    .filter((row) => !written.has(row.name))
    .map((row) => formatProjectEnvLine(row.name, row.value, row.disabled === true))
  return appendEnvLines(lines, appended)
}

/** The name and value of one `NAME=value` line, or null when the line is not one. */
function parseAssignment(body: string): { name: string; value: string } | null {
  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u.exec(body)
  if (!match) return null
  return { name: match[1] ?? '', value: unquote((match[2] ?? '').trim()) }
}

/**
 * Render one key as a line, commented out with the app's marker when it is off.
 *
 * The same line shape is used by the editor, the written project file and an
 * import, so a turned-off key survives every trip through the text form.
 */
export function formatProjectEnvLine(name: string, value: string, disabled = false): string {
  const marker = disabled ? `${PROJECT_ENV_DISABLED_PREFIX} ` : ''
  return `${marker}${name}=${formatEnvValue(value)}`
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if (first === '"' && last === '"') return unescapeUnsafeValue(value.slice(1, -1))
    if (first === "'" && last === "'") return value.slice(1, -1)
  }
  return value
}

/** Undo the escaping `formatEnvValue` applies inside double quotes. */
function unescapeUnsafeValue(value: string): string {
  return value.replace(/\\(["\\n])/gu, (_match, token: string) => (token === 'n' ? '\n' : token))
}

/**
 * Render one value as a line the file can hold.
 *
 * A value made of plain characters is written as it is. Anything else is quoted
 * and escaped, so a value with spaces, a `#`, a quote or a newline survives a round
 * trip through the editor instead of silently becoming two lines.
 */
export function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9._:/@+,-]*$/u.test(value)) return value
  const escaped = value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/\r?\n/gu, '\\n')
  return `"${escaped}"`
}
