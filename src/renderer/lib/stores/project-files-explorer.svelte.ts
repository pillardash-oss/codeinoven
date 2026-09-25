import type {
  DirectoryPreviewSession,
  ProjectFileDropResult,
  ProjectFileEntry,
  ProjectFileInfo,
  ProjectFileTransferMode
} from '$shared/types'
import { invoke } from '$lib/ipc.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { clampFileExplorerWidth, fileExplorerStore } from '$lib/stores/file-explorer.svelte'
import {
  errorMessage,
  orderDeletionPaths,
  parentDirectory,
  removePathsInState,
  remapPathInState,
  topLevelPaths,
  type ProjectFileClipboard,
  type ProjectFilesState
} from './project-files-state'

/** How many levels of subfolders "Expand all" reveals below the project root,
 *  so the operation stays cheap even on very large trees. */
const EXPAND_ALL_MAX_DEPTH = 4

/** Upper bound on how deep the cheap first-open reveal will walk to land on the
 *  last-viewed path. Keeps the open cheap even for very deep repos. */
const RESTORE_MAX_DEPTH = 12

/** How long a directory's background refresh may be debounced after an
 *  expand/collapse, so rapid toggles coalesce into a single re-read. */
const BACKGROUND_REFRESH_DEBOUNCE_MS = 300

/**
 * Directory-tree and selection state the explorer controller needs from the
 * project-files workspace. The store owns the per-project state record and the
 * tab/session subsystem; the explorer owns directory loading, the tree cache,
 * selection, clipboard, and the file-operation IPC.
 */
export interface ProjectFilesExplorerHost {
  stateFor(projectId: string): ProjectFilesState
  existingState(projectId: string): ProjectFilesState | undefined
  scopeFor(projectId: string): string
  threadArg(projectId: string): string | undefined
  mountKeyFor(projectId: string): string
  openFile(projectId: string, path: string): Promise<void>
  refresh(projectId: string): Promise<void>
}

/**
 * Per-project file-explorer operations: directory listing and expansion, the
 * reveal/selection model, the clipboard, and the create/rename/delete/paste
 * file operations. All per-project state lives in the shared ProjectFilesState
 * owned by the workspace; this controller only holds the transient scheduling
 * maps and the clipboard.
 */
export class ProjectFilesExplorer {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  private directoryLoads = new Map<string, Promise<void>>()
  /** Pending debounced silent refreshes, keyed `projectId:directory`. A plain
   *  Map (not $state) keeps the scheduler allocation-free and off reactivity. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  private backgroundRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  private focusGenerations = new Map<string, number>()
  /** Fresh project states whose persisted expansion still needs to be populated. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  private pendingRestores = new Set<string>()
  clipboard: ProjectFileClipboard | null = $state(null)

  constructor(private readonly host: ProjectFilesExplorerHost) {}

  /** Mark a freshly created project state for the cheap first-open reveal. */
  markPendingRestore(projectId: string): void {
    this.pendingRestores.add(projectId)
  }

  /** Whether the cached listings describe the mount the tree should now
   *  render. `true` while nothing is loaded yet   an empty tree is not stale,
   *  the panel is simply reading. A mounted tree that survives a thread switch
   *  uses this to warn that it still shows another scope's root. */
  listingsMatchMount(projectId: string): boolean {
    const state = this.host.existingState(projectId)
    if (!state || state.listingMountKey === null) return true
    return state.listingMountKey === this.host.mountKeyFor(projectId)
  }

  async loadDirectory(
    projectId: string,
    directory: string,
    force = false,
    options: { silent?: boolean } = {}
  ): Promise<void> {
    const state = this.host.stateFor(projectId)
    // A scope or chat-mount switch (thread opened in another bucket, sidebar
    // bucket change, thread change) invalidates every cached listing so the
    // tree re-reads the new root.
    const mountKey = this.host.mountKeyFor(projectId)
    if (state.activeScope !== mountKey) {
      state.activeScope = mountKey
      // The held entries belonged to the previous mount and are being dropped,
      // so nothing is renderable until the new root answers.
      state.listingMountKey = null
      state.entriesByDirectory = {}
      state.loadingDirectories = {}
      state.directoryErrors = {}
      for (const key of [...this.directoryLoads.keys()]) {
        if (key.startsWith(`${projectId}:`)) this.directoryLoads.delete(key)
      }
    }
    const loadKey = `${projectId}:${mountKey}:${directory}`
    const pending = this.directoryLoads.get(loadKey)
    if (pending) return pending
    if (!force && state.entriesByDirectory[directory]) return

    const load = (async (): Promise<void> => {
      // Silent refreshes never surface loading spinners in the explorer; the
      // existing listing stays visible until a successful read replaces it.
      if (!options.silent) state.loadingDirectories[directory] = true
      delete state.directoryErrors[directory]
      try {
        state.entriesByDirectory[directory] = await invoke(
          'projectFiles:list',
          projectId,
          directory,
          this.host.scopeFor(projectId),
          this.host.threadArg(projectId)
        )
        state.listingMountKey = mountKey
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
        if (options.silent) {
          // A failed silent refresh drops the stale cache (the entry may have
          // been deleted externally) without flashing an error banner; the next
          // user-driven load retries and surfaces any real error normally.
          delete state.entriesByDirectory[directory]
        } else {
          state.directoryErrors[directory] = errorMessage(error)
        }
      } finally {
        if (!options.silent) delete state.loadingDirectories[directory]
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
   *  landing where the user left off, without re-hydrating the entire saved
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
    const state = this.host.existingState(projectId)
    if (!state) return
    fileExplorerStore.update(projectId, {
      expandedDirectories: { ...state.expandedDirectories },
      revealedPath: state.revealedPath,
      selectedPaths: [...state.selectedPaths],
      explorerVisible: state.explorerVisible,
      width: state.explorerWidth
    })
  }

  setLastTurnOnly(projectId: string, value: boolean): void {
    this.host.stateFor(projectId).lastTurnOnly = value
  }

  async toggleDirectory(projectId: string, directory: string): Promise<void> {
    const state = this.host.stateFor(projectId)
    if (state.expandedDirectories[directory]) {
      delete state.expandedDirectories[directory]
      this.persistExplorer(projectId)
      // Collapsed folders are not rendered, so refresh silently in the
      // background: the cache is fresh the next time the user expands. Never
      // loaded folders have nothing to refresh.
      if (state.entriesByDirectory[directory]) {
        this.scheduleBackgroundRefresh(projectId, directory)
      }
      return
    }
    state.expandedDirectories[directory] = true
    this.persistExplorer(projectId)
    // A cached listing may be stale (external tooling changed files outside
    // the tree). Load the cached version immediately for responsiveness, then
    // refresh silently so no refresh click is ever needed.
    const wasCached = Boolean(state.entriesByDirectory[directory])
    if (wasCached) this.scheduleBackgroundRefresh(projectId, directory)
    await this.loadDirectory(projectId, directory)
  }

  /** Schedule a deduped, debounced background re-read of one directory so its
   *  cached listing picks up changes made outside the app. All work happens in
   *  the main process's async fs pipeline (`projectFiles:list`), so neither the
   *  renderer nor the main thread is ever blocked; only one timer per
   *  directory is allocated and rapid toggles collapse into a single request. */
  private scheduleBackgroundRefresh(projectId: string, directory: string): void {
    const key = `${projectId}:${directory}`
    const pending = this.backgroundRefreshTimers.get(key)
    if (pending) clearTimeout(pending)
    const timer = setTimeout(() => {
      this.backgroundRefreshTimers.delete(key)
      // A user-driven load may already be in flight for this key; the shared
      // directoryLoads dedupe makes this a no-op then.
      void this.loadDirectory(projectId, directory, true, { silent: true })
    }, BACKGROUND_REFRESH_DEBOUNCE_MS)
    this.backgroundRefreshTimers.set(key, timer)
  }

  /** Collapse every expanded folder in the tree. */
  collapseAllDirectories(projectId: string): void {
    const state = this.host.stateFor(projectId)
    state.expandedDirectories = {}
    this.persistExplorer(projectId)
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
  async expandAndLoadDirectories(
    projectId: string,
    directories: string[],
    persist = true
  ): Promise<void> {
    const state = this.host.stateFor(projectId)
    for (const directory of directories) {
      state.expandedDirectories[directory] = true
    }
    if (persist) this.persistExplorer(projectId)
    await Promise.all(directories.map((directory) => this.loadDirectory(projectId, directory)))
  }

  /** Collapse a batch of directories without loading anything (used to revert
   *  transient search-driven expansions when the filter closes). */
  collapseDirectories(projectId: string, directories: string[], persist = true): void {
    const state = this.host.stateFor(projectId)
    for (const directory of directories) {
      delete state.expandedDirectories[directory]
    }
    if (persist) this.persistExplorer(projectId)
  }

  /** Expand every folder in the tree, loading their contents recursively. */
  async expandAllDirectories(projectId: string): Promise<void> {
    const state = this.host.stateFor(projectId)
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
    this.clipboard = {
      projectId,
      paths,
      mode,
      scopeBucketId: this.host.scopeFor(projectId)
    }
  }

  setSelection(projectId: string, paths: string[]): void {
    this.host.stateFor(projectId).selectedPaths = paths
    this.persistExplorer(projectId)
  }

  clearSelection(projectId: string): void {
    const state = this.host.stateFor(projectId)
    state.selectedPaths = []
    state.selectionAnchor = null
    this.persistExplorer(projectId)
  }

  toggleSelection(projectId: string, path: string): void {
    const state = this.host.stateFor(projectId)
    state.selectedPaths = state.selectedPaths.includes(path)
      ? state.selectedPaths.filter((candidate) => candidate !== path)
      : [...state.selectedPaths, path]
    this.persistExplorer(projectId)
  }

  setSelectionAnchor(projectId: string, path: string | null): void {
    this.host.stateFor(projectId).selectionAnchor = path
  }

  async createFile(projectId: string, directory: string, name: string): Promise<void> {
    const entry = await this.runFileOperation(() =>
      invoke(
        'projectFiles:create',
        projectId,
        directory,
        name,
        this.host.scopeFor(projectId),
        this.host.threadArg(projectId)
      )
    )
    await this.loadDirectory(projectId, directory, true)
    await this.host.openFile(projectId, entry.path)
  }

  async createDirectory(projectId: string, directory: string, name: string): Promise<void> {
    await this.runFileOperation(() =>
      invoke(
        'projectFiles:createDirectory',
        projectId,
        directory,
        name,
        this.host.scopeFor(projectId),
        this.host.threadArg(projectId)
      )
    )
    await this.loadDirectory(projectId, directory, true)
  }

  async renameFile(projectId: string, path: string, name: string): Promise<void> {
    const state = this.host.stateFor(projectId)
    const next = await this.runFileOperation(() =>
      invoke(
        'projectFiles:rename',
        projectId,
        path,
        name,
        this.host.scopeFor(projectId),
        this.host.threadArg(projectId)
      )
    )
    this.remapPath(state, projectId, path, next.path)
    await this.loadDirectory(projectId, parentDirectory(path), true)
  }

  async deleteFile(projectId: string, path: string): Promise<void> {
    const state = this.host.stateFor(projectId)
    await this.runFileOperation(() =>
      invoke(
        'projectFiles:delete',
        projectId,
        path,
        this.host.scopeFor(projectId),
        this.host.threadArg(projectId)
      )
    )
    this.removePathsFromState(state, projectId, [path])
    await this.loadDirectory(projectId, parentDirectory(path), true)
  }

  async deletePaths(projectId: string, paths: string[]): Promise<void> {
    const state = this.host.stateFor(projectId)
    const ordered = orderDeletionPaths(paths)
    for (const path of ordered) {
      await this.runFileOperation(() =>
        invoke(
          'projectFiles:delete',
          projectId,
          path,
          this.host.scopeFor(projectId),
          this.host.threadArg(projectId)
        )
      )
    }
    this.removePathsFromState(state, projectId, ordered)
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const parents = new Set(ordered.map((path) => parentDirectory(path)))
    await Promise.all(
      [...parents].map((directory) => this.loadDirectory(projectId, directory, true))
    )
  }

  async pasteFile(projectId: string, destinationDirectory: string): Promise<void> {
    const clipboard = this.clipboard
    if (!clipboard) return
    const sources = topLevelPaths(clipboard.paths)
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
              clipboard.mode,
              clipboard.scopeBucketId,
              this.host.scopeFor(projectId),
              this.host.threadArg(clipboard.projectId),
              this.host.threadArg(projectId)
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
        await this.loadDirectory(projectId, parentDirectory(sources[0] ?? ''), true)
      } else {
        const sourceState = this.host.stateFor(clipboard.projectId)
        this.removePathsFromState(sourceState, clipboard.projectId, sources)
        for (const sourcePath of sources) {
          await this.loadDirectory(clipboard.projectId, parentDirectory(sourcePath), true)
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
      invoke(
        'projectFiles:importPaths',
        projectId,
        sourcePaths,
        destinationDirectory,
        this.host.scopeFor(projectId),
        this.host.threadArg(projectId)
      )
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
      invoke(
        'projectFiles:dropPaths',
        projectId,
        sourcePaths,
        destinationDirectory,
        this.host.scopeFor(projectId),
        this.host.threadArg(projectId)
      )
    )
    for (const result of results) {
      if (result.movedFrom) this.remapMovedFile(projectId, result.movedFrom, result.entry.path)
    }
    await this.host.refresh(projectId)
    return results
  }

  async fileInfo(projectId: string, path: string): Promise<ProjectFileInfo> {
    return this.runFileOperation(() =>
      invoke(
        'projectFiles:info',
        projectId,
        path,
        this.host.scopeFor(projectId),
        this.host.threadArg(projectId)
      )
    )
  }

  /**
   * Serve a project directory (or the directory holding one HTML file) from a
   * loopback origin so a page's own scripts, stylesheets, and relative and
   * absolute asset URLs all resolve. Returns the URL to open in a browser.
   */
  async openDirectoryPreview(projectId: string, path: string): Promise<DirectoryPreviewSession> {
    return this.runFileOperation(() =>
      invoke(
        'directoryPreview:open',
        projectId,
        path,
        this.host.scopeFor(projectId),
        this.host.threadArg(projectId)
      )
    )
  }

  toggleExplorer(projectId: string): void {
    const state = this.host.stateFor(projectId)
    state.explorerVisible = !state.explorerVisible
    this.persistExplorer(projectId)
  }

  setExplorerWidth(projectId: string, width: number, persist = true): void {
    const state = this.host.stateFor(projectId)
    state.explorerWidth = clampFileExplorerWidth(width)
    if (persist) this.persistExplorer(projectId)
  }

  async revealDirectory(projectId: string, directory: string): Promise<void> {
    const state = this.host.stateFor(projectId)
    const generation = this.beginFocus(projectId)
    state.explorerVisible = true
    await this.expandDirectoryPath(projectId, state, directory)
    if (!this.isCurrentFocus(projectId, generation)) return
    state.revealedPath = directory || null
    state.selectedPaths = directory ? [directory] : []
    state.selectionAnchor = directory || null
    state.focusRequest += 1
    this.persistExplorer(projectId)
  }

  private beginFocus(projectId: string): number {
    const generation = (this.focusGenerations.get(projectId) ?? 0) + 1
    this.focusGenerations.set(projectId, generation)
    return generation
  }

  private isCurrentFocus(projectId: string, generation: number): boolean {
    return this.focusGenerations.get(projectId) === generation
  }

  private async expandDirectoryPath(
    projectId: string,
    state: ProjectFilesState,
    directory: string
  ): Promise<void> {
    const segments = directory.split('/').filter(Boolean)
    const ancestors = segments.map((_, index) => segments.slice(0, index + 1).join('/'))
    for (const ancestor of ancestors) {
      state.expandedDirectories[ancestor] = true
      await this.loadDirectory(projectId, ancestor)
    }
  }

  async revealFile(projectId: string, path: string): Promise<void> {
    const state = this.host.stateFor(projectId)
    const generation = this.beginFocus(projectId)
    state.explorerVisible = true
    await this.loadDirectory(projectId, '')
    await this.expandDirectoryPath(projectId, state, parentDirectory(path))
    if (!this.isCurrentFocus(projectId, generation)) return
    state.revealedPath = path
    state.selectedPaths = [path]
    state.selectionAnchor = path
    state.focusRequest += 1
    this.persistExplorer(projectId)
  }

  /** Keep a mounted explorer aligned with the active file tab without opening
   *  an explorer that the user chose to hide. */
  async focusFileInExplorer(projectId: string, path: string): Promise<void> {
    const state = this.host.stateFor(projectId)
    const generation = this.beginFocus(projectId)
    await this.loadDirectory(projectId, '')
    await this.expandDirectoryPath(projectId, state, parentDirectory(path))
    if (!this.isCurrentFocus(projectId, generation)) return
    state.revealedPath = path
    state.selectedPaths = [path]
    state.selectionAnchor = path
    state.focusRequest += 1
    this.persistExplorer(projectId)
  }

  setRevealedPath(projectId: string, path: string | null): void {
    const state = this.host.stateFor(projectId)
    state.revealedPath = path
    this.persistExplorer(projectId)
  }

  markDirectoryExpanded(projectId: string, directory: string): void {
    const state = this.host.stateFor(projectId)
    state.expandedDirectories[directory] = true
    this.persistExplorer(projectId)
  }

  /** Clear explorer state for the given paths and sync the context sidebar. */
  private removePathsFromState(state: ProjectFilesState, projectId: string, paths: string[]): void {
    const closingIds = removePathsInState(state, paths)
    contextSidebarState.closeProjectFile(projectId, closingIds)
    this.persistExplorer(projectId)
  }

  private remapMovedFile(projectId: string, previousPath: string, nextPath: string): void {
    const state = this.host.stateFor(projectId)
    this.remapPath(state, projectId, previousPath, nextPath)
  }

  /** Rewrite tabs, sessions, and explorer subtree state when an entry (file or
   *  directory) is renamed or moved, then repoint the context sidebar. */
  private remapPath(
    state: ProjectFilesState,
    projectId: string,
    previousPath: string,
    nextPath: string
  ): void {
    const remapped = remapPathInState(state, previousPath, nextPath)
    for (const [previousId, next] of remapped) {
      const tab = state.tabs.find((candidate) => candidate.id === next.id)
      contextSidebarState.remapProjectFile(
        projectId,
        previousId,
        next.id,
        next.path,
        tab?.preview ?? false,
        false
      )
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
