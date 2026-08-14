import type {
  ProjectFileDropResult,
  ProjectFileEntry,
  ProjectFileInfo,
  ProjectFileTransferMode,
  ProjectTextFile,
  TurnCheckpointFileDiff
} from '$shared/types'
import type { CloseConfirmationFile } from '$shared/ipc-contract'
import { invoke } from '$lib/ipc.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { fileExplorerStore } from '$lib/stores/file-explorer.svelte'
import { gitState } from '$lib/stores/git.svelte'
import { isImageMime, isPdfMime, mimeFromPath } from '$lib/mime'

/** How many levels of subfolders "Expand all" reveals below the project root,
 *  so the operation stays cheap even on very large trees. */
const EXPAND_ALL_MAX_DEPTH = 4

/** Upper bound on how deep the cheap first-open reveal will walk to land on the
 *  last-viewed path. Keeps the open cheap even for very deep repos. */
const RESTORE_MAX_DEPTH = 12

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
  revealedPath: string | null
  selectedPaths: string[]
  selectionAnchor: string | null
  loadingPaths: Record<string, boolean>
  sessions: Record<string, ProjectFileSession>
}

export interface ProjectFileClipboard {
  projectId: string
  paths: string[]
  mode: ProjectFileTransferMode
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
    revealedPath: explorer.revealedPath,
    selectedPaths: [...explorer.selectedPaths],
    selectionAnchor: null,
    loadingPaths: {},
    sessions: {}
  }
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Project files could not be loaded'
  return error.message
    .replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
    .replace(/^Error:\s*/u, '')
}

class ProjectFilesWorkspace {
  private projects: Record<string, ProjectFilesState> = $state({})
  private directoryLoads = new Map<string, Promise<void>>()
  /** Fresh project states whose persisted expansion still needs to be populated. */
  private pendingRestores = new Set<string>()
  clipboard: ProjectFileClipboard | null = $state(null)

  ensureState(projectId: string): ProjectFilesState {
    const existing = this.projects[projectId]
    if (existing) return existing
    const state = createProjectFilesState(projectId)
    this.projects[projectId] = state
    this.pendingRestores.add(projectId)
    return state
  }

  getState(projectId: string): ProjectFilesState {
    const state = this.projects[projectId]
    if (!state) throw new Error(`Project files were not prepared: ${projectId}`)
    return state
  }

  async loadDirectory(projectId: string, directory: string, force = false): Promise<void> {
    const state = this.ensureState(projectId)
    const loadKey = `${projectId}:${directory}`
    const pending = this.directoryLoads.get(loadKey)
    if (pending) return pending
    if (!force && state.entriesByDirectory[directory]) return

    const load = (async (): Promise<void> => {
      state.loadingDirectories[directory] = true
      delete state.directoryErrors[directory]
      try {
        state.entriesByDirectory[directory] = await invoke(
          'projectFiles:list',
          projectId,
          directory
        )
        // The first time the root is listed for a freshly hydrated project,
        // cheaply restore the last-viewed position: only the ancestor chain of
        // the revealed/selected path is loaded, never the whole saved set of
        // expanded folders. Loading hundreds of persisted folders at once was
        // what ballooned the renderer heap and OOM'd the app on open.
        if (directory === '' && this.pendingRestores.has(projectId)) {
          this.pendingRestores.delete(projectId)
          await this.restoreRevealedPath(projectId, state)
        }
      } catch (error) {
        state.directoryErrors[directory] = errorMessage(error)
      } finally {
        delete state.loadingDirectories[directory]
      }
    })()
    this.directoryLoads.set(loadKey, load)
    try {
      await load
    } finally {
      this.directoryLoads.delete(loadKey)
    }
  }

  /** Restore the tree's position cheaply on first open. Only the ancestor
   *  folders of the last-viewed path are expanded and loaded (bounded by the
   *  path's own depth), so the tree opens plainly at the root while still
   *  landing where the user left off — without re-hydrating the entire saved
   *  expansion set, which is what caused the V8 OOM. */
  private async restoreRevealedPath(projectId: string, state: ProjectFilesState): Promise<void> {
    const target = state.revealedPath ?? state.selectedPaths.at(-1) ?? null
    if (!target) return
    const segments = target.split('/')
    segments.pop()
    const ancestors = segments.slice(0, RESTORE_MAX_DEPTH)
    let directory = ''
    for (const segment of ancestors) {
      directory = directory ? `${directory}/${segment}` : segment
      state.expandedDirectories[directory] = true
      await this.loadDirectory(projectId, directory)
    }
  }

  /** Persist a project's file-explorer position through the single explorer store. */
  private persistExplorer(projectId: string): void {
    const state = this.projects[projectId]
    if (!state) return
    fileExplorerStore.update(projectId, {
      expandedDirectories: { ...state.expandedDirectories },
      revealedPath: state.revealedPath,
      selectedPaths: [...state.selectedPaths],
      explorerVisible: state.explorerVisible
    })
  }

  async toggleDirectory(projectId: string, directory: string): Promise<void> {
    const state = this.ensureState(projectId)
    if (state.expandedDirectories[directory]) {
      delete state.expandedDirectories[directory]
      this.persistExplorer(projectId)
      return
    }
    state.expandedDirectories[directory] = true
    this.persistExplorer(projectId)
    await this.loadDirectory(projectId, directory)
  }

  /** Collapse every expanded folder in the tree. */
  collapseAllDirectories(projectId: string): void {
    const state = this.ensureState(projectId)
    state.expandedDirectories = {}
    this.persistExplorer(projectId)
  }

  /** Expand every folder in the tree, loading their contents recursively. */
  async expandAllDirectories(projectId: string): Promise<void> {
    const state = this.ensureState(projectId)
    state.expandedDirectories = {}
    await this.expandDirectoryTree(projectId, state, '')
    this.persistExplorer(projectId)
  }

  /** Expand folders recursively up to a bounded depth, so we don't enumerate an
   *  entire repository's subtree at once. */
  private async expandDirectoryTree(
    projectId: string,
    state: ProjectFilesState,
    directory: string,
    depth = 0
  ): Promise<void> {
    if (!state.entriesByDirectory[directory]) {
      await this.loadDirectory(projectId, directory)
    }
    state.expandedDirectories[directory] = true
    if (depth >= EXPAND_ALL_MAX_DEPTH) return
    const entries = state.entriesByDirectory[directory] ?? []
    for (const entry of entries) {
      if (entry.kind === 'directory') {
        await this.expandDirectoryTree(projectId, state, entry.path, depth + 1)
      }
    }
  }

  setClipboard(projectId: string, paths: string[], mode: ProjectFileTransferMode): void {
    this.clipboard = { projectId, paths, mode }
  }

  setSelection(projectId: string, paths: string[]): void {
    this.ensureState(projectId).selectedPaths = paths
    this.persistExplorer(projectId)
  }

  clearSelection(projectId: string): void {
    const state = this.ensureState(projectId)
    state.selectedPaths = []
    state.selectionAnchor = null
    this.persistExplorer(projectId)
  }

  toggleSelection(projectId: string, path: string): void {
    const state = this.ensureState(projectId)
    state.selectedPaths = state.selectedPaths.includes(path)
      ? state.selectedPaths.filter((candidate) => candidate !== path)
      : [...state.selectedPaths, path]
    this.persistExplorer(projectId)
  }

  setSelectionAnchor(projectId: string, path: string | null): void {
    this.ensureState(projectId).selectionAnchor = path
  }

  async createFile(projectId: string, directory: string, name: string): Promise<void> {
    const entry = await this.runFileOperation(() =>
      invoke('projectFiles:create', projectId, directory, name)
    )
    await this.loadDirectory(projectId, directory, true)
    await this.openFile(projectId, entry.path)
  }

  async renameFile(projectId: string, path: string, name: string): Promise<void> {
    const state = this.ensureState(projectId)
    const next = await this.runFileOperation(() =>
      invoke('projectFiles:rename', projectId, path, name)
    )
    this.remapPath(state, projectId, path, next.path)
    await this.loadDirectory(projectId, this.parentDirectory(path), true)
  }

  async deleteFile(projectId: string, path: string): Promise<void> {
    const state = this.ensureState(projectId)
    await this.runFileOperation(() => invoke('projectFiles:delete', projectId, path))
    this.removePathsFromState(state, projectId, [path])
    await this.loadDirectory(projectId, this.parentDirectory(path), true)
  }

  async deletePaths(projectId: string, paths: string[]): Promise<void> {
    const state = this.ensureState(projectId)
    const unique = [...new Set(paths)]
    const ordered = unique
      .filter((path) => !unique.some((other) => other !== path && path.startsWith(`${other}/`)))
      .sort((a, b) => b.split('/').length - a.split('/').length)
    for (const path of ordered) {
      await this.runFileOperation(() => invoke('projectFiles:delete', projectId, path))
    }
    this.removePathsFromState(state, projectId, ordered)
    const parents = new Set(ordered.map((path) => this.parentDirectory(path)))
    await Promise.all(
      [...parents].map((directory) => this.loadDirectory(projectId, directory, true))
    )
  }

  async pasteFile(projectId: string, destinationDirectory: string): Promise<void> {
    const clipboard = this.clipboard
    if (!clipboard) return
    const unique = [...new Set(clipboard.paths)]
    const sources = unique.filter(
      (path) => !unique.some((other) => other !== path && path.startsWith(`${other}/`))
    )
    if (sources.length === 0) return
    const pasted: ProjectFileEntry[] = []
    try {
      for (const sourcePath of sources) {
        pasted.push(
          await this.runFileOperation(() =>
            invoke(
              'projectFiles:paste',
              clipboard.projectId,
              sourcePath,
              projectId,
              destinationDirectory,
              clipboard.mode
            )
          )
        )
      }
    } catch (error) {
      if (clipboard.mode === 'move') this.clipboard = null
      throw error
    }
    if (clipboard.mode === 'move') {
      this.clipboard = null
      if (clipboard.projectId === projectId) {
        for (let index = 0; index < sources.length; index += 1) {
          this.remapMovedFile(projectId, sources[index], pasted[index]?.path ?? sources[index])
        }
        await this.loadDirectory(projectId, this.parentDirectory(sources[0] ?? ''), true)
      } else {
        const sourceState = this.ensureState(clipboard.projectId)
        this.removePathsFromState(sourceState, clipboard.projectId, sources)
        for (const sourcePath of sources) {
          await this.loadDirectory(clipboard.projectId, this.parentDirectory(sourcePath), true)
        }
      }
    }
    await this.loadDirectory(projectId, destinationDirectory, true)
  }

  /** Copy external absolute paths (files or folders) into a project directory. */
  async importExternalPaths(
    projectId: string,
    sourcePaths: string[],
    destinationDirectory: string
  ): Promise<ProjectFileEntry[]> {
    if (sourcePaths.length === 0) return []
    const entries = await this.runFileOperation(() =>
      invoke('projectFiles:importPaths', projectId, sourcePaths, destinationDirectory)
    )
    await this.loadDirectory(projectId, destinationDirectory, true)
    return entries
  }

  async dropExternalPaths(
    projectId: string,
    sourcePaths: string[],
    destinationDirectory: string
  ): Promise<ProjectFileDropResult[]> {
    if (sourcePaths.length === 0) return []
    const results = await this.runFileOperation(() =>
      invoke('projectFiles:dropPaths', projectId, sourcePaths, destinationDirectory)
    )
    for (const result of results) {
      if (result.movedFrom) this.remapMovedFile(projectId, result.movedFrom, result.entry.path)
    }
    await this.refresh(projectId)
    return results
  }

  async fileInfo(projectId: string, path: string): Promise<ProjectFileInfo> {
    return this.runFileOperation(() => invoke('projectFiles:info', projectId, path))
  }

  async openFile(
    projectId: string,
    path: string,
    preferredView: ProjectFileView = 'source',
    focusLine?: number
  ): Promise<void> {
    await this.openWorkingTab(projectId, path, preferredView, false, focusLine)
  }

  /** Open a file in preview mode: a transient tab (italicised title) that is
   *  replaced the next time another file is previewed. Double-clicking a file
   *  (or opening it again in normal mode) pins it as a permanent tab. */
  async openFilePreview(projectId: string, path: string): Promise<void> {
    const state = this.ensureState(projectId)
    const tabId = `working:${path}`
    if (state.tabs.some((candidate) => candidate.id === tabId)) {
      state.activeTabId = tabId
      const threadId = contextSidebarState.threadIdForProject(projectId)
      if (threadId) contextSidebarState.openProjectFile(projectId, threadId, tabId, path, true)
      return
    }
    const previewTab = state.tabs.find(
      (candidate) => candidate.origin === 'working' && candidate.preview
    )
    if (previewTab) {
      await this.replaceWorkingTab(projectId, previewTab, path, true)
      return
    }
    await this.openWorkingTab(projectId, path, 'source', true)
  }

  async openCheckpointFile(
    projectId: string,
    checkpointId: string,
    path: string,
    preferredView: ProjectFileView = 'diff'
  ): Promise<void> {
    const state = this.ensureState(projectId)
    const threadId = contextSidebarState.threadIdForProject(projectId)
    if (!threadId) return
    const tabId = `checkpoint:${threadId}:${checkpointId}:${path}`
    if (!state.tabs.some((candidate) => candidate.id === tabId)) {
      state.tabs.push({
        id: tabId,
        path,
        origin: 'checkpoint',
        preview: false,
        checkpointId,
        threadId,
        view: preferredView,
        checkpointDiff: null,
        loadingDiff: true,
        focusLine: null,
        focusLineRequest: 0,
        error: null
      })
    }
    const tab = state.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    tab.view = preferredView
    tab.loadingDiff = true
    tab.error = null
    state.activeTabId = tabId
    contextSidebarState.openProjectFile(projectId, threadId, tabId, path)
    try {
      const [diff] = await Promise.all([
        invoke('checkpoint:diff', projectId, threadId, checkpointId, path),
        this.revealFile(projectId, path)
      ])
      const currentTab = state.tabs.find((candidate) => candidate.id === tabId)
      if (!currentTab) return
      currentTab.checkpointDiff = diff
      const session = state.sessions[path]
      if (
        diff.kind !== 'deleted' &&
        !this.isPreviewableBinary(mimeFromPath(path)) &&
        (!session || session.draft === session.source.content)
      ) {
        await this.loadCurrentFile(projectId, path)
      }
    } catch (error) {
      const currentTab = state.tabs.find((candidate) => candidate.id === tabId)
      if (currentTab) currentTab.error = errorMessage(error)
    } finally {
      const currentTab = state.tabs.find((candidate) => candidate.id === tabId)
      if (currentTab) currentTab.loadingDiff = false
    }
  }

  activateTab(projectId: string, tabId: string): void {
    const state = this.ensureState(projectId)
    if (state.tabs.some((tab) => tab.id === tabId)) state.activeTabId = tabId
  }

  focusLine(projectId: string, tabId: string, line: number): void {
    const tab = this.ensureState(projectId).tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    tab.view = 'source'
    tab.focusLine = Math.max(1, Math.floor(line))
    tab.focusLineRequest += 1
  }

  async swapFile(projectId: string, currentPath: string, nextPath: string): Promise<void> {
    const state = this.ensureState(projectId)
    const currentTabId = `working:${currentPath}`
    const nextTabId = `working:${nextPath}`

    const existingTab = state.tabs.find((t) => t.id === nextTabId)
    if (existingTab) {
      state.activeTabId = nextTabId
      this.remapOrOpenContextTab(projectId, currentTabId, nextTabId, nextPath, existingTab.preview)
      return
    }

    const tab = state.tabs.find((t) => t.id === currentTabId)
    if (!tab) return

    tab.id = nextTabId
    tab.path = nextPath
    tab.focusLine = null
    tab.focusLineRequest += 1
    tab.error = null
    const nextMime = mimeFromPath(nextPath)
    if (isPdfMime(nextMime) || isImageMime(nextMime)) tab.view = 'preview'
    state.activeTabId = nextTabId

    this.remapOrOpenContextTab(projectId, currentTabId, nextTabId, nextPath, tab.preview)

    if (state.sessions[nextPath]) return
    if (this.isPreviewableBinary(nextMime)) return

    try {
      await this.loadCurrentFile(projectId, nextPath)
    } catch (error) {
      tab.error = errorMessage(error)
    }
  }

  async swapFileSilent(projectId: string, currentPath: string, nextPath: string): Promise<void> {
    const state = this.ensureState(projectId)
    const currentTabId = `working:${currentPath}`
    const nextTabId = `working:${nextPath}`

    const existingTab = state.tabs.find((t) => t.id === nextTabId)
    if (existingTab) {
      state.activeTabId = nextTabId
      return
    }

    const tab = state.tabs.find((t) => t.id === currentTabId)
    if (!tab) return

    tab.id = nextTabId
    tab.path = nextPath
    tab.focusLine = null
    tab.focusLineRequest += 1
    tab.error = null
    const nextMime = mimeFromPath(nextPath)
    if (isPdfMime(nextMime) || isImageMime(nextMime)) tab.view = 'preview'
    state.activeTabId = nextTabId

    if (state.sessions[nextPath]) return
    if (this.isPreviewableBinary(nextMime)) return

    try {
      await this.loadCurrentFile(projectId, nextPath)
    } catch (error) {
      tab.error = errorMessage(error)
    }
  }

  closeTab(projectId: string, tabId: string): void {
    const state = this.ensureState(projectId)
    const index = state.tabs.findIndex((tab) => tab.id === tabId)
    if (index === -1) return
    const closed = state.tabs[index]
    state.tabs.splice(index, 1)
    if (!state.tabs.some((tab) => tab.path === closed.path)) {
      delete state.sessions[closed.path]
    }
    if (state.activeTabId !== tabId) return
    state.activeTabId = state.tabs[index]?.id ?? state.tabs[index - 1]?.id ?? null
  }

  toggleExplorer(projectId: string): void {
    const state = this.ensureState(projectId)
    state.explorerVisible = !state.explorerVisible
    this.persistExplorer(projectId)
  }

  async revealDirectory(projectId: string, directory: string): Promise<void> {
    const state = this.ensureState(projectId)
    state.explorerVisible = true
    state.revealedPath = directory || null
    const segments = directory.split('/').filter(Boolean)
    const ancestors = segments.map((_, index) => segments.slice(0, index + 1).join('/'))
    for (const ancestor of ancestors) {
      state.expandedDirectories[ancestor] = true
      await this.loadDirectory(projectId, ancestor)
    }
    this.persistExplorer(projectId)
  }

  async revealFile(projectId: string, path: string): Promise<void> {
    const state = this.ensureState(projectId)
    state.explorerVisible = true
    await this.loadDirectory(projectId, '')
    await this.revealDirectory(projectId, this.parentDirectory(path))
    state.revealedPath = path
    state.selectedPaths = [path]
    this.persistExplorer(projectId)
  }

  setRevealedPath(projectId: string, path: string | null): void {
    const state = this.ensureState(projectId)
    state.revealedPath = path
    this.persistExplorer(projectId)
  }

  markDirectoryExpanded(projectId: string, directory: string): void {
    const state = this.ensureState(projectId)
    state.expandedDirectories[directory] = true
    this.persistExplorer(projectId)
  }

  setView(projectId: string, tabId: string, view: ProjectFileView): void {
    const state = this.ensureState(projectId)
    const tab = state.tabs.find((candidate) => candidate.id === tabId)
    if (tab) tab.view = view
  }

  updateDraft(projectId: string, path: string, content: string): void {
    const state = this.ensureState(projectId)
    const session = state.sessions[path]
    if (!session) return
    session.draft = content
    // Editing a preview tab pins it — the user is actively working on the file.
    if (session.draft !== session.source.content) {
      const tab = state.tabs.find(
        (candidate) => candidate.origin === 'working' && candidate.path === path
      )
      if (tab && tab.preview) {
        tab.preview = false
        contextSidebarState.pinProjectFile(projectId, tab.id)
      }
    }
  }

  async save(projectId: string, path: string): Promise<void> {
    const session = this.ensureState(projectId).sessions[path]
    if (!session || session.saving || session.draft === session.source.content) {
      return
    }
    session.saving = true
    session.error = null
    const submittedDraft = session.draft
    try {
      const source = await invoke(
        'projectFiles:save',
        projectId,
        path,
        submittedDraft,
        session.source.revision
      )
      session.source = source
      if (session.draft === submittedDraft) session.draft = source.content
      await this.reconcileConflictAfterSave(projectId, path)
    } catch (error) {
      session.error = errorMessage(error)
    } finally {
      session.saving = false
    }
  }

  /**
   * After a successful editor save, mark the path resolved in git when it was
   * a conflicted file and no conflict markers remain. The main side stages it
   * (`git add`), which clears the unmerged index entry and lets the git panel
   * drop it from the conflicted list.
   */
  private async reconcileConflictAfterSave(projectId: string, path: string): Promise<void> {
    if (gitState.activeProjectId !== projectId) return
    if (!gitState.conflicted.includes(path)) return
    await gitState.resolveConflicted(projectId, path)
  }

  async reload(projectId: string, path: string): Promise<void> {
    const state = this.ensureState(projectId)
    const session = state.sessions[path]
    if (session) session.error = null
    state.loadingPaths[path] = true
    try {
      const source = await invoke('projectFiles:read', projectId, path)
      state.sessions[path] = {
        source,
        draft: source.content,
        saving: false,
        error: null
      }
    } catch (error) {
      if (session) session.error = errorMessage(error)
      else {
        const tab = state.tabs.find((candidate) => candidate.path === path)
        if (tab) tab.error = errorMessage(error)
      }
    } finally {
      delete state.loadingPaths[path]
    }
  }

  async refresh(projectId: string, activePath?: string): Promise<void> {
    const state = this.ensureState(projectId)
    const directories = [
      '',
      ...Object.keys(state.expandedDirectories).filter(
        (directory) => state.expandedDirectories[directory]
      )
    ]
    await Promise.all(
      directories.map((directory) => this.loadDirectory(projectId, directory, true))
    )
    const path = activePath ?? state.tabs.find((tab) => tab.id === state.activeTabId)?.path
    if (!path) return
    const session = state.sessions[path]
    if (session && session.draft === session.source.content) {
      await this.reload(projectId, path)
    }
  }

  private async openWorkingTab(
    projectId: string,
    path: string,
    preferredView: ProjectFileView,
    preview: boolean,
    focusLine?: number
  ): Promise<void> {
    const mime = mimeFromPath(path)
    if (isPdfMime(mime) || isImageMime(mime)) preferredView = 'preview'
    const state = this.ensureState(projectId)
    const tabId = `working:${path}`
    let tab = state.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) {
      tab = {
        id: tabId,
        path,
        origin: 'working',
        preview,
        checkpointId: null,
        threadId: null,
        view: preferredView,
        checkpointDiff: null,
        loadingDiff: false,
        focusLine: null,
        focusLineRequest: 0,
        error: null
      }
      state.tabs.push(tab)
    } else {
      tab.preview = preview
      tab.view = preferredView
      tab.error = null
    }
    if (focusLine !== undefined) {
      tab.focusLine = Math.max(1, Math.floor(focusLine))
      tab.focusLineRequest += 1
    }
    state.activeTabId = tabId
    const threadId = contextSidebarState.threadIdForProject(projectId)
    if (threadId) contextSidebarState.openProjectFile(projectId, threadId, tabId, path, preview)
    if (state.sessions[path]) return
    if (this.isPreviewableBinary(mime)) return

    try {
      await this.loadCurrentFile(projectId, path)
    } catch (error) {
      tab.error = errorMessage(error)
    }
  }

  /** Point a working tab at a different path, keeping its position in the tab
   *  strip and its preview/normal mode. Used to swap a preview tab to a newly
   *  clicked file. */
  private async replaceWorkingTab(
    projectId: string,
    tab: ProjectFileTab,
    nextPath: string,
    preview: boolean
  ): Promise<void> {
    const state = this.ensureState(projectId)
    const currentTabId = tab.id
    const nextTabId = `working:${nextPath}`
    const existingTab = state.tabs.find((candidate) => candidate.id === nextTabId)
    if (existingTab) {
      state.activeTabId = nextTabId
      this.remapOrOpenContextTab(projectId, currentTabId, nextTabId, nextPath, preview)
      return
    }

    tab.id = nextTabId
    tab.path = nextPath
    tab.preview = preview
    tab.focusLine = null
    tab.focusLineRequest += 1
    tab.error = null
    tab.checkpointDiff = null
    tab.loadingDiff = false
    const nextMime = mimeFromPath(nextPath)
    if (isPdfMime(nextMime) || isImageMime(nextMime)) tab.view = 'preview'
    state.activeTabId = nextTabId

    this.remapOrOpenContextTab(projectId, currentTabId, nextTabId, nextPath, preview)

    if (state.sessions[nextPath]) return
    if (this.isPreviewableBinary(nextMime)) return

    try {
      await this.loadCurrentFile(projectId, nextPath)
    } catch (error) {
      tab.error = errorMessage(error)
    }
  }

  private async loadCurrentFile(projectId: string, path: string): Promise<void> {
    const state = this.ensureState(projectId)
    if (state.loadingPaths[path]) return
    state.loadingPaths[path] = true
    try {
      const source = await invoke('projectFiles:read', projectId, path)
      state.sessions[path] = {
        source,
        draft: source.content,
        saving: false,
        error: null
      }
    } finally {
      delete state.loadingPaths[path]
    }
  }

  /** Repoint a sidebar tab at a different file tab, or create one when the
   *  workspace tab has no matching sidebar tab (its tab may have been closed).
   *  Prevents a single file click from silently failing to show a preview. */
  private remapOrOpenContextTab(
    projectId: string,
    previousTabId: string,
    nextTabId: string,
    nextPath: string,
    preview: boolean
  ): void {
    const remapped = contextSidebarState.remapProjectFile(
      projectId,
      previousTabId,
      nextTabId,
      nextPath
    )
    if (remapped) return
    const threadId = contextSidebarState.threadIdForProject(projectId)
    if (threadId)
      contextSidebarState.openProjectFile(projectId, threadId, nextTabId, nextPath, preview)
  }

  /** Pin an open file tab (stop showing it as an italic preview) — used when
   *  the user starts editing the file. */
  pinTab(projectId: string, tabId: string): void {
    const state = this.ensureState(projectId)
    const tab = state.tabs.find((candidate) => candidate.id === tabId)
    if (!tab || !tab.preview) return
    tab.preview = false
    contextSidebarState.pinProjectFile(projectId, tab.id)
  }

  /** Files with unsaved edits across every prepared project. */
  getUnsavedFiles(): CloseConfirmationFile[] {
    const files: CloseConfirmationFile[] = []
    for (const projectId of Object.keys(this.projects)) {
      const state = this.projects[projectId]
      for (const session of Object.values(state.sessions)) {
        if (session.draft !== session.source.content) {
          files.push({ projectId, path: session.source.path })
        }
      }
    }
    return files
  }

  /** Save every unsaved file across all projects. Returns false if any save
   *  failed (the caller should keep the app open). */
  async saveAllUnsaved(): Promise<boolean> {
    let saved = true
    for (const projectId of Object.keys(this.projects)) {
      const state = this.projects[projectId]
      for (const path of Object.keys(state.sessions)) {
        const session = state.sessions[path]
        if (session.draft === session.source.content || session.saving) continue
        const submittedDraft = session.draft
        try {
          const source = await invoke(
            'projectFiles:save',
            projectId,
            path,
            submittedDraft,
            session.source.revision
          )
          session.source = source
          if (session.draft === submittedDraft) session.draft = source.content
        } catch {
          session.error = 'The file could not be saved'
          saved = false
        }
      }
    }
    return saved
  }

  private parentDirectory(path: string): string {
    const segments = path.split('/')
    segments.pop()
    return segments.join('/')
  }

  private isPreviewableBinary(mime: string): boolean {
    return isPdfMime(mime) || isImageMime(mime)
  }

  /** Clear all explorer state for the given paths (files or folders) and their
   *  subtrees: sessions, tabs, expansion, cache, reveal, and selection. */
  private removePathsFromState(state: ProjectFilesState, projectId: string, paths: string[]): void {
    const isWithin = (candidate: string): boolean =>
      paths.some((path) => candidate === path || candidate.startsWith(`${path}/`))
    for (const candidate of Object.keys(state.sessions)) {
      if (isWithin(candidate)) delete state.sessions[candidate]
    }
    const closingIds = new Set(state.tabs.filter((tab) => isWithin(tab.path)).map((tab) => tab.id))
    state.tabs = state.tabs.filter((tab) => !isWithin(tab.path))
    if (state.activeTabId && closingIds.has(state.activeTabId)) {
      state.activeTabId = state.tabs.at(-1)?.id ?? null
    }
    contextSidebarState.closeProjectFile(projectId, closingIds)
    for (const candidate of Object.keys(state.expandedDirectories)) {
      if (isWithin(candidate)) delete state.expandedDirectories[candidate]
    }
    for (const candidate of Object.keys(state.entriesByDirectory)) {
      if (isWithin(candidate)) delete state.entriesByDirectory[candidate]
    }
    for (const candidate of Object.keys(state.directoryErrors)) {
      if (isWithin(candidate)) delete state.directoryErrors[candidate]
    }
    if (state.revealedPath && isWithin(state.revealedPath)) state.revealedPath = null
    state.selectedPaths = state.selectedPaths.filter((candidate) => !isWithin(candidate))
    this.persistExplorer(projectId)
  }

  private remapMovedFile(projectId: string, previousPath: string, nextPath: string): void {
    const state = this.ensureState(projectId)
    this.remapPath(state, projectId, previousPath, nextPath)
  }

  /** Rewrite tabs, sessions, and explorer subtree state when an entry (file or
   *  directory) is renamed or moved. Everything under the old path is translated
   *  to the new path, keeping open tabs and expansion state coherent. */
  private remapPath(
    state: ProjectFilesState,
    projectId: string,
    previousPath: string,
    nextPath: string
  ): void {
    const isWithin = (candidate: string): boolean =>
      candidate === previousPath || candidate.startsWith(`${previousPath}/`)
    const translate = (candidate: string): string =>
      candidate === previousPath ? nextPath : `${nextPath}${candidate.slice(previousPath.length)}`

    const sessions = Object.keys(state.sessions).filter(isWithin)
    for (const path of sessions) {
      const session = state.sessions[path]
      delete state.sessions[path]
      session.source = { ...session.source, path: translate(path) }
      state.sessions[translate(path)] = session
    }

    const remapped: Record<string, { id: string; path: string }> = {}
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
      remapped[previousId] = { id: nextId, path: nextTabPath }
    }
    for (const previousId of Object.keys(remapped)) {
      const next = remapped[previousId]
      contextSidebarState.remapProjectFile(projectId, previousId, next.id, next.path)
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
    if (state.revealedPath && isWithin(state.revealedPath)) {
      state.revealedPath = translate(state.revealedPath)
    }
    this.persistExplorer(projectId)
  }

  private async runFileOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      throw new Error(errorMessage(error), { cause: error })
    }
  }
}

export const projectFilesWorkspace = new ProjectFilesWorkspace()
