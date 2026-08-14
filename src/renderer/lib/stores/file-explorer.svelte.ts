/**
 * Single store owning the file explorer's persisted position.
 *
 * The file tree location (expanded directories, revealed/selected paths, and
 * whether the explorer is visible) is remembered per project and restored
 * across app restarts — mirroring how classic file explorers reopen where the
 * user last left off. `project-files.svelte.ts` hydrates from this store and
 * writes back through it; nothing else reads or writes the persisted snapshot.
 */
import { APP_SLUG } from '$shared/brand'

export const FILE_EXPLORER_STORAGE_KEY = `${APP_SLUG}.fileExplorer.v1`

export interface FileExplorerProjectState {
  expandedDirectories: Record<string, boolean>
  revealedPath: string | null
  selectedPaths: string[]
  explorerVisible: boolean
}

export interface FileExplorerSnapshot {
  version: 1
  projects: Record<string, FileExplorerProjectState>
}

const MAX_PATH_LENGTH = 4096
const MAX_SELECTED_PATHS = 500
/** Cap on persisted expanded directories so a huge/poisoned snapshot can't be
 *  hydrated back unbounded (protects against OOM on the next tree open). */
const MAX_EXPANDED_DIRECTORIES = 400
const MAX_EXPANDED_DEPTH = 8

export function emptyFileExplorerProjectState(): FileExplorerProjectState {
  return {
    expandedDirectories: {},
    revealedPath: null,
    selectedPaths: [],
    explorerVisible: true
  }
}

export function emptyFileExplorerSnapshot(): FileExplorerSnapshot {
  return { version: 1, projects: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH
}

function parseExpandedDirectories(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) return {}
  const expanded: Record<string, boolean> = {}
  const paths = Object.entries(value)
    .filter(
      ([path, flag]) =>
        flag === true && isValidPath(path) && path.split('/').length <= MAX_EXPANDED_DEPTH
    )
    .slice(0, MAX_EXPANDED_DIRECTORIES)
  for (const [path] of paths) expanded[path] = true
  return expanded
}

function parseSelectedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(isValidPath).slice(0, MAX_SELECTED_PATHS)
}

function parseProjectState(value: unknown): FileExplorerProjectState | null {
  if (!isRecord(value)) return null
  return {
    expandedDirectories: parseExpandedDirectories(value.expandedDirectories),
    revealedPath: isValidPath(value.revealedPath) ? value.revealedPath : null,
    selectedPaths: parseSelectedPaths(value.selectedPaths),
    explorerVisible: value.explorerVisible !== false
  }
}

/** Parse persisted explorer state without trusting localStorage contents. */
export function parseFileExplorerState(raw: string | null): FileExplorerSnapshot {
  if (!raw) return emptyFileExplorerSnapshot()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.version !== 1) return emptyFileExplorerSnapshot()
    const projects: Record<string, FileExplorerProjectState> = {}
    if (isRecord(parsed.projects)) {
      for (const [projectId, rawProject] of Object.entries(parsed.projects)) {
        const entry = parseProjectState(rawProject)
        if (entry) projects[projectId] = entry
      }
    }
    return { version: 1, projects }
  } catch {
    return emptyFileExplorerSnapshot()
  }
}

function loadSnapshot(): FileExplorerSnapshot {
  if (typeof window === 'undefined') return emptyFileExplorerSnapshot()
  try {
    return parseFileExplorerState(window.localStorage.getItem(FILE_EXPLORER_STORAGE_KEY))
  } catch {
    return emptyFileExplorerSnapshot()
  }
}

function persistSnapshot(snapshot: FileExplorerSnapshot): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(FILE_EXPLORER_STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // Explorer position is optional; unavailable storage must not break the app.
  }
}

class FileExplorerStore {
  private byProject: Record<string, FileExplorerProjectState> = $state(loadSnapshot().projects)

  /** The persisted explorer position for a project, or a fresh default. */
  project(projectId: string): FileExplorerProjectState {
    return this.byProject[projectId] ?? emptyFileExplorerProjectState()
  }

  /** Merge a patch into a project's persisted explorer position. */
  update(projectId: string, patch: Partial<FileExplorerProjectState>): void {
    this.byProject = {
      ...this.byProject,
      [projectId]: { ...this.project(projectId), ...patch }
    }
    persistSnapshot({ version: 1, projects: this.byProject })
  }
}

export const fileExplorerStore = new FileExplorerStore()
