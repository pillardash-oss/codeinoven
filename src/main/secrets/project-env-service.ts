import { chmod, readFile, writeFile } from 'fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'path'
import {
  compareEnvFileNames,
  parseProjectEnvFile,
  projectEnvReference,
  validateEnvFileName,
  type ProjectEnvApplyTextResult,
  type ProjectEnvEntry,
  type ProjectEnvFile,
  type ProjectEnvImportResult,
  type ProjectEnvLaunchPreview,
  type ProjectEnvLaunchPreviewEntry
} from '../../lib/project-env'
import { validateProcessEnvironmentVariable } from '../../lib/secret-names'
import { Logger } from '../system/logger'
import type {
  ProjectEnvStore,
  StoredProjectEnvEntry,
  StoredProjectEnvFile
} from './project-env-store'
import type { SecretsService } from './secrets-service'

/** Longest value a project ENV secret may hold. */
const VALUE_LIMIT = 16_384
/** File mode for a written ENV file or its backup: owner-only. */
const SECRET_FILE_MODE = 0o600

/** The vault operations a project env needs; the secret service satisfies it. */
export type ProjectEnvSecretsPort = Pick<SecretsService, 'save' | 'resolve' | 'exists' | 'remove'>

export interface ProjectEnvServiceDependencies {
  store: ProjectEnvStore
  secrets: ProjectEnvSecretsPort
  /** Absolute path of a project, or null when it is not a local project. */
  resolveProjectPath: (projectId: string) => Promise<string | null>
}

export interface SetEnvValueInput {
  projectId: string
  group: string
  fileName: string
  name: string
  value: string
}

export interface EnvFileKeyInput {
  projectId: string
  group: string
  fileName: string
}

export interface ApplyEnvTextInput extends EnvFileKeyInput {
  /** The whole file body, as the user typed it. */
  text: string
}

export interface ImportEnvInput extends EnvFileKeyInput {
  /** Project-relative path of the file to import. */
  path: string
  /** Apply the rewrite; false only previews it. */
  apply: boolean
}

export interface LaunchEnvironmentContext {
  projectId: string
  threadId?: string
  /** Absolute working directory the process will start in. */
  cwd: string
  /**
   * Project-relative directory the process was started for, when the caller knows
   * it. A managed worktree scope has a cwd outside the project directory, so this
   * is what keeps a package group matching there.
   */
  directory?: string
}

export interface LaunchEnvironment {
  environment: Record<string, string>
  preview: ProjectEnvLaunchPreview
}

/**
 * Project-owned ENV secrets: the env files a user keeps for a project, held in the
 * encrypted store and injected into the processes the app starts.
 *
 * Everything here is manifest-shaped. A file is a directory group, a file name the
 * user chose, and the names it declares with the vault ref holding each value. A
 * launch resolves the winning value for each name and hands the values to the
 * process environment only. No method on this service returns a value to the
 * renderer.
 */
export class ProjectEnvService {
  constructor(private readonly dependencies: ProjectEnvServiceDependencies) {}

  /** Absolute path of a project, or null when it has no local files. */
  async projectPath(projectId: string): Promise<string | null> {
    return this.dependencies.resolveProjectPath(projectId).catch(() => null)
  }

  /** Every file of one project, root first, then by name. */
  async listProjectEnv(projectId: string): Promise<ProjectEnvFile[]> {
    const files = await this.dependencies.store.readProject(projectId)
    return Promise.all(sortFiles(files).map((file) => this.describeFile(file)))
  }

  /** One thread's own overrides, which win over every project file. */
  async listThreadEnv(threadId: string): Promise<ProjectEnvEntry[]> {
    const entries = await this.dependencies.store.readThread(threadId)
    return Promise.all(sortEntries(entries).map((entry) => this.describeEntry(entry)))
  }

  /** Backwards-compatible name used by the import dialog's preview shape. */
  async setProjectEnvValue(input: SetEnvValueInput): Promise<ProjectEnvFile[]> {
    const name = validateProcessEnvironmentVariable(input.name)
    const value = requireValue(input.value)
    const group = normalizeGroup(input.group)
    const fileName = validateEnvFileName(input.fileName)
    const files = await this.dependencies.store.readProject(input.projectId)
    const file = requireFile(files, group, fileName)
    const existing = file.entries.find((entry) => entry.name === name)
    const secretRef = await this.dependencies.secrets.save(value, existing?.secretRef, {
      scope: 'project-env',
      ownerId: input.projectId,
      label: `${group || '.'} · ${fileName} · ${name}`
    })
    upsertEntry(file, { name, secretRef, updatedAt: Date.now() })
    await this.dependencies.store.writeProject(input.projectId, files)
    return this.listProjectEnv(input.projectId)
  }

  async removeProjectEnvEntry(
    input: EnvFileKeyInput & { name: string }
  ): Promise<ProjectEnvFile[]> {
    const group = normalizeGroup(input.group)
    const fileName = validateEnvFileName(input.fileName)
    const files = await this.dependencies.store.readProject(input.projectId)
    const file = requireFile(files, group, fileName)
    const entry = file.entries.find((candidate) => candidate.name === input.name)
    file.entries = file.entries.filter((candidate) => candidate.name !== input.name)
    file.updatedAt = Date.now()
    await this.dependencies.store.writeProject(input.projectId, files)
    if (entry) await this.dropRefIfUnused(input.projectId, entry.secretRef)
    return this.listProjectEnv(input.projectId)
  }

  /**
   * Replace one managed file with the lines of a typed body.
   *
   * The body is the file: a line with a value writes that value, a line without one
   * keeps whatever is stored for that name, a name whose line is gone is removed, and
   * a line that cannot be used is reported rather than guessed. A file that does not
   * exist yet is created by this call, so an editor can start from an empty body.
   */
  async applyEnvText(input: ApplyEnvTextInput): Promise<ProjectEnvApplyTextResult> {
    const group = normalizeGroup(input.group)
    const fileName = validateEnvFileName(input.fileName)
    const files = await this.dependencies.store.readProject(input.projectId)
    let file = files.find(
      (candidate) => candidate.group === group && candidate.fileName === fileName
    )
    const lines = parseProjectEnvFile(input.text)
    const skipped: { line: number; reason: string }[] = []
    const typed = new Map<string, { value: string | null; line: number }>()

    for (const [index, line] of lines.entries()) {
      if (line.kind === 'blank' || line.kind === 'comment') continue
      if (line.kind === 'invalid') {
        skipped.push({ line: index + 1, reason: line.reason })
        continue
      }
      let name: string
      try {
        name = validateProcessEnvironmentVariable(line.name)
      } catch (error) {
        skipped.push({
          line: index + 1,
          reason: error instanceof Error ? error.message : 'Name is not allowed'
        })
        continue
      }
      typed.set(name, { value: line.value.length > 0 ? line.value : null, line: index + 1 })
    }

    if (!file) {
      if (typed.size === 0) throw new Error('Nothing to save: the file is empty')
      file = { group, fileName, entries: [], updatedAt: Date.now() }
      files.push(file)
    }

    const stored: string[] = []
    const kept: string[] = []
    for (const [name, entry] of typed) {
      const existing = file.entries.find((candidate) => candidate.name === name)
      if (entry.value === null) {
        if (existing) kept.push(name)
        else {
          skipped.push({
            line: entry.line,
            reason: `${name} has no value yet, so nothing was stored for it`
          })
        }
        continue
      }
      const secretRef = await this.dependencies.secrets.save(entry.value, existing?.secretRef, {
        scope: 'project-env',
        ownerId: input.projectId,
        label: `${group || '.'} · ${fileName} · ${name}`
      })
      upsertEntry(file, { name, secretRef, updatedAt: Date.now() })
      stored.push(name)
    }

    const removedEntries = file.entries.filter((entry) => !typed.has(entry.name))
    file.entries = file.entries.filter((entry) => typed.has(entry.name))
    file.updatedAt = Date.now()
    await this.dependencies.store.writeProject(input.projectId, files)
    for (const entry of removedEntries) {
      await this.dropRefIfUnused(input.projectId, entry.secretRef)
    }

    return {
      files: await this.listProjectEnv(input.projectId),
      stored,
      kept,
      removed: removedEntries.map((entry) => entry.name),
      skipped
    }
  }

  async createProjectEnvFile(input: EnvFileKeyInput): Promise<ProjectEnvFile[]> {
    const group = normalizeGroup(input.group)
    const fileName = validateEnvFileName(input.fileName)
    const files = await this.dependencies.store.readProject(input.projectId)
    if (!files.some((file) => file.group === group && file.fileName === fileName)) {
      files.push({ group, fileName, entries: [], updatedAt: Date.now() })
      await this.dependencies.store.writeProject(input.projectId, files)
    }
    return this.listProjectEnv(input.projectId)
  }

  async deleteProjectEnvFile(input: EnvFileKeyInput): Promise<ProjectEnvFile[]> {
    const group = normalizeGroup(input.group)
    const fileName = validateEnvFileName(input.fileName)
    const files = await this.dependencies.store.readProject(input.projectId)
    const target = files.find((file) => file.group === group && file.fileName === fileName)
    const remaining = files.filter((file) => file !== target)
    await this.dependencies.store.writeProject(input.projectId, remaining)
    for (const entry of target?.entries ?? []) {
      await this.dropRefIfUnused(input.projectId, entry.secretRef)
    }
    return this.listProjectEnv(input.projectId)
  }

  async setThreadEnvValue(input: {
    threadId: string
    name: string
    value: string
  }): Promise<ProjectEnvEntry[]> {
    const name = validateProcessEnvironmentVariable(input.name)
    const value = requireValue(input.value)
    const entries = await this.dependencies.store.readThread(input.threadId)
    const existing = entries.find((entry) => entry.name === name)
    const secretRef = await this.dependencies.secrets.save(value, existing?.secretRef, {
      scope: 'project-env',
      ownerId: input.threadId,
      label: `thread · ${name}`
    })
    const next = entries.filter((entry) => entry.name !== name)
    next.push({ name, secretRef, updatedAt: Date.now() })
    await this.dependencies.store.writeThread(input.threadId, next)
    return this.listThreadEnv(input.threadId)
  }

  async removeThreadEnvEntry(input: {
    threadId: string
    name: string
  }): Promise<ProjectEnvEntry[]> {
    const entries = await this.dependencies.store.readThread(input.threadId)
    const entry = entries.find((candidate) => candidate.name === input.name)
    await this.dependencies.store.writeThread(
      input.threadId,
      entries.filter((candidate) => candidate.name !== input.name)
    )
    if (entry) await this.dependencies.secrets.remove(entry.secretRef).catch(() => undefined)
    return this.listThreadEnv(input.threadId)
  }

  /**
   * Import an existing plaintext env file.
   *
   * Preview is the default: the caller receives the rewritten file and what would
   * happen to each key, and nothing is written. Applying writes a 0600 backup of the
   * original beside it, rewrites every value to `cio://<ref>`, and records the
   * manifest.
   */
  async importProjectEnv(input: ImportEnvInput): Promise<ProjectEnvImportResult> {
    const projectRoot = await this.requireProjectPath(input.projectId)
    const absolute = resolveProjectFile(projectRoot, input.path)
    const contents = await readFile(absolute, 'utf8')
    const group = normalizeGroup(input.group)
    const fileName = validateEnvFileName(input.fileName)
    const files = await this.dependencies.store.readProject(input.projectId)
    const file = requireFile(files, group, fileName)

    const lines = parseProjectEnvFile(contents)
    const skipped: { line: number; reason: string }[] = []
    const names: string[] = []
    const created: string[] = []
    const replaced: string[] = []
    const plan: { name: string; value: string }[] = []

    for (const [index, line] of lines.entries()) {
      if (line.kind === 'invalid') {
        skipped.push({ line: index + 1, reason: line.reason })
        continue
      }
      if (line.kind !== 'assignment') continue
      let name: string
      try {
        name = validateProcessEnvironmentVariable(line.name)
      } catch (error) {
        skipped.push({
          line: index + 1,
          reason: error instanceof Error ? error.message : 'Name is not allowed'
        })
        continue
      }
      if (!line.value) {
        skipped.push({ line: index + 1, reason: 'Line carries no value' })
        continue
      }
      if (file.entries.some((entry) => entry.name === name)) replaced.push(name)
      else created.push(name)
      names.push(name)
      plan.push({ name, value: line.value })
    }

    if (!input.apply) {
      return {
        preview: {
          path: input.path,
          names,
          created,
          replaced,
          // The preview cannot name a ref that does not exist yet, so it shows the
          // shape the line will take; the applied write uses the real refs.
          rewritten: buildRewrittenFile(
            lines,
            new Map(plan.map((entry) => [entry.name, placeholderRef(entry.name)]))
          ),
          skipped
        },
        files: await this.listProjectEnv(input.projectId)
      }
    }

    const references = new Map<string, string>()
    for (const entry of plan) {
      const existing = file.entries.find((candidate) => candidate.name === entry.name)
      const secretRef = await this.dependencies.secrets.save(entry.value, existing?.secretRef, {
        scope: 'project-env',
        ownerId: input.projectId,
        label: `${group || '.'} · ${fileName} · ${entry.name}`
      })
      references.set(entry.name, secretRef)
      upsertEntry(file, { name: entry.name, secretRef, updatedAt: Date.now() })
    }
    file.importedFrom = input.path
    file.updatedAt = Date.now()
    await this.dependencies.store.writeProject(input.projectId, files)

    const backupAbsolute = `${absolute}.cio-backup`
    await writePrivateFile(backupAbsolute, contents)
    const rewritten = buildRewrittenFile(lines, references)
    await writePrivateFile(absolute, rewritten)

    return {
      preview: {
        path: input.path,
        names,
        created,
        replaced,
        rewritten,
        skipped
      },
      files: await this.listProjectEnv(input.projectId),
      backupPath: `${input.path}.cio-backup`
    }
  }

  /**
   * What a launch at this working directory would inject, without any value.
   *
   * The Secrets page shows this so a shadowed or skipped name is visible before a
   * server starts and behaves unexpectedly.
   */
  async previewLaunch(context: LaunchEnvironmentContext): Promise<ProjectEnvLaunchPreview> {
    return (await this.resolveLaunch(context, false)).preview
  }

  /**
   * The environment one process gets.
   *
   * Names resolve nearest-first: a thread entry, then the deepest matching
   * directory group, then the project root, with a file later in name order
   * overriding an earlier one. A name that cannot be validated or whose value is
   * gone is skipped and reported instead of failing the launch.
   */
  async environmentForLaunch(context: LaunchEnvironmentContext): Promise<LaunchEnvironment> {
    return this.resolveLaunch(context, true)
  }

  private async resolveLaunch(
    context: LaunchEnvironmentContext,
    withValues: boolean
  ): Promise<LaunchEnvironment> {
    const projectRoot = await this.requireProjectPath(context.projectId)
    const files = await this.dependencies.store.readProject(context.projectId)
    const relativeDirectory =
      context.directory === undefined
        ? projectRelativeDirectory(projectRoot, context.cwd)
        : normalizeGroup(context.directory)

    const winners = new Map<
      string,
      {
        entry: StoredProjectEnvEntry
        group: string
        fileName: string
        scope: 'project' | 'thread'
      }
    >()
    for (const file of groupsFor(files, relativeDirectory)) {
      for (const entry of file.entries) {
        winners.set(entry.name, {
          entry,
          group: file.group,
          fileName: file.fileName,
          scope: 'project'
        })
      }
    }
    if (context.threadId) {
      for (const entry of await this.dependencies.store.readThread(context.threadId)) {
        winners.set(entry.name, {
          entry,
          group: '',
          fileName: 'this thread',
          scope: 'thread'
        })
      }
    }

    const environment: Record<string, string> = {}
    const entries: ProjectEnvLaunchPreviewEntry[] = []
    const skipped: { name: string; reason: string }[] = []

    for (const [name, winner] of winners) {
      try {
        validateProcessEnvironmentVariable(name)
      } catch (error) {
        skipped.push({
          name,
          reason: error instanceof Error ? error.message : 'Name is not allowed'
        })
        continue
      }
      try {
        const value = await this.dependencies.secrets.resolve(winner.entry.secretRef)
        if (withValues) environment[name] = value
        entries.push({
          name,
          group: winner.group,
          fileName: winner.fileName,
          scope: winner.scope
        })
      } catch (error: unknown) {
        Logger.dev(`Project env "${name}" could not be resolved:`, error)
        skipped.push({ name, reason: 'Its value is no longer stored. Set it again.' })
      }
    }

    return { environment, preview: { entries: sortPreview(entries), skipped } }
  }

  private async describeFile(file: StoredProjectEnvFile): Promise<ProjectEnvFile> {
    return {
      group: file.group,
      fileName: file.fileName,
      updatedAt: file.updatedAt,
      entries: await Promise.all(
        sortEntries(file.entries).map((entry) => this.describeEntry(entry))
      ),
      ...(file.importedFrom ? { importedFrom: file.importedFrom } : {})
    }
  }

  private async describeEntry(entry: StoredProjectEnvEntry): Promise<ProjectEnvEntry> {
    const exists = await this.dependencies.secrets.exists(entry.secretRef)
    return {
      name: entry.name,
      secretRef: entry.secretRef,
      updatedAt: entry.updatedAt,
      ...(exists ? {} : { missing: true })
    }
  }

  /** Delete a value nothing else points at, so removing a key forgets its secret. */
  private async dropRefIfUnused(projectId: string, secretRef: string): Promise<void> {
    const files = await this.dependencies.store.readProject(projectId)
    const stillUsed = files.some((file) =>
      file.entries.some((entry) => entry.secretRef === secretRef)
    )
    if (stillUsed) return
    await this.dependencies.secrets.remove(secretRef).catch((error: unknown) => {
      Logger.dev('A project env value could not be forgotten:', error)
    })
  }

  private async requireProjectPath(projectId: string): Promise<string> {
    const path = await this.dependencies.resolveProjectPath(projectId).catch(() => null)
    if (!path) throw new Error('Project files are unavailable for this project')
    return path
  }
}

function requireValue(value: string): string {
  if (!value) throw new TypeError('A secret value must not be empty')
  if (value.length > VALUE_LIMIT) throw new TypeError('A secret value is too long')
  return value
}

/** A directory group is project-relative, posix-shaped and never escapes the root. */
function normalizeGroup(group: string): string {
  const trimmed = group
    .trim()
    .replace(/\\/gu, '/')
    .replace(/^\/+|\/+$/gu, '')
  if (!trimmed) return ''
  const segments = trimmed.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) {
    throw new TypeError('An env group must be a plain project-relative directory')
  }
  return segments.join('/')
}

function requireFile(
  files: StoredProjectEnvFile[],
  group: string,
  fileName: string
): StoredProjectEnvFile {
  const file = files.find(
    (candidate) => candidate.group === group && candidate.fileName === fileName
  )
  if (!file) throw new Error('That env file no longer exists. Create it again.')
  return file
}

function upsertEntry(file: StoredProjectEnvFile, entry: StoredProjectEnvEntry): void {
  file.entries = file.entries.filter((candidate) => candidate.name !== entry.name)
  file.entries.push(entry)
  file.updatedAt = Date.now()
}

/** Root first, then deeper groups; inside a group, name order with `.env` first. */
function sortFiles(files: readonly StoredProjectEnvFile[]): StoredProjectEnvFile[] {
  return [...files].sort((left, right) => {
    const depth = groupDepth(left.group) - groupDepth(right.group)
    if (depth !== 0) return depth
    const group = left.group.localeCompare(right.group)
    if (group !== 0) return group
    return compareEnvFileNames(left.fileName, right.fileName)
  })
}

function groupDepth(group: string): number {
  return group ? group.split('/').length : 0
}

function sortEntries(entries: readonly StoredProjectEnvEntry[]): StoredProjectEnvEntry[] {
  return [...entries].sort((left, right) => left.name.localeCompare(right.name))
}

function sortPreview(entries: ProjectEnvLaunchPreviewEntry[]): ProjectEnvLaunchPreviewEntry[] {
  return entries.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Every file that applies to a working directory, in the order it is applied:
 * shallower groups first, and inside one group the name order.
 */
function groupsFor(
  files: readonly StoredProjectEnvFile[],
  relativeDirectory: string
): StoredProjectEnvFile[] {
  const applies = files.filter(
    (file) =>
      file.group === '' ||
      relativeDirectory === file.group ||
      relativeDirectory.startsWith(`${file.group}/`)
  )
  return [...applies].sort((left, right) => {
    const depth = groupDepth(left.group) - groupDepth(right.group)
    if (depth !== 0) return depth
    return compareEnvFileNames(left.fileName, right.fileName)
  })
}

/** The project-relative directory of a working directory, '' at the root. */
function projectRelativeDirectory(projectRoot: string, cwd: string): string {
  const rel = relative(projectRoot, cwd)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return ''
  return rel.split(sep).join('/')
}

function resolveProjectFile(projectRoot: string, projectRelativePath: string): string {
  const cleaned = projectRelativePath.trim()
  if (!cleaned || isAbsolute(cleaned)) throw new Error('Import a project-relative env file')
  const absolute = resolve(projectRoot, cleaned)
  if (absolute !== projectRoot && !absolute.startsWith(`${projectRoot}${sep}`)) {
    throw new Error('That env file is outside the project')
  }
  if (basename(absolute).startsWith('.cio-backup')) throw new Error('Import the env file itself')
  return absolute
}

async function writePrivateFile(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: SECRET_FILE_MODE })
  // A pre-existing file keeps its old mode, so enforce owner-only on every write.
  await chmod(path, SECRET_FILE_MODE)
}

/**
 * Put the file back exactly as the user wrote it, with every imported value
 * replaced by the reference holding it. Comments, blank lines and ordering are
 * preserved, and a line nobody imported is left byte-for-byte alone.
 */
function buildRewrittenFile(
  lines: ReturnType<typeof parseProjectEnvFile>,
  references: ReadonlyMap<string, string>
): string {
  return lines
    .map((line) => {
      if (line.kind !== 'assignment') return line.text
      const reference = references.get(line.name)
      if (!reference) return line.text
      return `${line.name}=${projectEnvReference(reference)}`
    })
    .join('\n')
}

/**
 * Placeholder ref for the preview text only.
 *
 * The preview is built before any value is stored, so it cannot name the real ref;
 * it shows the shape the file will take, which is what the user is reviewing.
 */
function placeholderRef(name: string): string {
  return `<${name.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}>`
}
