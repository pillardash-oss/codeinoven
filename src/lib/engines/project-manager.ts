import { join, extname, relative, sep } from 'path'
import { copyFile, mkdir, readFile, readdir, rm } from 'fs/promises'
import type { Dirent } from 'fs'
import { generateId, getConfigRoot } from '../utils'
import type { Project, CreateProjectInput } from '../types'
import { INBOX_PROJECT_ID } from '../types'
import { pickColorForSeed } from '../project-colors'
import { ensureProjectScratchSpace } from '../project-artifacts'
import type { Database } from '../../main/database/database'
import { ProjectRepo } from '../../main/database/repositories/project-repo'
import { ThreadRepo } from '../../main/database/repositories/thread-repo'

const ICON_SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  'coverage',
  'bower_components',
  '__pycache__',
  '.next',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vscode',
  'target',
  '.venv',
  'venv',
  'Pods',
  'Carthage',
  '.gradle',
  '.dart_tool'
])

// Generated/build output dirs. Not traversed deeply, but their top-level files
// are still probed because many toolchains (Electron, webpack, Vite, .NET)
// copy or emit `icon.png`/`icon.ico`/`favicon.ico` into them.
const ICON_BUILD_DIRS = new Set(['build', 'dist', 'out', 'release', 'www'])

// Folder names that almost always hold a project's icon, anywhere in the tree.
const ICON_KNOWN_DIR_SEGMENTS = new Set([
  'src',
  'public',
  'static',
  'assets',
  'images',
  'img',
  'icons',
  'brand',
  'resources',
  'favicon',
  'favicons',
  'logos',
  'graphics',
  'app',
  'web',
  'client',
  'frontend',
  'site',
  'ui'
])

// Monorepo workspace containers. Icons found under these are scored slightly
// lower than icons in the project root so a root-level icon still wins.
const ICON_WORKSPACE_CONTAINERS = new Set([
  'packages',
  'apps',
  'modules',
  'libs',
  'components',
  'services',
  'tools',
  'sites',
  'examples'
])

const ICON_SCAN_DEPTH = 5

// Bounded scan: never read more than this many directories while hunting for
// an icon, so huge repositories can't stall project creation.
const ICON_MAX_SCAN_DIRS = 2_000

// Ranked icon filenames — earlier entries win. Names are matched
// case-insensitively so `Icon.PNG`, `FAVICON.ico`, etc. are all recognized.
const ICON_CANDIDATE_NAMES = [
  'favicon.png',
  'favicon.svg',
  'icon.png',
  'icon.svg',
  'icon-1024.png',
  'icon-1024x1024.png',
  'apple-touch-icon.png',
  'apple-touch-icon-precomposed.png',
  'app-icon.png',
  'app-icon.svg',
  'appicon.png',
  'logo.png',
  'logo.svg',
  'logo-mark.png',
  'logo-mark.svg',
  'logo-icon.png',
  'logo-icon.svg',
  'android-chrome-512x512.png',
  'android-chrome-192x192.png',
  'icon-512.png',
  'icon-192.png',
  'icon-128.png',
  'icon-96.png',
  'icon-72.png',
  'icon-48.png',
  'icon-32.png',
  'icon-16.png',
  'favicon-196x196.png',
  'favicon-160x160.png',
  'favicon-96x96.png',
  'favicon-32x32.png',
  'favicon-16x16.png',
  'logo-512.png',
  'logo-192.png',
  'mstile-150x150.png',
  'safari-pinned-tab.svg',
  'ic_launcher.png',
  'ic_launcher.webp',
  'ic_launcher_round.png',
  'ic_launcher_foreground.png',
  'favicon.ico',
  'icon.ico'
]

const ICON_CANDIDATE_RANK = new Map(
  ICON_CANDIDATE_NAMES.map((name, index) => [name.toLowerCase(), index])
)

// iOS `.appiconset` directories are a fallback-only source: the files inside
// have arbitrary names, so any PNG there ranks below a named icon anywhere.
const ICON_APPICONSET_PNG_RANK = 60

const ICON_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
}

export class ProjectManager {
  private projectRepo: ProjectRepo
  private threadRepo: ThreadRepo

  constructor(private database: Database) {
    this.projectRepo = new ProjectRepo(database)
    this.threadRepo = new ThreadRepo(database)
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    if (!input.hidden && input.path) {
      const duplicate = await this.findByPath(input.path)
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
      providerId: input.providerId ?? '',
      workflowId: input.workflowId ?? 'default',
      threadLimit: input.threadLimit ?? 70,
      color: input.color,
      iconType: input.iconType,
      changeTrackingMode: input.changeTrackingMode ?? 'manual',
      createdAt: now,
      updatedAt: now
    }

    if (project.source === 'local' && project.path) {
      await this.scaffoldProjectScratchSpace(project.path)
      const detected = await this.detectIcon(project.path)
      if (detected) {
        const iconFile = `icon${extname(detected) || '.png'}`
        try {
          const iconDir = join(getConfigRoot(), 'projects', id)
          await mkdir(iconDir, { recursive: true })
          await copyFile(detected, join(iconDir, iconFile))
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

  async getProject(projectId: string): Promise<Project | null> {
    return this.projectRepo.get(projectId)
  }

  async findByPath(path: string): Promise<Project | null> {
    return this.projectRepo.findByPath(path)
  }

  async ensureInboxProject(): Promise<Project> {
    const existing = this.projectRepo.get(INBOX_PROJECT_ID)
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

  async listProjects(): Promise<Project[]> {
    return this.projectRepo.list()
  }

  async reorderProjects(orderedIds: string[]): Promise<Project[]> {
    const projects: Project[] = []
    for (let i = 0; i < orderedIds.length; i++) {
      const existing = this.projectRepo.get(orderedIds[i])
      if (existing) {
        this.projectRepo.setSortOrder(existing.id, i)
        const updated: Project = { ...existing, sortOrder: i, updatedAt: Date.now() }
        projects.push(updated)
      }
    }
    return projects
  }

  async setPinned(projectId: string, pinned: boolean): Promise<Project> {
    const existing = this.projectRepo.get(projectId)
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

  async updateProject(projectId: string, input: Partial<CreateProjectInput>): Promise<Project> {
    const existing = this.projectRepo.get(projectId)
    if (!existing) {
      throw new Error(`Project not found: ${projectId}`)
    }

    const updated: Project = {
      ...existing,
      name: input.name ?? existing.name,
      path: input.path ?? existing.path,
      source: input.source ?? existing.source,
      host: input.host ?? existing.host,
      providerId: input.providerId ?? existing.providerId,
      workflowId: input.workflowId ?? existing.workflowId,
      threadLimit: input.threadLimit ?? existing.threadLimit,
      changeTrackingMode: input.changeTrackingMode ?? existing.changeTrackingMode,
      color: 'color' in input ? input.color : existing.color,
      iconType: 'iconType' in input ? input.iconType : existing.iconType,
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
      // Best-effort — never fail project registration over scratch space.
    }
  }

  async deleteProject(projectId: string): Promise<void> {
    this.projectRepo.delete(projectId)
  }

  // ─── Project icons ────────────────────────────────────────────────────────

  /** Rank how promising a directory is for holding the project icon. */
  private iconLocationRank(relPath: string): number {
    if (relPath === '') return 0
    const segments = relPath.split('/')
    for (const segment of segments) {
      if (ICON_KNOWN_DIR_SEGMENTS.has(segment)) return 1
    }
    if (ICON_WORKSPACE_CONTAINERS.has(segments[0])) return 2
    return 3
  }

  /**
   * Bounded breadth-first scan across the project tree. Skips heavy/ignored
   * dirs and generated build outputs (those are probed shallowly instead).
   * Every candidate icon is scored (lower wins): filename rank dominates,
   * then location (root > known icon dirs > monorepo packages > arbitrary
   * nesting), then scan depth.
   */
  private async scanTreeForIcon(
    projectPath: string,
    consider: (path: string, score: number) => void
  ): Promise<void> {
    const queue: Array<{ dir: string; depth: number }> = [{ dir: projectPath, depth: 0 }]
    let scanned = 0

    while (queue.length > 0) {
      if (scanned >= ICON_MAX_SCAN_DIRS) break
      scanned++
      const { dir, depth } = queue.shift()!
      let entries: Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }

      const relDir = relative(projectPath, dir).split(sep).join('/')
      const locationRank = this.iconLocationRank(relDir)

      for (const entry of entries) {
        if (!entry.isFile()) continue
        const rank = ICON_CANDIDATE_RANK.get(entry.name.toLowerCase())
        if (rank === undefined) continue
        consider(join(dir, entry.name), rank * 1000 + locationRank * 100 + depth)
      }

      if (depth >= ICON_SCAN_DEPTH) continue

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        if (ICON_SKIP_DIRS.has(entry.name)) continue
        if (ICON_BUILD_DIRS.has(entry.name)) {
          // Build outputs are probed shallowly (Electron, webpack, Vite emit
          // their icon there), never traversed deeply.
          await this.probeDirForIcon(join(dir, entry.name), 2, consider)
          continue
        }
        queue.push({ dir: join(dir, entry.name), depth: depth + 1 })
      }
    }
  }

  /** Shallow (depth ≤ 1) probe of a generated build output directory. */
  private async probeDirForIcon(
    dir: string,
    locationRank: number,
    consider: (path: string, score: number) => void
  ): Promise<void> {
    const queue: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }]
    let scanned = 0

    while (queue.length > 0 && scanned < 64) {
      scanned++
      const { dir: current, depth } = queue.shift()!
      let entries: Dirent[]
      try {
        entries = await readdir(current, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        if (!entry.isFile()) continue
        const rank = ICON_CANDIDATE_RANK.get(entry.name.toLowerCase())
        if (rank === undefined) continue
        consider(join(current, entry.name), rank * 1000 + locationRank * 100 + depth)
      }

      if (depth >= 1) continue

      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          queue.push({ dir: join(current, entry.name), depth: depth + 1 })
        }
      }
    }
  }

  /** Android launcher icons live in `res/mipmap-…/ic_launcher.*`. */
  private async probeAndroidIcons(
    projectPath: string,
    consider: (path: string, score: number) => void
  ): Promise<void> {
    const resDir = join(projectPath, 'android', 'app', 'src', 'main', 'res')
    let entries: Dirent[]
    try {
      entries = await readdir(resDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('mipmap')) continue
      let files: Dirent[]
      try {
        files = await readdir(join(resDir, entry.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.isFile()) continue
        const lower = file.name.toLowerCase()
        if (!(lower.startsWith('ic_launcher') && /\.(png|webp)$/.test(lower))) continue
        const rank = ICON_CANDIDATE_RANK.get(lower) ?? 100
        consider(join(resDir, entry.name, file.name), rank * 1000 + 100)
      }
    }
  }

  /** iOS app icons live in Xcode asset catalogs as `*.appiconset` dirs. */
  private async probeIosIcons(
    projectPath: string,
    consider: (path: string, score: number) => void
  ): Promise<void> {
    const queue: Array<{ dir: string; depth: number }> = [
      { dir: join(projectPath, 'ios'), depth: 0 }
    ]
    let scanned = 0

    while (queue.length > 0 && scanned < 500) {
      scanned++
      const { dir, depth } = queue.shift()!
      let entries: Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const full = join(dir, entry.name)
        if (entry.name.endsWith('.appiconset')) {
          await this.collectAppIconSet(full, consider)
        } else if (depth < 8 && !ICON_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          queue.push({ dir: full, depth: depth + 1 })
        }
      }
    }
  }

  /** Any PNG inside an `.appiconset` dir is a fallback icon candidate. */
  private async collectAppIconSet(
    dir: string,
    consider: (path: string, score: number) => void
  ): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isFile() && /\.png$/i.test(entry.name)) {
        consider(join(dir, entry.name), ICON_APPICONSET_PNG_RANK * 1000 + 100)
      }
    }
  }

  async detectIcon(projectPath: string): Promise<string | null> {
    const candidates: Array<{ path: string; score: number }> = []
    const consider = (path: string, score: number): void => {
      candidates.push({ path, score })
    }

    // Generated output dirs (Electron, webpack, Vite, .NET): probe shallowly.
    for (const buildDir of ICON_BUILD_DIRS) {
      await this.probeDirForIcon(join(projectPath, buildDir), 2, consider)
    }

    // Native platform icon locations.
    await this.probeAndroidIcons(projectPath, consider)
    await this.probeIosIcons(projectPath, consider)

    // Full tree scan: project root, src/static, public, assets, and monorepo
    // workspace packages.
    await this.scanTreeForIcon(projectPath, consider)

    if (candidates.length === 0) return null

    candidates.sort((a, b) => a.score - b.score)
    return candidates[0].path
  }

  async setIcon(projectId: string, sourcePath: string): Promise<Project> {
    const existing = this.projectRepo.get(projectId)
    if (!existing) {
      throw new Error(`Project not found: ${projectId}`)
    }

    const ext = extname(sourcePath).toLowerCase() || '.png'
    if (!(ext in ICON_MIME)) {
      throw new Error(`Unsupported icon format: ${ext}`)
    }

    const iconDir = join(getConfigRoot(), 'projects', projectId)

    if (existing.icon) {
      try {
        await rm(join(iconDir, existing.icon))
      } catch {
        // best-effort
      }
    }

    const iconFile = `icon${ext}`
    await mkdir(iconDir, { recursive: true })
    await copyFile(sourcePath, join(iconDir, iconFile))

    const updated: Project = {
      ...existing,
      icon: iconFile,
      updatedAt: Date.now()
    }
    this.projectRepo.upsert(updated)
    return updated
  }

  async clearIcon(projectId: string): Promise<Project> {
    const existing = this.projectRepo.get(projectId)
    if (!existing) {
      throw new Error(`Project not found: ${projectId}`)
    }

    if (existing.icon) {
      try {
        await rm(join(getConfigRoot(), 'projects', projectId, existing.icon))
      } catch {
        // best-effort
      }
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
    const project = this.projectRepo.get(projectId)
    if (!project?.icon) return null

    try {
      const buffer = await readFile(join(getConfigRoot(), 'projects', projectId, project.icon))
      const mime = ICON_MIME[extname(project.icon).toLowerCase()] ?? 'image/png'
      return `data:${mime};base64,${buffer.toString('base64')}`
    } catch {
      return null
    }
  }
}
