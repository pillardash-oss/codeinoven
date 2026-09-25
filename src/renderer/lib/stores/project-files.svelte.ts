import type {
  DirectoryPreviewSession,
  ProjectFileDropResult,
  ProjectFileEntry,
  ProjectFileInfo,
  ProjectFileTransferMode
} from '$shared/types'
import { usesThreadWorkspaceMount } from '$shared/types'
import type { CloseConfirmationFile } from '$shared/ipc-contract'
import { invoke } from '$lib/ipc.svelte'
import { contextSidebarState, type FilesContextTab } from '$lib/stores/context-sidebar.svelte'
import { gitState } from '$lib/stores/git.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import {
  isDocumentPreviewMime,
  isImageMime,
  isPdfMime,
  mimeFromPath,
  supportsFilePreview
} from '$lib/mime'
import { ProjectFilesExplorer } from './project-files-explorer.svelte'
import {
  createProjectFilesState,
  directoriesToRefresh,
  documentViewFor,
  errorMessage,
  followingDocumentView,
  isPreviewableBinary,
  type ProjectFileClipboard,
  type ProjectFileTab,
  type ProjectFileView,
  type ProjectFilesState
} from './project-files-state'

export type {
  ProjectFileClipboard,
  ProjectFileSession,
  ProjectFilesState,
  ProjectFileTab,
  ProjectFileView
} from './project-files-state'
export { createProjectFilesState } from './project-files-state'

class ProjectFilesWorkspace {
  private projects: Record<string, ProjectFilesState> = $state({})

  private explorer = new ProjectFilesExplorer({
    stateFor: (projectId) => this.ensureState(projectId),
    existingState: (projectId) => this.projects[projectId],
    scopeFor: (projectId) => this.scopeFor(projectId),
    threadArg: (projectId) => this.threadArg(projectId),
    mountKeyFor: (projectId) => this.mountKeyFor(projectId),
    openFile: (projectId, path) => this.openFile(projectId, path),
    refresh: (projectId) => this.refresh(projectId)
  })

  get clipboard(): ProjectFileClipboard | null {
    return this.explorer.clipboard
  }

  set clipboard(value: ProjectFileClipboard | null) {
    this.explorer.clipboard = value
  }

  /** The scope bucket the project's file operations must target right now.
   *  This value is sent to the main process, so it must stay a real scope
   *  bucket id. A mounted conversation workspace is threaded separately via
   *  `threadArg`; only cache keys below use the mount-aware key. */
  private scopeFor(projectId: string): string {
    return workspaceState.activeScopeBucketIdFor(projectId)
  }

  /** Internal cache/invalidation key that also distinguishes which conversation
   *  workspace mount (if any) the cached listings belong to. Never sent over
   *  IPC, so the `thread:` prefix is safe here. */
  private mountKeyFor(projectId: string): string {
    const threadId = this.projects[projectId]?.mountThreadId ?? null
    if (threadId && usesThreadWorkspaceMount(projectId)) return `thread:${threadId}`
    return this.scopeFor(projectId)
  }

  /** Register the conversation whose own workspace directory the file tree is
   *  mounted on (a chat's artifact directory or an assistant task's working
   *  directory). Switching threads (or unmounting) changes the effective
   *  scope, so every cached listing is dropped and re-read. */
  setThreadMount(projectId: string, threadId: string | null): void {
    this.ensureState(projectId).mountThreadId = threadId
  }

  /** Optional trailing thread-mount argument for `projectFiles:*` invokes. */
  private threadArg(projectId: string): string | undefined {
    return this.projects[projectId]?.mountThreadId ?? undefined
  }

  ensureState(projectId: string): ProjectFilesState {
    const existing = this.projects[projectId]
    if (existing) return existing
    const state = createProjectFilesState(projectId)
    this.projects[projectId] = state
    this.explorer.markPendingRestore(projectId)
    return state
  }

  getState(projectId: string): ProjectFilesState {
    const state = this.projects[projectId]
    if (!state) throw new Error(`Project files were not prepared: ${projectId}`)
    return state
  }

  setLastTurnOnly(projectId: string, value: boolean): void {
    this.explorer.setLastTurnOnly(projectId, value)
  }

  loadDirectory(
    projectId: string,
    directory: string,
    force = false,
    options: { silent?: boolean } = {}
  ): Promise<void> {
    return this.explorer.loadDirectory(projectId, directory, force, options)
  }

  /** Whether the cached listings describe the mount the tree should now render.
   *  A mounted file tree reads this to warn that it is still showing another
   *  scope's root after the open thread moved to a different worktree. */
  listingsMatchMount(projectId: string): boolean {
    return this.explorer.listingsMatchMount(projectId)
  }

  toggleDirectory(projectId: string, directory: string): Promise<void> {
    return this.explorer.toggleDirectory(projectId, directory)
  }

  /** Collapse every expanded folder in the tree. */
  collapseAllDirectories(projectId: string): void {
    this.explorer.collapseAllDirectories(projectId)
  }

  /** Expand a batch of directories (e.g. every ancestor of search results) and
   *  load their contents in parallel. The explorer snapshot is persisted once
   *  after the whole batch instead of once per directory, persisting per
   *  expansion serialized the full snapshot to localStorage on every folder and
   *  froze the renderer during searches on large trees.
   *
   *  `persist` is false for search-driven expansions: they are transient view
   *  state, and persisting them would leave huge subtrees (e.g. `.cio`) marked
   *  expanded across sessions, which slows every later tree render. */
  expandAndLoadDirectories(
    projectId: string,
    directories: string[],
    persist = true
  ): Promise<void> {
    return this.explorer.expandAndLoadDirectories(projectId, directories, persist)
  }

  /** Collapse a batch of directories without loading anything (used to revert
   *  transient search-driven expansions when the filter closes). */
  collapseDirectories(projectId: string, directories: string[], persist = true): void {
    this.explorer.collapseDirectories(projectId, directories, persist)
  }

  /** Expand every folder in the tree, loading their contents recursively. */
  expandAllDirectories(projectId: string): Promise<void> {
    return this.explorer.expandAllDirectories(projectId)
  }

  setClipboard(projectId: string, paths: string[], mode: ProjectFileTransferMode): void {
    this.explorer.setClipboard(projectId, paths, mode)
  }

  setSelection(projectId: string, paths: string[]): void {
    this.explorer.setSelection(projectId, paths)
  }

  clearSelection(projectId: string): void {
    this.explorer.clearSelection(projectId)
  }

  toggleSelection(projectId: string, path: string): void {
    this.explorer.toggleSelection(projectId, path)
  }

  setSelectionAnchor(projectId: string, path: string | null): void {
    this.explorer.setSelectionAnchor(projectId, path)
  }

  createFile(projectId: string, directory: string, name: string): Promise<void> {
    return this.explorer.createFile(projectId, directory, name)
  }

  createDirectory(projectId: string, directory: string, name: string): Promise<void> {
    return this.explorer.createDirectory(projectId, directory, name)
  }

  renameFile(projectId: string, path: string, name: string): Promise<void> {
    return this.explorer.renameFile(projectId, path, name)
  }

  deleteFile(projectId: string, path: string): Promise<void> {
    return this.explorer.deleteFile(projectId, path)
  }

  deletePaths(projectId: string, paths: string[]): Promise<void> {
    return this.explorer.deletePaths(projectId, paths)
  }

  pasteFile(projectId: string, destinationDirectory: string): Promise<void> {
    return this.explorer.pasteFile(projectId, destinationDirectory)
  }

  /** Copy external absolute paths (files or folders) into a project directory. */
  importExternalPaths(
    projectId: string,
    sourcePaths: string[],
    destinationDirectory: string
  ): Promise<ProjectFileEntry[]> {
    return this.explorer.importExternalPaths(projectId, sourcePaths, destinationDirectory)
  }

  dropExternalPaths(
    projectId: string,
    sourcePaths: string[],
    destinationDirectory: string
  ): Promise<ProjectFileDropResult[]> {
    return this.explorer.dropExternalPaths(projectId, sourcePaths, destinationDirectory)
  }

  fileInfo(projectId: string, path: string): Promise<ProjectFileInfo> {
    return this.explorer.fileInfo(projectId, path)
  }

  /**
   * Serve a project directory (or the directory holding one HTML file) from a
   * loopback origin so a page's own scripts, stylesheets, and relative and
   * absolute asset URLs all resolve. Returns the URL to open in a browser.
   */
  openDirectoryPreview(projectId: string, path: string): Promise<DirectoryPreviewSession> {
    return this.explorer.openDirectoryPreview(projectId, path)
  }

  async openFile(
    projectId: string,
    path: string,
    preferredView: ProjectFileView = 'source',
    focusLine?: number
  ): Promise<void> {
    if (this.focusOpenFileTab(projectId, path, focusLine)) {
      // Double-clicking (or otherwise opening in normal mode) a file that is
      // already open as a preview tab pins it. focusOpenFileTab only focuses,
      // so without this the preview flag survived and the next single-click
      // kept replacing the tab instead of opening a new preview beside it.
      this.pinTab(projectId, `working:${path}`)
      return
    }
    await this.openWorkingTab(projectId, path, preferredView, false, focusLine)
  }

  /** Open a file in preview mode: a transient tab (italicised title) that is
   *  replaced the next time another file is previewed. Double-clicking a file
   *  (or opening it again in normal mode) pins it as a permanent tab. When the
   *  user is already viewing a file in preview mode and the new file also
   *  supports preview, the new file opens straight in preview mode instead of
   *  falling back to the default view. */
  async openFilePreview(projectId: string, path: string): Promise<void> {
    const state = this.ensureState(projectId)
    if (this.focusOpenFileTab(projectId, path)) return
    const previewTab = state.tabs.find(
      (candidate) => candidate.origin === 'working' && candidate.preview
    )
    if (previewTab) {
      await this.replaceWorkingTab(projectId, previewTab, path, true)
      return
    }
    const activeTab = state.tabs.find((candidate) => candidate.id === state.activeTabId)
    await this.openWorkingTab(projectId, path, followingDocumentView(activeTab?.view, path), true)
  }

  /** Focus an existing sidebar file tab by path before any caller creates a
   *  working-file tab. This also reuses checkpoint tabs, while preferring the
   *  currently active match and then the ordinary working-file tab. */
  private focusOpenFileTab(projectId: string, path: string, focusLine?: number): boolean {
    const matchingTabs = contextSidebarState.tabs.filter(
      (tab): tab is FilesContextTab =>
        tab.kind === 'files' &&
        tab.projectId === projectId &&
        tab.path === path &&
        tab.fileTabId !== null
    )
    if (matchingTabs.length === 0) return false

    const activeTab = contextSidebarState.activeTab
    const target =
      (activeTab?.kind === 'files' && matchingTabs.find((tab) => tab.id === activeTab.id)) ||
      matchingTabs.find((tab) => tab.fileTabId === `working:${path}`) ||
      matchingTabs.at(-1)
    if (!target?.fileTabId) return false

    const state = this.ensureState(projectId)
    const fileTab = state.tabs.find((tab) => tab.id === target.fileTabId)
    if (!fileTab) return false
    const wasActive = state.activeTabId === fileTab.id
    state.activeTabId = fileTab.id
    if (focusLine !== undefined && fileTab.origin === 'working') {
      fileTab.view = 'source'
      fileTab.focusLine = Math.max(1, Math.floor(focusLine))
      fileTab.focusLineRequest += 1
    }
    // Re-selecting a previewable file re-reads it: the file may have changed
    // on disk since it was last previewed (agent writes, git operations,
    // external editors), and a stable `appfile://` URL would keep showing the
    // stale version. Only non-active tabs re-read; an explicit Reload is
    // always available for the already-active one.
    if (!wasActive && supportsFilePreview(path)) {
      this.reloadPreview(projectId, path)
    }
    // Navigating to an already-open text file re-reads it from disk (unless
    // dirty, see reconcileFile), so switching tabs never shows stale text.
    if (!wasActive && state.sessions[path]) {
      void this.reconcileFile(projectId, path)
    }
    contextSidebarState.focus(target.id)
    return true
  }

  /** Force a previewable file's media/SVG/PDF/document preview to re-read the
   *  file from disk. These files have no editable text session, so the
   *  ordinary text Reload path does not apply; bumping the reload token
   *  changes the preview URL, which re-creates the element and re-fetches. */
  reloadPreview(projectId: string, path: string): void {
    const state = this.ensureState(projectId)
    state.previewReloadTokens[path] = (state.previewReloadTokens[path] ?? 0) + 1
  }

  /** Reconcile a cached session with the file on disk after navigation.
   *  Cheap first: when mtime and size still match the session's snapshot,
   *  nothing happens. When the file moved on, a not-dirty session is silently
   *  re-read (navigation reloads the file); a session with unsaved changes is
   *  flagged stale so the viewer can show the "Viewing an older version"
   *  alert instead of clobbering the draft. */
  private async reconcileFile(projectId: string, path: string): Promise<void> {
    const state = this.ensureState(projectId)
    const session = state.sessions[path]
    if (!session) return
    try {
      const info = await invoke(
        'projectFiles:info',
        projectId,
        path,
        this.scopeFor(projectId),
        this.threadArg(projectId)
      )
      if (info.modifiedAt === session.source.modifiedAt && info.size === session.source.size) {
        delete state.staleFiles[path]
        return
      }
      const source = await invoke(
        'projectFiles:read',
        projectId,
        path,
        this.scopeFor(projectId),
        this.threadArg(projectId)
      )
      if (!source) return
      const current = state.sessions[path]
      if (!current || current.source.revision === source.revision) {
        delete state.staleFiles[path]
        return
      }
      if (current.draft !== current.source.content) {
        // Unsaved changes must survive: flag the session as viewing an older
        // version so the user can copy their changes and reload explicitly.
        state.staleFiles[path] = true
        return
      }
      state.sessions[path] = {
        source,
        draft: source.content,
        saving: false,
        error: null
      }
      delete state.staleFiles[path]
    } catch {
      // A failed background reconcile keeps the cached session; explicit
      // reloads and saves surface real errors.
    }
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
    // Keep the viewer's document view sticky while the user walks a checkpoint
    // file list: when the currently active tab is in preview or annotation mode
    // and the new file supports that view, open it the same way instead of the
    // diff view, so the user never has to re-select the mode for every file.
    const activeTab = state.tabs.find((candidate) => candidate.id === state.activeTabId)
    if (preferredView === 'diff') {
      const following = followingDocumentView(activeTab?.view, path)
      if (following !== 'source') preferredView = following
    }
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
        this.explorer.revealFile(projectId, path)
      ])
      const currentTab = state.tabs.find((candidate) => candidate.id === tabId)
      if (!currentTab) return
      currentTab.checkpointDiff = diff
      const session = state.sessions[path]
      if (
        diff.kind !== 'deleted' &&
        !isPreviewableBinary(mimeFromPath(path)) &&
        (!session || session.draft === session.source.content)
      ) {
        await this.loadCurrentFile(projectId, path)
      } else if (diff.kind !== 'deleted' && session) {
        // Navigating between checkpoint files also reconciles the working
        // session with the disk version (auto-reload or stale flag).
        void this.reconcileFile(projectId, path)
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
      if (state.sessions[nextPath]) void this.reconcileFile(projectId, nextPath)
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
    tab.view = documentViewFor(tab.view, nextPath)
    state.activeTabId = nextTabId

    this.remapOrOpenContextTab(projectId, currentTabId, nextTabId, nextPath, tab.preview)

    if (state.sessions[nextPath]) {
      void this.reconcileFile(projectId, nextPath)
      return
    }
    if (isPreviewableBinary(nextMime)) return

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
      if (state.sessions[nextPath]) void this.reconcileFile(projectId, nextPath)
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
    tab.view = documentViewFor(tab.view, nextPath)
    state.activeTabId = nextTabId

    if (state.sessions[nextPath]) {
      void this.reconcileFile(projectId, nextPath)
      return
    }
    if (isPreviewableBinary(nextMime)) return

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
    this.explorer.toggleExplorer(projectId)
  }

  setExplorerWidth(projectId: string, width: number, persist = true): void {
    this.explorer.setExplorerWidth(projectId, width, persist)
  }

  revealDirectory(projectId: string, directory: string): Promise<void> {
    return this.explorer.revealDirectory(projectId, directory)
  }

  revealFile(projectId: string, path: string): Promise<void> {
    return this.explorer.revealFile(projectId, path)
  }

  /** Keep a mounted explorer aligned with the active file tab without opening
   *  an explorer that the user chose to hide. */
  focusFileInExplorer(projectId: string, path: string): Promise<void> {
    return this.explorer.focusFileInExplorer(projectId, path)
  }

  setRevealedPath(projectId: string, path: string | null): void {
    this.explorer.setRevealedPath(projectId, path)
  }

  markDirectoryExpanded(projectId: string, directory: string): void {
    this.explorer.markDirectoryExpanded(projectId, directory)
  }

  setView(projectId: string, tabId: string, view: ProjectFileView): void {
    const state = this.ensureState(projectId)
    const tab = state.tabs.find((candidate) => candidate.id === tabId)
    if (tab) tab.view = view
  }

  requestFullscreen(projectId: string): void {
    this.ensureState(projectId).fullscreenActive = true
  }

  setFullscreenActive(projectId: string, active: boolean): void {
    this.ensureState(projectId).fullscreenActive = active
  }

  updateDraft(projectId: string, path: string, content: string): void {
    const state = this.ensureState(projectId)
    const session = state.sessions[path]
    if (!session) return
    session.draft = content
    // Editing a preview tab pins it, the user is actively working on the file.
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
        session.source.revision,
        this.scopeFor(projectId),
        this.threadArg(projectId)
      )
      session.source = source
      if (session.draft === submittedDraft) session.draft = source.content
      // After saving, the session matches the disk version by construction.
      delete this.ensureState(projectId).staleFiles[path]
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
      const source = await invoke(
        'projectFiles:read',
        projectId,
        path,
        this.scopeFor(projectId),
        this.threadArg(projectId)
      )
      if (!source) throw new Error('This file cannot be opened in the sidebar')
      state.sessions[path] = {
        source,
        draft: source.content,
        saving: false,
        error: null
      }
      // The re-read content is current, so any stale-version flag is moot.
      delete state.staleFiles[path]
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
    const directories = directoriesToRefresh(state)
    await Promise.all(
      directories.map((directory) => this.explorer.loadDirectory(projectId, directory, true))
    )
    const path = activePath ?? state.tabs.find((tab) => tab.id === state.activeTabId)?.path
    if (!path) return
    const session = state.sessions[path]
    if (session) {
      if (session.draft === session.source.content) {
        await this.reload(projectId, path)
      }
      return
    }
    // Previewable files without a text session (media, images, SVG, PDF,
    // documents) re-read their preview content instead of being skipped, so
    // Refresh also picks up files that changed on disk.
    if (supportsFilePreview(path)) this.reloadPreview(projectId, path)
  }

  private async openWorkingTab(
    projectId: string,
    path: string,
    preferredView: ProjectFileView,
    preview: boolean,
    focusLine?: number
  ): Promise<void> {
    const mime = mimeFromPath(path)
    if (isPdfMime(mime) || isImageMime(mime) || isDocumentPreviewMime(mime))
      preferredView = 'preview'
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
    if (isPreviewableBinary(mime)) return

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
      if (state.sessions[nextPath]) void this.reconcileFile(projectId, nextPath)
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
    tab.view = documentViewFor(tab.view, nextPath)
    state.activeTabId = nextTabId

    this.remapOrOpenContextTab(projectId, currentTabId, nextTabId, nextPath, preview)

    if (state.sessions[nextPath]) {
      void this.reconcileFile(projectId, nextPath)
      return
    }
    if (isPreviewableBinary(nextMime)) return

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
      const source = await invoke(
        'projectFiles:read',
        projectId,
        path,
        this.scopeFor(projectId),
        this.threadArg(projectId)
      )
      if (!source) throw new Error('This file cannot be opened in the sidebar')
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
      nextPath,
      preview,
      true
    )
    if (remapped) return
    const threadId = contextSidebarState.threadIdForProject(projectId)
    if (threadId)
      contextSidebarState.openProjectFile(projectId, threadId, nextTabId, nextPath, preview)
  }

  /** Pin an open file tab (stop showing it as an italic preview), used when
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
            session.source.revision,
            this.scopeFor(projectId),
            this.threadArg(projectId)
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
}

export const projectFilesWorkspace = new ProjectFilesWorkspace()
