import { join } from 'path'
import { randomInt } from 'crypto'
import { readFile, appendFile, unlink, open, type FileHandle } from 'fs/promises'
import {
  getConfigRoot,
  ensureDir,
  readJson,
  writeJson,
  listDir,
  listDirectories,
  removeDir,
  atomicWrite,
  resolveWithinRoot
} from '../../lib/utils'
import type { AppConfig, HeartbeatConfig, VisionModelRecord } from '../../lib/types'
import { DEFAULT_MAX_CONFLICT_FILE_BYTES, DEFAULT_IN_APP_NOTIFICATION_SOUND } from '../../lib/types'
import { AGENT_BEHAVIOR_FILENAME, DEFAULT_AGENT_BEHAVIOR_PROMPT } from '../../lib/agent-behavior'
import { DEFAULT_WORK_ROOTS, workRootsFromConfig } from '../../lib/design/work-roots'
import {
  CIO_PROMPT_DEFINITIONS,
  CIO_PROMPT_MAX_LENGTH,
  CIO_PROMPTS_DIRECTORY,
  defaultCioPrompt,
  getCioPromptDefinition,
  renderCioPromptTemplate,
  type CioPromptId,
  type CioPromptSetting
} from '../../lib/cio-prompts'
import type { CloudDeploymentAccountRegistry, CloudDeploymentConfig } from '../../lib/types'
import type { Project } from '../../lib/types'
import {
  ASSISTANT_CWD_DIR,
  CHATS_ARTIFACTS_DIRECTORY,
  CHATS_CWD_DIR,
  featureArtifactDirectory,
  featureSlugFromTitle
} from '../../lib/project-artifacts'
import {
  CUSTOM_WORKER_NAMES_FILE,
  DEFAULT_WORKER_NAMES,
  FALLBACK_WORKER_NAMES,
  MINIMUM_WORKER_NAME_COUNT,
  WORKER_NAMES_FILE,
  normalizeWorkerNames
} from '../../lib/assignment/worker-names'
import type { WorkerNameSettings } from '../../lib/assignment/worker-names'
import { DEFAULT_PROTOTYPE_CDN_ENABLED } from '../../lib/prototypes/prototype-cdn'
import { MAX_DESIGN_ASSIGNMENTS, isUsableDesignAssignment } from '../../lib/design-assignments'
import { DEFAULT_SPEECH_SETTINGS } from '../../lib/speech/types'
import { normalizeVisionModelId, visionModelRecordMatches } from '../../lib/image-descriptor'

const DEFAULT_CONFIG: AppConfig = {
  theme: 'system',
  fontFamily: 'jetbrains-mono',
  appFontSize: 15,
  fontWeight: 200,
  zoomLevel: 1,
  onboardingCompleted: false,
  threadLimit: 70,
  questionTimeoutMs: 300_000,
  agentQuestionCap: 3,
  keybindings: {},
  slashCommandMode: 'app',
  preferredEditor: 'system',
  memory: { enabled: true, chatEnabled: true, entries: [] },
  agentDefaults: { syncFromThreadChanges: false },
  auxiliaryAgents: {},
  design: { assignments: [] },
  workRoots: { ...DEFAULT_WORK_ROOTS },
  mediaGeneration: { providerId: null },
  rankingJudge: { kind: 'automatic' },
  agentBehaviorPrompt: DEFAULT_AGENT_BEHAVIOR_PROMPT,
  autoDownloadUpdates: true,
  autoInstallUpdates: true,
  updateChannel: 'stable',
  keepAwakeWhileWorking: false,
  imageDescriptorAskAgain: false,
  autoRetryAfterReset: true,
  resumeWorkOnRestart: true,
  defaultMergeMethod: 'squash',
  defaultPullStrategy: 'ask',
  maxDiffLines: 100,
  maxConflictFileBytes: DEFAULT_MAX_CONFLICT_FILE_BYTES,
  openLocalhostInCioBrowser: true,
  openAllLinksInCioBrowser: false,
  allowPrototypeExternalCdn: DEFAULT_PROTOTYPE_CDN_ENABLED,
  prototypeCdnAllowlist: [],
  inAppNotificationSound: { ...DEFAULT_IN_APP_NOTIFICATION_SOUND },
  sound: DEFAULT_SPEECH_SETTINGS
}

/**
 * StorageEngine   manages all filesystem persistence under ~/.config/pillardash/codeinoven/
 * All writes are atomic (write .tmp then rename).
 */
const HEARTBEATS_FILE = 'heartbeat/heartbeats.json'
const VISION_MODELS_FILE = 'vision-models.json'

/** Result of an incremental, byte-offset tail read of an append-only log. */
export interface RawFileTail {
  /** Complete lines after `fromByte`, decoded UTF-8. Empty when none yet. */
  content: string
  /** Byte offset to pass to the next call. */
  nextByte: number
  /** Current file size in bytes. */
  size: number
}

export class StorageEngine {
  private root: string
  private readonly allowOrphanProjectArtifacts: boolean
  /**
   * Per-file append chains. `appendRaw` is called fire-and-forget from hot
   * stream paths (every working-trace event persists one line), so without a
   * queue the callers' appends race: each one awaits `ensureDir` and then
   * `appendFile`, and libuv's threadpool decides which write lands first, not
   * the call order. That shuffled the durable append-only logs line by line and
   * made the streamed working trace render scrambled reasoning. Entries are
   * dropped as soon as their chain drains, so an idle file holds no queue.
   */
  private readonly appendQueues = new Map<string, Promise<void>>()

  constructor(rootPath?: string) {
    this.root = rootPath ?? getConfigRoot()
    this.allowOrphanProjectArtifacts = rootPath !== undefined
  }

  /** Initialize the directory structure */
  async initialize(): Promise<void> {
    await ensureDir(this.root)
    await ensureDir(this.resolve('projects'))
    await ensureDir(this.resolve('projects-gh'))
    await ensureDir(this.resolve('workflows'))
    await ensureDir(this.resolve('blobs'))
    await ensureDir(this.resolve('logs'))
    await ensureDir(this.resolve(CHATS_CWD_DIR))
    await ensureDir(this.resolve(ASSISTANT_CWD_DIR))
    await ensureDir(this.resolve(CHATS_ARTIFACTS_DIRECTORY))
    await ensureDir(this.resolve('window-state'))
    await ensureDir(this.resolve('scheduler'))
    await ensureDir(this.resolve('memory'))

    await this.migrateLegacyBehaviorPrompt()
    await this.migrateLegacyLayout()

    // Create default config if missing
    const configPath = this.resolve('config.json')
    const existing = await readJson<AppConfig>(configPath)
    if (!existing) {
      await writeJson(configPath, DEFAULT_CONFIG)
    }

    // Create default providers file if missing
    const providersPath = this.resolve('providers.json')
    const providers = await readJson(providersPath)
    if (!providers) {
      await writeJson(providersPath, { providers: [] })
    }

    // The default pool is user-visible and can be copied into the custom file by Settings.
    if ((await this.readRaw(WORKER_NAMES_FILE)) === null) {
      await writeJson(this.resolve(WORKER_NAMES_FILE), DEFAULT_WORKER_NAMES)
    }
  }

  /** Read the global config (missing fields fall back to defaults). */
  async getConfig(): Promise<AppConfig> {
    const config = await readJson<Partial<AppConfig>>(this.resolve('config.json'))
    return {
      ...DEFAULT_CONFIG,
      ...(config ?? {}),
      agentDefaults: {
        ...DEFAULT_CONFIG.agentDefaults,
        ...(config?.agentDefaults ?? {})
      },
      auxiliaryAgents: { ...(config?.auxiliaryAgents ?? {}) },
      // Assignments are read straight off the config file, so the array is
      // filtered here too: only a complete selection on a valid id survives, and
      // a hand-edited entry can never reach a model the user did not name.
      design: {
        assignments: (Array.isArray(config?.design?.assignments) ? config.design.assignments : [])
          .filter(isUsableDesignAssignment)
          .slice(0, MAX_DESIGN_ASSIGNMENTS)
      },
      // A provider id a future version wrote is passed through as-is so the
      // choice is not silently erased; only a missing field falls back.
      mediaGeneration: {
        providerId: config?.mediaGeneration?.providerId ?? DEFAULT_CONFIG.mediaGeneration.providerId
      },
      // Read tolerantly: a value a future version wrote, a hand-edited path, or a
      // pair where one root sits inside the other arrives as a working app with
      // the defaults rather than as a failed start.
      workRoots: workRootsFromConfig(config ?? {}),
      memory: {
        ...DEFAULT_CONFIG.memory,
        ...(config?.memory ?? {}),
        entries: config?.memory?.entries ?? []
      },
      inAppNotificationSound: {
        ...DEFAULT_IN_APP_NOTIFICATION_SOUND,
        ...(config?.inAppNotificationSound ?? {})
      },
      prototypeCdnAllowlist: Array.isArray(config?.prototypeCdnAllowlist)
        ? config.prototypeCdnAllowlist.filter(
            (origin): origin is string => typeof origin === 'string'
          )
        : DEFAULT_CONFIG.prototypeCdnAllowlist,
      sound: {
        ...DEFAULT_CONFIG.sound,
        ...(config?.sound ?? {}),
        cues: {
          ...DEFAULT_CONFIG.sound.cues,
          ...(config?.sound?.cues ?? {})
        }
      },
      agentBehaviorPrompt: await this.readBehaviorPrompt()
    }
  }

  /** Write the global config */
  async saveConfig(config: AppConfig): Promise<void> {
    const { agentBehaviorPrompt: _agentBehaviorPrompt, ...persistedConfig } = config
    await writeJson(this.resolve('config.json'), persistedConfig)
  }

  private async readBehaviorPrompt(): Promise<string> {
    return this.getCioPrompt('work-ethics')
  }

  /** Return every shipped template with an optional user-owned file override. */
  async getCioPromptSettings(): Promise<CioPromptSetting[]> {
    return Promise.all(
      CIO_PROMPT_DEFINITIONS.map(async (definition) => {
        const currentDefinition = getCioPromptDefinition(definition.id)
        const override = await this.readRaw(
          `${CIO_PROMPTS_DIRECTORY}/${currentDefinition.filename}`
        )
        return {
          ...currentDefinition,
          template: override?.trim() ? override : currentDefinition.defaultTemplate,
          customized: Boolean(override?.trim())
        }
      })
    )
  }

  /** Resolve one prompt for runtime use, replacing stable template tags. */
  async getCioPrompt(id: CioPromptId): Promise<string> {
    const definition = getCioPromptDefinition(id)
    const override = await this.readRaw(`${CIO_PROMPTS_DIRECTORY}/${definition.filename}`)
    return override?.trim() ? renderCioPromptTemplate(override) : defaultCioPrompt(id)
  }

  /** Persist only genuine overrides; saving the shipped template removes the file. */
  async saveCioPrompt(id: CioPromptId, template: string): Promise<void> {
    const definition = getCioPromptDefinition(id)
    const normalized = template.trim()
    if (!normalized) throw new TypeError('CIO prompt cannot be empty')
    if (normalized.length > CIO_PROMPT_MAX_LENGTH) {
      throw new TypeError(`CIO prompt cannot exceed ${CIO_PROMPT_MAX_LENGTH} characters`)
    }
    const path = `${CIO_PROMPTS_DIRECTORY}/${definition.filename}`
    if (
      normalized === definition.defaultTemplate.trim() ||
      renderCioPromptTemplate(normalized) ===
        renderCioPromptTemplate(definition.defaultTemplate.trim())
    ) {
      await this.removeRaw(path)
      return
    }
    await this.writeRaw(path, normalized)
  }

  async resetCioPrompt(id: CioPromptId): Promise<void> {
    const definition = getCioPromptDefinition(id)
    await this.removeRaw(`${CIO_PROMPTS_DIRECTORY}/${definition.filename}`)
  }

  /** Carry forward the original special-case override without creating files for defaults. */
  private async migrateLegacyBehaviorPrompt(): Promise<void> {
    const legacy = await this.readRaw('behavior.md')
    if (!legacy?.trim() || (await this.readRaw(AGENT_BEHAVIOR_FILENAME))?.trim()) return
    await this.writeRaw(AGENT_BEHAVIOR_FILENAME, legacy)
    await this.removeRaw('behavior.md')
  }

  /**
   * One-time relocation of config-root state into its feature directory.
   * Window state, scheduler records, and every memory artifact are moved from
   * the flat root (and the old project/chat locations) into their dedicated
   * directories so the config root stays clean and future files land in the
   * right place. Only moves a source when the destination is empty, and always
   * removes the source afterward to complete the cleanup.
   */
  private async migrateLegacyLayout(): Promise<void> {
    await this.moveLegacyFile('window-state.json', 'window-state/window-state.json')
    await this.moveLegacyFile('retry-scheduler.json', 'scheduler/retry-scheduler.json')

    await this.moveLegacyFile('memory.md', 'memory/memory.md')
    await this.moveLegacyFile('memory-proposals.json', 'memory/memory-proposals.json')
    await this.moveLegacyFile('memory-frequency.json', 'memory/memory-frequency.json')

    for (const projectId of await this.listDirectories('projects')) {
      await this.moveLegacyFile(
        join('projects', projectId, 'memory.md'),
        join('memory', 'projects', projectId, 'memory.md')
      )
      await this.moveLegacyFile(
        join('projects', projectId, 'memory-proposals.json'),
        join('memory', 'projects', projectId, 'memory-proposals.json')
      )
      await this.moveLegacyFile(
        join('projects', projectId, 'memory-frequency.json'),
        join('memory', 'projects', projectId, 'memory-frequency.json')
      )
      for (const threadId of await this.listDirectories(join('projects', projectId, 'threads'))) {
        await this.moveLegacyFile(
          join('projects', projectId, 'threads', threadId, 'memory.md'),
          join('memory', 'projects', projectId, 'threads', threadId, 'memory.md')
        )
      }
    }

    await this.moveLegacyFile('chats-cwd/memory.md', 'memory/chats/memory.md')
    await this.moveLegacyFile(
      'chats-cwd/memory-proposals.json',
      'memory/chats/memory-proposals.json'
    )
    for (const threadId of await this.listDirectories('chats-cwd/threads')) {
      await this.moveLegacyFile(
        join('chats-cwd', 'threads', threadId, 'memory.md'),
        join('memory', 'chats', 'threads', threadId, 'memory.md')
      )
    }
  }

  /** Move a legacy config file to its feature directory when present. */
  private async moveLegacyFile(source: string, target: string): Promise<void> {
    const content = await this.readRaw(source)
    if (content === null) return
    if ((await this.readRaw(target)) === null) {
      await this.writeRaw(target, content)
    }
    await this.removeRaw(source)
  }

  /**
   * Resolve the active worker-name pool. A custom file remains user-owned;
   * padding is calculated in memory and never written back into it.
   */
  async getWorkerNames(): Promise<string[]> {
    const configuredDefaults = (await this.readWorkerNameFile(WORKER_NAMES_FILE)) ?? [
      ...FALLBACK_WORKER_NAMES
    ]
    const defaults = configuredDefaults.length > 0 ? configuredDefaults : [...FALLBACK_WORKER_NAMES]
    const custom = await this.readWorkerNameFile(CUSTOM_WORKER_NAMES_FILE)

    if (custom === null) return defaults

    const resolved = [...custom]
    const padding = [...new Set([...defaults, ...FALLBACK_WORKER_NAMES])].filter(
      (name) => !resolved.includes(name)
    )
    while (resolved.length < MINIMUM_WORKER_NAME_COUNT && padding.length > 0) {
      const [name] = padding.splice(randomInt(padding.length), 1)
      resolved.push(name)
    }
    return resolved.length > 0 ? resolved : [...FALLBACK_WORKER_NAMES]
  }

  /** Persist future Settings edits without modifying the shipped default file. */
  async saveCustomWorkerNames(names: string[]): Promise<void> {
    const normalized = normalizeWorkerNames(names)
    if (!normalized) throw new TypeError('Worker names must be a JSON string array')
    await writeJson(this.resolve(CUSTOM_WORKER_NAMES_FILE), normalized)
  }

  /** Return the read-only defaults and the optional user-owned override. */
  async getWorkerNameSettings(): Promise<WorkerNameSettings> {
    const defaults = (await this.readWorkerNameFile(WORKER_NAMES_FILE)) ?? [
      ...FALLBACK_WORKER_NAMES
    ]
    return {
      defaults: defaults.length > 0 ? defaults : [...FALLBACK_WORKER_NAMES],
      custom: await this.readWorkerNameFile(CUSTOM_WORKER_NAMES_FILE)
    }
  }

  /** Read the configured heartbeat pings (empty when none configured yet). */
  async getHeartbeats(): Promise<HeartbeatConfig[]> {
    return (await this.read<HeartbeatConfig[]>(HEARTBEATS_FILE)) ?? []
  }

  /** Persist the full list of configured heartbeat pings. */
  async saveHeartbeats(heartbeats: HeartbeatConfig[]): Promise<void> {
    await this.write(HEARTBEATS_FILE, heartbeats)
  }

  /** Every model the app recorded as vision-capable, reported by the user. */
  async getVisionModels(): Promise<VisionModelRecord[]> {
    const stored = await this.read<VisionModelRecord[]>(VISION_MODELS_FILE)
    return Array.isArray(stored) ? stored : []
  }

  /** Record a model as vision-capable. Ids are normalized (trimmed,
   *  lowercased) so the record matches the same model across every harness
   *  and provider. Duplicate reports are ignored. */
  async addVisionModel(modelId: string): Promise<void> {
    const id = normalizeVisionModelId(modelId)
    if (!id) throw new TypeError('Vision model id cannot be empty')
    const models = await this.getVisionModels()
    if (models.some((model) => visionModelRecordMatches(model.id, id))) return
    models.push({ id, addedAt: Date.now() })
    await this.write(VISION_MODELS_FILE, models)
  }

  /**
   * True when the app's own record says this model can see images. A record is
   * compared by the model-name segment of the id, so one report covers every
   * provider prefix of the same model (see `visionModelRecordMatches`).
   */
  async hasVisionModel(modelId: string): Promise<boolean> {
    if (!normalizeVisionModelId(modelId)) return false
    const models = await this.getVisionModels()
    return models.some((model) => visionModelRecordMatches(model.id, modelId))
  }

  /** Read a JSON file relative to config root */
  async read<T>(relativePath: string): Promise<T | null> {
    return readJson<T>(this.resolve(relativePath))
  }

  /** Write a JSON file relative to config root (atomic) */
  async write(relativePath: string, data: unknown): Promise<void> {
    const fullPath = this.resolve(relativePath)
    await ensureDir(join(fullPath, '..'))
    await writeJson(fullPath, data)
  }

  private async readWorkerNameFile(relativePath: string): Promise<string[] | null> {
    try {
      return normalizeWorkerNames(await this.read<unknown>(relativePath))
    } catch {
      return null
    }
  }

  /** Read raw text file */
  async readRaw(relativePath: string): Promise<string | null> {
    try {
      return await readFile(this.resolve(relativePath), 'utf-8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
  }

  /** Read only the bytes appended after `fromByte`, cut to the last complete
   *  line. Lets append-only logs tail themselves without re-reading (and
   *  re-decoding) the whole file on every poll. Returns null when the file is
   *  missing; `size` is the file's current byte length so callers can detect a
   *  rewrite (shrunk file) themselves. */
  async readRawTail(relativePath: string, fromByte: number): Promise<RawFileTail | null> {
    let handle: FileHandle
    try {
      handle = await open(this.resolve(relativePath), 'r')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
    try {
      const { size } = await handle.stat()
      if (fromByte >= size) return { content: '', nextByte: size, size }
      const length = size - fromByte
      const buffer = Buffer.allocUnsafe(length)
      let read = 0
      while (read < length) {
        const chunk = await handle.read(buffer, read, length - read, fromByte + read)
        if (chunk.bytesRead === 0) break
        read += chunk.bytesRead
      }
      // Decode only up to and including the last newline, so a trailing partial
      // line (and any partial multibyte character in it) is never cut.
      const region = buffer.subarray(0, read)
      const lastNewline = region.lastIndexOf(0x0a)
      if (lastNewline === -1) return { content: '', nextByte: fromByte, size }
      return {
        content: region.subarray(0, lastNewline + 1).toString('utf8'),
        nextByte: fromByte + lastNewline + 1,
        size
      }
    } finally {
      await handle.close()
    }
  }

  /** Write raw text file atomically */
  async writeRaw(relativePath: string, content: string): Promise<void> {
    const fullPath = this.resolve(relativePath)
    await ensureDir(join(fullPath, '..'))
    await atomicWrite(fullPath, content)
  }

  /** Remove a raw text file relative to config root, if it exists. */
  async removeRaw(relativePath: string): Promise<void> {
    try {
      await unlink(this.resolve(relativePath))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
  }

  /**
   * Append raw text to a file (creates it if missing). Used for append-only logs
   * like history. Appends to one file are strictly serialized in call order so a
   * concurrent caller can never overtake an earlier one - append-only JSONL logs
   * (the working-trace stream, driver events, history) are only readable if
   * their line order is the order the events happened in.
   */
  async appendRaw(relativePath: string, content: string): Promise<void> {
    const fullPath = this.resolve(relativePath)
    return this.enqueueRawWrite(fullPath, async () => {
      await ensureDir(join(fullPath, '..'))
      await appendFile(fullPath, content, 'utf-8')
    })
  }

  /**
   * Run a write on one file's append queue.
   *
   * The queue is what makes an append-only log readable: without it the OS
   * decides which of two concurrent writes lands first. A rewrite has to share
   * the queue for the same reason   renaming over a file an in-flight append is
   * still writing loses that line, and a delete that runs while an append is
   * queued is undone when the append recreates the file. Both operations go
   * through here so that can never happen.
   */
  private enqueueRawWrite(fullPath: string, task: () => Promise<void>): Promise<void> {
    const previous = this.appendQueues.get(fullPath) ?? Promise.resolve()
    const write = previous.then(task)
    // The queue only ever advances on a settled link: a failed write must not
    // wedge every later write to the same file. Callers still receive the real
    // outcome through `write`.
    const queued = write.then(
      () => undefined,
      () => undefined
    )
    this.appendQueues.set(fullPath, queued)
    void queued.then(() => {
      if (this.appendQueues.get(fullPath) === queued) this.appendQueues.delete(fullPath)
    })
    return write
  }

  /**
   * Rewrite a raw file inside its append queue.
   *
   * `build` receives the bytes appended since `fromByte`, read inside the lock so
   * an append that raced the caller's own read is still included, and returns the
   * whole new file, or null to leave it as it is. A caller that already holds the
   * parsed content before `fromByte` compacts a several-hundred-megabyte append
   * log without reading it a second time.
   */
  async rewriteRawFrom(
    relativePath: string,
    fromByte: number,
    build: (appended: string) => string | null
  ): Promise<void> {
    const fullPath = this.resolve(relativePath)
    await this.enqueueRawWrite(fullPath, async () => {
      const tail = await this.readRawTail(relativePath, fromByte)
      const next = build(tail?.content ?? '')
      if (next === null) return
      await ensureDir(join(fullPath, '..'))
      await atomicWrite(fullPath, next)
    })
  }

  /**
   * Wait for the writes already queued for a path.
   *
   * Called before a file is removed so a queued append cannot land after the
   * delete and recreate it. A write queued after this returns is the caller's to
   * prevent   the turn-stream delete does that with a tombstone.
   */
  async drainRaw(relativePath: string): Promise<void> {
    await (this.appendQueues.get(this.resolve(relativePath)) ?? Promise.resolve())
  }

  /** List entries in a directory relative to config root */
  async list(relativePath: string): Promise<string[]> {
    return listDir(this.resolve(relativePath))
  }

  /** List child directories relative to config root, ignoring regular files. */
  async listDirectories(relativePath: string): Promise<string[]> {
    return listDirectories(this.resolve(relativePath))
  }

  /** Ensure a directory exists relative to config root */
  async ensureDirectory(relativePath: string): Promise<void> {
    await ensureDir(this.resolve(relativePath))
  }

  /** Remove a directory relative to config root */
  async remove(relativePath: string): Promise<void> {
    await removeDir(this.resolve(relativePath))
  }

  /** Get absolute path for a relative path */
  resolve(relativePath: string): string {
    return resolveWithinRoot(this.root, relativePath)
  }

  /** Resolve an explicitly agent-owned artifact beneath `.cio/specs/<feature>`. */
  async resolveProjectSpecArtifact(
    projectId: string,
    featureSlug: string,
    relativePath: string,
    sqliteProject?: Project
  ): Promise<string> {
    if (featureSlugFromTitle(featureSlug) !== featureSlug) {
      throw new Error(`Invalid feature slug: ${featureSlug}`)
    }
    const project =
      sqliteProject ?? (await this.read<Project>(join('projects', projectId, 'project.json')))
    if (!project && this.allowOrphanProjectArtifacts) {
      return this.resolve(
        join('projects', projectId, featureArtifactDirectory(featureSlug), relativePath)
      )
    }
    if (!project) throw new Error(`Project not found: ${projectId}`)
    if (project.source !== 'local' || !project.path) {
      throw new Error(`Project ${projectId} has no local filesystem root`)
    }
    return resolveWithinRoot(
      project.path,
      join(featureArtifactDirectory(featureSlug), relativePath)
    )
  }

  async writeProjectSpecRaw(
    projectId: string,
    featureSlug: string,
    relativePath: string,
    content: string,
    sqliteProject?: Project
  ): Promise<void> {
    const fullPath = await this.resolveProjectSpecArtifact(
      projectId,
      featureSlug,
      relativePath,
      sqliteProject
    )
    await ensureDir(join(fullPath, '..'))
    await atomicWrite(fullPath, content)
  }

  async readProjectSpecRaw(
    projectId: string,
    featureSlug: string,
    relativePath: string,
    sqliteProject?: Project
  ): Promise<string | null> {
    try {
      return await readFile(
        await this.resolveProjectSpecArtifact(projectId, featureSlug, relativePath, sqliteProject),
        'utf-8'
      )
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
  }

  /**
   * Resolve the per-project cloud deployment config path, always under the
   * CodeInOven config directory   never inside the user's repository.
   */
  private cloudDeploymentConfigPath(projectId: string): string {
    return join('projects', projectId, 'cloud-deployment.json')
  }

  /** Read a project's cloud deployment config, or null when none exists. */
  async getCloudDeploymentConfig(projectId: string): Promise<CloudDeploymentConfig | null> {
    return this.read<CloudDeploymentConfig>(this.cloudDeploymentConfigPath(projectId))
  }

  /** Persist a project's cloud deployment config atomically under the config dir. */
  async saveCloudDeploymentConfig(projectId: string, config: CloudDeploymentConfig): Promise<void> {
    await this.write(this.cloudDeploymentConfigPath(projectId), config)
  }

  /**
   * Whether a project has at least one configured provider. Mirrors the
   * `setHasDeployments` precedent so a project without configured providers is
   * flagged and the Cloud Deployments panel stays hidden.
   */
  async hasCloudDeployments(projectId: string): Promise<boolean> {
    const config = await this.getCloudDeploymentConfig(projectId)
    return config !== null && config.project.providers.length > 0
  }

  /** Remove a project's cloud deployment config, flagging it as having none. */
  async clearCloudDeploymentConfig(projectId: string): Promise<void> {
    await this.remove(this.cloudDeploymentConfigPath(projectId))
  }

  /**
   * Resolve the global cloud deployment account registry path, always under the
   * CodeInOven config directory   never inside the user's repository, and
   * independent of any single project.
   */
  private cloudDeploymentAccountsPath(): string {
    return join('cloud-deployments', 'accounts.json')
  }

  /** Read the global provider account registry, or an empty one when absent. */
  async getCloudDeploymentAccounts(): Promise<CloudDeploymentAccountRegistry> {
    return (
      (await this.read<CloudDeploymentAccountRegistry>(this.cloudDeploymentAccountsPath())) ?? {
        accounts: []
      }
    )
  }

  /** Persist the global provider account registry atomically under the config dir. */
  async saveCloudDeploymentAccounts(registry: CloudDeploymentAccountRegistry): Promise<void> {
    await this.write(this.cloudDeploymentAccountsPath(), registry)
  }
}
