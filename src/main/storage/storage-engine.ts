import { join } from 'path'
import { randomInt } from 'crypto'
import { readFile, appendFile, unlink } from 'fs/promises'
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
import type { AppConfig } from '../../lib/types'
import { AGENT_BEHAVIOR_FILENAME, DEFAULT_AGENT_BEHAVIOR_PROMPT } from '../../lib/agent-behavior'
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
import { featureArtifactDirectory, featureSlugFromTitle } from '../../lib/project-artifacts'
import {
  CUSTOM_WORKER_NAMES_FILE,
  DEFAULT_WORKER_NAMES,
  FALLBACK_WORKER_NAMES,
  MINIMUM_WORKER_NAME_COUNT,
  WORKER_NAMES_FILE,
  normalizeWorkerNames
} from '../../lib/assignment/worker-names'
import type { WorkerNameSettings } from '../../lib/assignment/worker-names'

const DEFAULT_CONFIG: AppConfig = {
  theme: 'system',
  threadLimit: 70,
  questionTimeoutMs: 300_000,
  keybindings: {},
  slashCommandMode: 'app',
  preferredEditor: 'system',
  memory: { enabled: true, chatEnabled: true, entries: [] },
  agentDefaults: { syncFromThreadChanges: false },
  agentBehaviorPrompt: DEFAULT_AGENT_BEHAVIOR_PROMPT,
  autoDownloadUpdates: true,
  autoInstallUpdates: true,
  updateChannel: 'stable',
  keepAwakeWhileWorking: false,
  imageDescriptorAskAgain: false,
  autoRetryAfterReset: true,
  resumeWorkOnRestart: true,
  defaultMergeMethod: 'squash',
  maxDiffLines: 100
}

/**
 * StorageEngine — manages all filesystem persistence under ~/.config/pillardash/codeinoven/
 * All writes are atomic (write .tmp then rename).
 */
export class StorageEngine {
  private root: string
  private readonly allowOrphanProjectArtifacts: boolean

  constructor(rootPath?: string) {
    this.root = rootPath ?? getConfigRoot()
    this.allowOrphanProjectArtifacts = rootPath !== undefined
  }

  /** Initialize the directory structure */
  async initialize(): Promise<void> {
    await ensureDir(this.root)
    await ensureDir(this.resolve('projects'))
    await ensureDir(this.resolve('workflows'))
    await ensureDir(this.resolve('blobs'))
    await ensureDir(this.resolve('remote'))
    await ensureDir(this.resolve('logs'))
    await ensureDir(this.resolve('chats-cwd'))

    await this.migrateLegacyBehaviorPrompt()

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
      memory: {
        ...DEFAULT_CONFIG.memory,
        ...(config?.memory ?? {}),
        entries: config?.memory?.entries ?? []
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

  /** Append raw text to a file (creates it if missing). Used for append-only logs like history. */
  async appendRaw(relativePath: string, content: string): Promise<void> {
    const fullPath = this.resolve(relativePath)
    await ensureDir(join(fullPath, '..'))
    await appendFile(fullPath, content, 'utf-8')
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
   * CodeInOven config directory — never inside the user's repository.
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
   * CodeInOven config directory — never inside the user's repository, and
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
