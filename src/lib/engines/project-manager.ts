import { backgroundIo } from '../../main/system/background-io'
import { join } from 'path'
import { realpath } from 'fs/promises'
import { generateId, getConfigRoot } from '../utils'
import { readIconDataUrl, removeIconFile, storeCustomIconFile, storeIconFile } from '../icon-file'
import type { CustomIconImage } from '../custom-icon'
import type { Project, CreateProjectInput } from '../types'
import { INBOX_PROJECT_ID, ASSISTANT_SPACE_ID } from '../types'
import { GLOBAL_BROWSER_PROJECT_ID } from '../ipc/browser'
import { MAX_GLOBAL_BROWSER_TABS } from '../browser/global-browser-tabs'
import { pickColorForSeed } from '../project-colors'
import { ensureProjectScratchSpace } from '../project-artifacts'
import type { Database } from '../../main/database/database'
import { ProjectRepo } from '../../main/database/repositories/project-repo'
import { ThreadRepo } from '../../main/database/repositories/thread-repo'

/**
 * How many threads the hidden global-browser container holds: one assistant
 * conversation per browser tab, plus the reserved scope anchor thread. The tab
 * strip is capped separately, so this is a ceiling no real session reaches rather
 * than a budget conversations compete for.
 */
const GLOBAL_BROWSER_THREAD_LIMIT = MAX_GLOBAL_BROWSER_TABS + 1

export class ProjectManager {
  private projectRepo: ProjectRepo
  private threadRepo: ThreadRepo

  constructor(private database: Database) {
    this.projectRepo = new ProjectRepo(database)
    this.threadRepo = new ThreadRepo(database)
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    if (!input.hidden && input.path) {
      // A remote path only identifies a project together with its host: two
      // Ovens can legitimately serve the same absolute directory. A local path
      // is unique on its own, so it keeps the exact-path check.
      const duplicate =
        input.source === 'ssh' && input.host
          ? await this.projectRepo.findByHostPath(input.host, input.path)
          : await this.findByPath(input.path)
      if (duplicate) {
        throw new Error(`A project for "${input.path}" already exists (${duplicate.name})`)
      }
    }

    const id = generateId()
    const now = Date.now()

    const project: Project = {
      id,
      name: input.name,
      path: input.path,
      source: input.source ?? 'local',
      host: input.host,
      ovenId: input.ovenId,
      providerId: input.providerId ?? '',
      workflowId: input.workflowId ?? 'default',
      threadLimit: input.threadLimit ?? 70,
      color: input.color,
      iconType: input.iconType,
      changeTrackingMode: input.changeTrackingMode ?? 'manual',
      hasDeployments: input.hasDeployments ?? false,
      createdAt: now,
      updatedAt: now
    }

    if (project.source === 'local' && project.path) {
      await this.scaffoldProjectScratchSpace(project.path)
      const detected = await this.detectIcon(project.path)
      if (detected) {
        try {
          const iconFile = await storeIconFile(join(getConfigRoot(), 'projects', id), detected)
          project.icon = iconFile
        } catch {
          // best-effort
        }
      }
    }

    if (!project.icon && !project.color) {
      project.color = pickColorForSeed(project.name)
    }

    this.projectRepo.upsert(project)

    return project
  }

  /**
   * One project, read on the database worker. Called from every interaction
   * path that needs a project (scope resolution, the chat engine, PTY spawns,
   * `project:get`), so it must not run SQLite on the Electron main thread.
   */
  async getProject(projectId: string): Promise<Project | null> {
    return this.projectRepo.getViaWorker(projectId)
  }

  async findByPath(path: string): Promise<Project | null> {
    return this.projectRepo.findByPath(path)
  }

  /**
   * Resolve a project whose folder is the same directory as `path`, compared by
   * canonical (symlink-resolved) path so the same folder reached through a
   * trailing slash, a relative segment, or a symlink never registers twice.
   * Existing project paths are normalized on the fly; a path that cannot be
   * resolved falls back to an exact string comparison.
   */
  async findByCanonicalPath(path: string): Promise<Project | null> {
    const trimmed = typeof path === 'string' ? path.trim() : ''
    if (!trimmed) return null
    const exact = await this.findByPath(trimmed)
    if (exact) return exact

    let canonical: string
    try {
      canonical = await realpath(trimmed)
    } catch {
      // The folder does not exist (yet): only an exact match could apply.
      return null
    }

    for (const project of await this.listProjects()) {
      if (!project.path) continue
      if (project.path === canonical) return project
      try {
        if ((await realpath(project.path)) === canonical) return project
      } catch {
        // A project whose folder is gone can never match a live folder.
      }
    }
    return null
  }

  async ensureInboxProject(): Promise<Project> {
    const existing = await this.projectRepo.getViaWorker(INBOX_PROJECT_ID)
    if (existing) return existing

    const now = Date.now()
    const project: Project = {
      id: INBOX_PROJECT_ID,
      name: 'Chats',
      path: '',
      source: 'local',
      providerId: '',
      workflowId: 'default',
      threadLimit: 200,
      hidden: true,
      color: pickColorForSeed(INBOX_PROJECT_ID),
      changeTrackingMode: 'manual',
      createdAt: now,
      updatedAt: now
    }

    this.projectRepo.upsert(project)

    return project
  }

  /**
   * Ensure the hidden assistant-space container exists. Assistant tasks are
   * threads in this container, so they never leak into the Projects or Chats
   * lists (it is hidden) while still reusing every thread surface.
   */
  async ensureAssistantSpace(): Promise<Project> {
    const existing = await this.projectRepo.getViaWorker(ASSISTANT_SPACE_ID)
    if (existing) return existing

    const now = Date.now()
    const project: Project = {
      id: ASSISTANT_SPACE_ID,
      name: 'Assistant',
      path: '',
      source: 'local',
      providerId: '',
      workflowId: 'default',
      threadLimit: 500,
      hidden: true,
      color: pickColorForSeed(ASSISTANT_SPACE_ID),
      changeTrackingMode: 'manual',
      createdAt: now,
      updatedAt: now
    }

    this.projectRepo.upsert(project)

    return project
  }

  /**
   * Ensure the hidden global-browser container exists.
   *
   * The global browser is a container of many tabs, exactly as the assistant
   * space is a container of many tasks: one hidden project row lets the chat
   * engine resolve the scope of a per-tab agent conversation (its neutral
   * working directory, its memory scope and its capability discovery) through
   * the same code path every other conversation uses, while the row stays out of
   * the Projects and Chats lists because it is hidden.
   *
   * Its capacity covers one assistant conversation per browser tab plus the
   * reserved scope anchor. A lower limit would make creating a conversation evict
   * an older one, and losing a transcript to capacity is data loss the user never
   * asked for: the tab cap is what bounds this container, not thread eviction.
   */
  async ensureGlobalBrowserSpace(): Promise<Project> {
    const existing = await this.projectRepo.getViaWorker(GLOBAL_BROWSER_PROJECT_ID)
    if (existing) {
      if (existing.threadLimit === GLOBAL_BROWSER_THREAD_LIMIT) return existing
      // An install that predates per-tab assistant conversations still carries
      // the old capacity, so it is widened once here rather than left to evict
      // the conversations this build now stores.
      const widened: Project = {
        ...existing,
        threadLimit: GLOBAL_BROWSER_THREAD_LIMIT,
        updatedAt: Date.now()
      }
      this.projectRepo.upsert(widened)
      return widened
    }

    const now = Date.now()
    const project: Project = {
      id: GLOBAL_BROWSER_PROJECT_ID,
      name: 'Browser',
      path: '',
      source: 'local',
      providerId: '',
      workflowId: 'default',
      threadLimit: GLOBAL_BROWSER_THREAD_LIMIT,
      hidden: true,
      color: pickColorForSeed(GLOBAL_BROWSER_PROJECT_ID),
      changeTrackingMode: 'manual',
      createdAt: now,
      updatedAt: now
    }

    this.projectRepo.upsert(project)

    return project
  }

  async listProjects(): Promise<Project[]> {
    return this.projectRepo.list()
  }

  async reorderProjects(orderedIds: string[]): Promise<Project[]> {
    const projects: Project[] = []
    for (let i = 0; i < orderedIds.length; i++) {
      const existing = await this.projectRepo.getViaWorker(orderedIds[i])
      if (existing) {
        this.projectRepo.setSortOrder(existing.id, i)
        const updated: Project = { ...existing, sortOrder: i, updatedAt: Date.now() }
        projects.push(updated)
      }
    }
    return projects
  }

  async setPinned(projectId: string, pinned: boolean): Promise<Project> {
    const existing = await this.projectRepo.getViaWorker(projectId)
    if (!existing) {
      throw new Error(`Project not found: ${projectId}`)
    }

    const updated: Project = {
      ...existing,
      pinned: pinned || undefined,
      updatedAt: Date.now()
    }
    this.projectRepo.upsert(updated)
    return updated
  }

  /** Record whether the repo is known to have GitHub deployments. No-ops when
   *  the flag is already set, so repeated background checks don't churn the DB. */
  async setHasDeployments(projectId: string, hasDeployments: boolean): Promise<Project> {
    const existing = await this.projectRepo.getViaWorker(projectId)
    if (!existing) {
      throw new Error(`Project not found: ${projectId}`)
    }

    if (existing.hasDeployments === hasDeployments) return existing

    const updated: Project = {
      ...existing,
      hasDeployments,
      updatedAt: Date.now()
    }
    this.projectRepo.upsert(updated)
    return updated
  }

  async updateProject(projectId: string, input: Partial<CreateProjectInput>): Promise<Project> {
    const existing = await this.projectRepo.getViaWorker(projectId)
    if (!existing) {
      throw new Error(`Project not found: ${projectId}`)
    }

    const updated: Project = {
      ...existing,
      name: input.name ?? existing.name,
      path: input.path ?? existing.path,
      source: input.source ?? existing.source,
      host: input.host ?? existing.host,
      ovenId: input.ovenId ?? existing.ovenId,
      providerId: input.providerId ?? existing.providerId,
      workflowId: input.workflowId ?? existing.workflowId,
      threadLimit: input.threadLimit ?? existing.threadLimit,
      changeTrackingMode: input.changeTrackingMode ?? existing.changeTrackingMode,
      color: 'color' in input ? input.color : existing.color,
      iconType: 'iconType' in input ? input.iconType : existing.iconType,
      customSvg: 'customSvg' in input ? (input.customSvg ?? undefined) : existing.customSvg,
      updatedAt: Date.now()
    }

    this.projectRepo.upsert(updated)

    if (updated.source === 'local' && updated.path) {
      await this.scaffoldProjectScratchSpace(updated.path)
    }

    return updated
  }

  /**
   * Best-effort creation of the `.cio/` scratch pad and its `.gitignore`
   * entry. A project must still register when this fails; the scratch space
   * is re-ensured on later path updates.
   */
  private async scaffoldProjectScratchSpace(projectPath: string): Promise<void> {
    try {
      await ensureProjectScratchSpace(projectPath)
    } catch {
      // Best-effort   never fail project registration over scratch space.
    }
  }

  async deleteProject(projectId: string): Promise<void> {
    this.projectRepo.delete(projectId)
  }

  // ─── Project icons ────────────────────────────────────────────────────────

  async detectIcon(projectPath: string): Promise<string | null> {
    try {
      return await backgroundIo<string | null>({ kind: 'project-icon', projectPath })
    } catch {
      return null
    }
  }

  async setIcon(projectId: string, image: CustomIconImage): Promise<Project> {
    const existing = await this.projectRepo.getViaWorker(projectId)
    if (!existing) {
      throw new Error(`Project not found: ${projectId}`)
    }

    const iconFile = await storeCustomIconFile(
      join(getConfigRoot(), 'projects', projectId),
      image,
      existing.icon
    )

    const updated: Project = {
      ...existing,
      icon: iconFile,
      updatedAt: Date.now()
    }
    this.projectRepo.upsert(updated)
    return updated
  }

  async clearIcon(projectId: string): Promise<Project> {
    const existing = await this.projectRepo.getViaWorker(projectId)
    if (!existing) {
      throw new Error(`Project not found: ${projectId}`)
    }

    if (existing.icon) {
      await removeIconFile(join(getConfigRoot(), 'projects', projectId), existing.icon)
    }

    const updated: Project = {
      ...existing,
      icon: undefined,
      updatedAt: Date.now()
    }
    this.projectRepo.upsert(updated)
    return updated
  }

  search(query: string, limit = 20): Project[] {
    return this.projectRepo.search(query, limit)
  }

  async getIconDataUrl(projectId: string): Promise<string | null> {
    const project = await this.projectRepo.getViaWorker(projectId)
    if (!project?.icon) return null

    return readIconDataUrl(join(getConfigRoot(), 'projects', projectId), project.icon)
  }
}
