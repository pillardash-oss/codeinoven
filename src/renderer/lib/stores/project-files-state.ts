import type {
  ProjectFileEntry,
  ProjectFileTransferMode,
  ProjectTextFile,
  TurnCheckpointFileDiff
} from '$shared/types'
import { DEFAULT_SCOPE_BUCKET_ID } from '$shared/types'
import { ipcErrorMessage } from '$lib/ipc-errors'
import { posixDirname } from '$shared/paths'
import { fileExplorerStore } from '$lib/stores/file-explorer.svelte'
import { isDocumentPreviewMime, isImageMime, isPdfMime } from '$lib/mime'

export type ProjectFileView = 'diff' | 'preview' | 'source'

export interface ProjectFileSession {
  source: ProjectTextFile
  draft: string
  saving: boolean
  error: string | null
}

export interface ProjectFileTab {
  id: string
  path: string
  origin: 'checkpoint' | 'working'
  preview: boolean
  checkpointId: string | null
  threadId: string | null
  view: ProjectFileView
  checkpointDiff: TurnCheckpointFileDiff | null
  loadingDiff: boolean
  focusLine: number | null
  focusLineRequest: number
  error: string | null
}

export interface ProjectFilesState {
  entriesByDirectory: Record<string, ProjectFileEntry[]>
  loadingDirectories: Record<string, boolean>
  directoryErrors: Record<string, string>
  expandedDirectories: Record<string, boolean>
  tabs: ProjectFileTab[]
  activeTabId: string | null
  explorerVisible: boolean
  explorerWidth: number
  revealedPath: string | null
  focusRequest: number
  fullscreenRequest: number
  selectedPaths: string[]
  selectionAnchor: string | null
  loadingPaths: Record<string, boolean>
  sessions: Record<string, ProjectFileSession>
  /** Scope bucket the cached listings were read from. */
  activeScope: string
  /** Inbox thread whose `chats-artifacts/<threadId>` directory this project's
   *  file tree is mounted on; `null` for real projects and threadless views. */
  chatThreadId: string | null
  /** Whether the "Last turn" filter is active in the file tree. Lives here
   *  (per project) instead of local component state so panel remounts from
   *  sidebar tab changes (e.g. previewing a file) do not reset it. */
  lastTurnOnly: boolean
  /** Monotonic reload tokens per path. Appended to `appfile://` preview URLs
   *  as a cache-busting `?v=` so previewable files without a text session
   *  (media, images, SVG, PDF, documents) can be re-read after the underlying
   *  file changed on disk instead of showing a stale version forever. */
  previewReloadTokens: Record<string, number>
  /** Paths whose disk content moved on after the session was read while the
   *  session still carries unsaved changes. The viewer shows a "Viewing an
   *  older version" alert for these instead of silently clobbering the draft. */
  staleFiles: Record<string, boolean>
}

export interface ProjectFileClipboard {
  projectId: string
  paths: string[]
  mode: ProjectFileTransferMode
  /** Scope bucket the copied paths are relative to. */
  scopeBucketId: string
}

export function createProjectFilesState(projectId: string): ProjectFilesState {
  const explorer = fileExplorerStore.project(projectId)
  return {
    entriesByDirectory: {},
    loadingDirectories: {},
    directoryErrors: {},
    // Start collapsed at the root. The persisted expansion set is NOT seeded
    // here so a large/poisoned snapshot can't render a huge tree on open; the
    // cheap first-open reveal (`restoreRevealedPath`) expands only the ancestor
    // chain of the last-viewed path. `revealedPath`/`selectedPaths` are kept so
    // that reveal can still land where the user left off.
    expandedDirectories: {},
    tabs: [],
    activeTabId: null,
    explorerVisible: explorer.explorerVisible,
    explorerWidth: explorer.width,
    revealedPath: explorer.revealedPath,
    focusRequest: 0,
    fullscreenRequest: 0,
    selectedPaths: [...explorer.selectedPaths],
    selectionAnchor: null,
    loadingPaths: {},
    sessions: {},
    activeScope: DEFAULT_SCOPE_BUCKET_ID,
    chatThreadId: null,
    lastTurnOnly: false,
    previewReloadTokens: {},
    staleFiles: {}
  }
}

/** Project-file errors always fall back to one message, so the store keeps its
 *  own arity while the IPC normalization itself lives in one shared helper. */
export function errorMessage(error: unknown): string {
  return ipcErrorMessage(error, 'Project files could not be loaded')
}

export function parentDirectory(path: string): string {
  return posixDirname(path)
}

export function isPreviewableBinary(mime: string): boolean {
  return isPdfMime(mime) || isImageMime(mime) || isDocumentPreviewMime(mime)
}

/** Unique top-level paths: nested entries whose ancestor is also present are
 *  dropped, longest paths first so deep deletes never run before their parent. */
export function orderDeletionPaths(paths: string[]): string[] {
  const unique = [...new Set(paths)]
  return unique
    .filter((path) => !unique.some((other) => other !== path && path.startsWith(`${other}/`)))
    .sort((a, b) => b.split('/').length - a.split('/').length)
}

/** Unique paths with any nested entry dropped, used before a multi-path paste. */
export function topLevelPaths(paths: string[]): string[] {
  const unique = [...new Set(paths)]
  return unique.filter(
    (path) => !unique.some((other) => other !== path && path.startsWith(`${other}/`))
  )
}

export function directoriesToRefresh(state: ProjectFilesState): string[] {
  return [
    '',
    ...Object.keys(state.expandedDirectories).filter(
      (directory) => state.expandedDirectories[directory]
    )
  ]
}

/** Whether a path is the given path or lives beneath it. */
export function isWithinPath(candidate: string, path: string): boolean {
  return candidate === path || candidate.startsWith(`${path}/`)
}

/**
 * Clear all explorer state for the given paths (files or folders) and their
 * subtrees: sessions, tabs, expansion, cache, reveal, and selection. Returns
 * the ids of the tabs that were closed so the caller can sync the context
 * sidebar and persist the explorer.
 */
export function removePathsInState(state: ProjectFilesState, paths: string[]): Set<string> {
  const isWithin = (candidate: string): boolean =>
    paths.some((path) => isWithinPath(candidate, path))
  for (const candidate of Object.keys(state.sessions)) {
    if (isWithin(candidate)) delete state.sessions[candidate]
  }
  const closingIds = new Set(state.tabs.filter((tab) => isWithin(tab.path)).map((tab) => tab.id))
  state.tabs = state.tabs.filter((tab) => !isWithin(tab.path))
  if (state.activeTabId && closingIds.has(state.activeTabId)) {
    state.activeTabId = state.tabs.at(-1)?.id ?? null
  }
  for (const candidate of Object.keys(state.expandedDirectories)) {
    if (isWithin(candidate)) delete state.expandedDirectories[candidate]
  }
  for (const candidate of Object.keys(state.entriesByDirectory)) {
    if (isWithin(candidate)) delete state.entriesByDirectory[candidate]
  }
  for (const candidate of Object.keys(state.directoryErrors)) {
    if (isWithin(candidate)) delete state.directoryErrors[candidate]
  }
  for (const candidate of Object.keys(state.previewReloadTokens)) {
    if (isWithin(candidate)) delete state.previewReloadTokens[candidate]
  }
  for (const candidate of Object.keys(state.staleFiles)) {
    if (isWithin(candidate)) delete state.staleFiles[candidate]
  }
  if (state.revealedPath && isWithin(state.revealedPath)) state.revealedPath = null
  state.selectedPaths = state.selectedPaths.filter((candidate) => !isWithin(candidate))
  return closingIds
}

/**
 * Rewrite tabs, sessions, and explorer subtree state when an entry (file or
 * directory) is renamed or moved. Everything under the old path is translated
 * to the new path, keeping open tabs and expansion state coherent. Returns the
 * old-to-new tab mapping so the caller can sync the context sidebar.
 */
export function remapPathInState(
  state: ProjectFilesState,
  previousPath: string,
  nextPath: string
): Map<string, { id: string; path: string }> {
  const isWithin = (candidate: string): boolean => isWithinPath(candidate, previousPath)
  const translate = (candidate: string): string =>
    candidate === previousPath ? nextPath : `${nextPath}${candidate.slice(previousPath.length)}`

  const sessions = Object.keys(state.sessions).filter(isWithin)
  for (const path of sessions) {
    const session = state.sessions[path]
    delete state.sessions[path]
    session.source = { ...session.source, path: translate(path) }
    state.sessions[translate(path)] = session
  }

  const remapped = new Map<string, { id: string; path: string }>()
  for (const tab of state.tabs.filter((candidate) => isWithin(candidate.path))) {
    const previousId = tab.id
    const nextTabPath = translate(tab.path)
    const nextId =
      tab.origin === 'working'
        ? `working:${nextTabPath}`
        : `checkpoint:${tab.threadId}:${tab.checkpointId}:${nextTabPath}`
    tab.id = nextId
    tab.path = nextTabPath
    if (state.activeTabId === previousId) state.activeTabId = nextId
    remapped.set(previousId, { id: nextId, path: nextTabPath })
  }

  for (const path of Object.keys(state.expandedDirectories).filter(isWithin)) {
    state.expandedDirectories[translate(path)] = state.expandedDirectories[path]
    delete state.expandedDirectories[path]
  }
  for (const path of Object.keys(state.entriesByDirectory).filter(isWithin)) {
    state.entriesByDirectory[translate(path)] = state.entriesByDirectory[path].map((entry) => ({
      ...entry,
      path: translate(entry.path)
    }))
    delete state.entriesByDirectory[path]
  }
  for (const path of Object.keys(state.directoryErrors).filter(isWithin)) {
    state.directoryErrors[translate(path)] = state.directoryErrors[path]
    delete state.directoryErrors[path]
  }
  for (const path of Object.keys(state.previewReloadTokens).filter(isWithin)) {
    state.previewReloadTokens[translate(path)] = state.previewReloadTokens[path]
    delete state.previewReloadTokens[path]
  }
  for (const path of Object.keys(state.staleFiles).filter(isWithin)) {
    state.staleFiles[translate(path)] = state.staleFiles[path]
    delete state.staleFiles[path]
  }
  if (state.revealedPath && isWithin(state.revealedPath)) {
    state.revealedPath = translate(state.revealedPath)
  }
  return remapped
}
