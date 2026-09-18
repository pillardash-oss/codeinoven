<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { toast } from 'svelte-sonner'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import type { ProjectFileEntry, ProjectFileInfo, ProjectFileTransferMode } from '$shared/types'
  import { invoke } from '$lib/ipc.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { copyText } from '$lib/copy-text'
  import { openInBrowser } from '$lib/open-in-browser'
  import { clampFileExplorerWidth } from '$lib/stores/file-explorer.svelte'
  import { projectFilesWorkspace, type ProjectFilesState } from '$lib/stores/project-files.svelte'
  import { findNavState } from '$lib/stores/find-nav.svelte'
  import { cioSearchVisibility, isCioScratchPath } from '$lib/stores/cio-search-visibility.svelte'
  import ProjectFileContextMenu from './ProjectFileContextMenu.svelte'
  import ProjectFileExplorerDialogs from './ProjectFileExplorerDialogs.svelte'
  import ProjectFileExplorerFilters from './ProjectFileExplorerFilters.svelte'
  import ProjectFileExplorerHeader from './ProjectFileExplorerHeader.svelte'
  import ProjectFileExplorerTreeRow from './ProjectFileExplorerTreeRow.svelte'
  import {
    buildEntryIndexFromEntries,
    buildEntryRowIndex,
    buildRowIndexByKey,
    buildTreeRows,
    collectAncestorDirectories,
    collectSearchResultDirectories,
    computeFilterMatchesByDirectory,
    computeVirtualTree,
    droppedFilePaths,
    parentDirectory,
    pasteDirectory,
    pastedFilePaths,
    selectionLabel,
    selectionPathsFor,
    TREE_ROW_HEIGHT,
    TREE_VERTICAL_PADDING,
    visibleEntries,
    type InlineEdit
  } from './project-file-explorer-tree'

  interface Props {
    projectId: string
    projectName: string
    projectState: ProjectFilesState
    onWidthChange: (width: number, persist: boolean) => void
    selectedPath: string | null
    lastTurnPaths: string[]
    activeCheckpointId: string | null
    /** Paths changed by the active checkpoint tab, used to keep browsing in diff view. */
    activeCheckpointPaths?: string[]
    /**
     * Paths currently in a merge/rebase conflict. When non-empty, a "Conflicts"
     * filter button appears below "Last turn"; toggling it reveals only the
     * conflicted files so the user can resolve them one by one.
     */
    conflictPaths?: string[]
    /** Whether the Conflicts filter is active (shared with the git panel routing). */
    conflictsOnly?: boolean
    onToggleConflicts?: () => void
    onFileSelect?: (path: string, mode: 'normal' | 'preview') => void
  }

  let {
    projectId,
    projectName,
    projectState,
    onWidthChange,
    selectedPath,
    lastTurnPaths,
    activeCheckpointId,
    activeCheckpointPaths = [],
    conflictPaths = [],
    conflictsOnly = false,
    onToggleConflicts,
    onFileSelect = undefined
  }: Props = $props()
  let filterQuery = $state('')
  let filterOpen = $state(false)
  let revealedSearchPath = $state<string | null>(null)
  /** Backed by the per-project files store so sidebar tab remounts keep it. */
  let lastTurnOnly = $derived(projectState.lastTurnOnly)
  let autoFiltered = $state(false)
  /** Set when the user manually turns the auto-applied "Last turn" filter
   *  off. While set, checkpoint navigation must not silently re-enable the
   *  filter; it clears once the user leaves checkpoint files entirely. */
  let lastTurnAutoOverride = $state(false)
  let searchRequestId = 0
  /** Directories the user explicitly collapsed while a filter (search query or
   *  last-turn mode) is active. Filtered trees force-render matching folders
   *  regardless of expansion state, so a deliberate fold must be remembered
   *  here to actually hide the subtree again. Cleared whenever a new filter
   *  session starts (query change, filter close, last-turn toggle). */
  let collapsedOverrides = new SvelteSet<string>()
  /** Directories expanded by the current search, so closing the filter can
   *  revert them. Search expansions are transient view state: persisting them
   *  would leave huge subtrees (e.g. `.cio`) marked expanded across sessions. */
  let searchExpandedDirectories = new SvelteSet<string>()
  /** Paths the backend index search matched for the current query. The tree
   *  filter trusts these instead of re-implementing matching locally, so
   *  intention-based queries ("settings/", "settings/*") surface the files
   *  inside a matched directory rather than just an empty folder row. */
  let searchResultPaths = new SvelteSet<string>()
  /** The trimmed query the stored search results correspond to; empty when no
   *  fresh results are available and the local fallback filter applies. */
  let searchResultsQuery = ''
  let lastAppliedCheckpointId = $state<string | null>(null)
  let inlineEdit = $state<InlineEdit | null>(null)
  let operationPending = $state(false)
  /** Guards the browser preview action while a loopback server is starting. */
  let browserPreviewPending = $state(false)
  let deleteTarget = $state<{ paths: string[]; label: string } | null>(null)
  let info = $state<ProjectFileInfo | null>(null)
  let treeScroll = $state<HTMLDivElement | null>(null)
  let treeScrollTop = $state(0)
  let treeViewportHeight = $state(0)
  let filterInput = $state<HTMLInputElement | null>(null)
  let dropActive = $state(false)
  let dropTargetPath = $state<string | null>(null)
  let dropIndicator = $state<{ path: string; position: 'before' | 'after' } | null>(null)
  let dropFolder = $state<string | null>(null)
  let dropExpandTimer: ReturnType<typeof setTimeout> | undefined
  let dropHoverPath: string | null = null
  let treeBusy = $state(false)
  let resizing = $state(false)
  let stopResize: (() => void) | null = null
  /** When true, the next reveal scroll is suppressed. Set during a pointer
   *  interaction on the tree so a user clicking a row isn't yanked around;
   *  cleared on a macrotask so external reveals still auto-scroll. */
  let suppressRevealScroll = false
  const lastTurnPathSet = $derived(new Set(lastTurnPaths))
  const conflictPathSet = $derived(new Set(conflictPaths))

  let searchResultDirectories = $derived(collectSearchResultDirectories(searchResultPaths))

  let treeFilterInput = $derived({
    entriesByDirectory: projectState.entriesByDirectory,
    expandedDirectories: projectState.expandedDirectories,
    directoryErrors: projectState.directoryErrors,
    inlineEdit,
    filterQuery,
    lastTurnOnly,
    conflictsOnly,
    lastTurnPathSet,
    conflictPathSet,
    filterOpen,
    includeCio: cioSearchVisibility.includeCio,
    searchResultPaths,
    searchResultsQuery,
    searchResultDirectories,
    collapsedOverrides
  })
  let filterMatchesByDirectory = $derived(computeFilterMatchesByDirectory(treeFilterInput))
  let treeRows = $derived(buildTreeRows(treeFilterInput, filterMatchesByDirectory))
  let topLevelVisibleEntries = $derived(
    visibleEntries('', treeFilterInput, filterMatchesByDirectory)
  )

  /** Entry-only view preserves the existing keyboard and range-selection model. */
  let visibleRows = $derived.by((): ProjectFileEntry[] => {
    const entries: ProjectFileEntry[] = []
    for (const row of treeRows) {
      if (row.kind === 'entry') entries.push(row.entry)
    }
    return entries
  })

  let rowIndexByPath = $derived(buildEntryIndexFromEntries(visibleRows))
  let treeRowIndexByPath = $derived(buildEntryRowIndex(treeRows))
  let treeRowIndexByKey = $derived(buildRowIndexByKey(treeRows))

  let virtualTree = $derived(computeVirtualTree(treeRows, treeScrollTop, treeViewportHeight))

  $effect(() => {
    const checkpointId = activeCheckpointId
    if (checkpointId && checkpointId !== lastAppliedCheckpointId) {
      lastAppliedCheckpointId = checkpointId
      if (lastTurnAutoOverride) return
      projectFilesWorkspace.setLastTurnOnly(projectId, true)
      autoFiltered = true
    } else if (!checkpointId) {
      lastAppliedCheckpointId = null
      if (autoFiltered) {
        projectFilesWorkspace.setLastTurnOnly(projectId, false)
        autoFiltered = false
      }
      lastTurnAutoOverride = false
    }
  })

  $effect(() => {
    const query = filterQuery.trim()
    const includeCio = cioSearchVisibility.includeCio
    const requestId = ++searchRequestId

    if (!query) {
      searchResultsQuery = ''
      searchResultPaths.clear()
      return
    }

    const timer = setTimeout(async () => {
      try {
        const results = (
          await invoke(
            'projectFiles:search',
            projectId,
            query,
            'all',
            workspaceState.activeScopeBucketIdFor(projectId),
            projectState.chatThreadId ?? undefined
          )
        ).filter((entry) => includeCio || !isCioScratchPath(entry.path))
        if (requestId !== searchRequestId) return

        searchResultsQuery = query
        searchResultPaths.clear()
        for (const result of results) searchResultPaths.add(result.path)

        const dirsToLoad = new SvelteSet<string>()
        for (const result of results) {
          const segments = result.path.split('/')
          for (let i = 1; i < segments.length; i++) {
            dirsToLoad.add(segments.slice(0, i).join('/'))
          }
        }

        const directories = [...dirsToLoad]
        for (const directory of directories) {
          if (!projectState.expandedDirectories[directory]) {
            searchExpandedDirectories.add(directory)
          }
        }

        // Expand + load every matching folder in one batch. Marking each
        // directory expanded and persisting the explorer snapshot per folder
        // serialized the whole snapshot to localStorage once per expansion and
        // froze the renderer on large trees. Search-driven expansions are
        // transient, so they do not pollute the persisted explorer state.
        await projectFilesWorkspace.expandAndLoadDirectories(projectId, directories, false)
      } catch {
        // search failed silently
      }
    }, 200)

    return () => clearTimeout(timer)
  })

  /** Re-scroll the currently active file into view after a filter toggle.
   *  The reveal effect only fires on focus-request/path/entry changes, so
   *  toggling "Last turn" or "Conflicts" would otherwise leave the viewport
   *  wherever it was, even though the active row stayed selected. */
  async function revealActivePathAfterFilterChange(): Promise<void> {
    const path = revealedSearchPath ?? selectedPath ?? projectState.revealedPath
    if (!path) return
    await tick()
    if (treeRowIndexByPath.has(path)) scrollTreePathIntoView(path)
  }

  function toggleLastTurnFilter(): void {
    const next = !lastTurnOnly
    projectFilesWorkspace.setLastTurnOnly(projectId, next)
    if (!next) {
      if (autoFiltered) lastTurnAutoOverride = true
      autoFiltered = false
    }
    clearCollapsedOverrides()
    if (!next) void revealActivePathAfterFilterChange()
  }

  function toggleConflictsFilter(): void {
    onToggleConflicts?.()
    clearCollapsedOverrides()
    void revealActivePathAfterFilterChange()
  }

  function clearSearchExpansions(): void {
    if (searchExpandedDirectories.size === 0) return
    projectFilesWorkspace.collapseDirectories(projectId, [...searchExpandedDirectories])
    searchExpandedDirectories.clear()
  }

  function clearCollapsedOverrides(): void {
    if (collapsedOverrides.size > 0) collapsedOverrides.clear()
  }

  function handleResizeKeydown(event: KeyboardEvent): void {
    const delta = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0
    if (delta === 0) return
    event.preventDefault()
    onWidthChange(clampFileExplorerWidth(projectState.explorerWidth + delta), true)
  }

  function startResize(event: PointerEvent): void {
    event.preventDefault()
    event.stopPropagation()
    if (stopResize) return

    resizing = true
    const startX = event.clientX
    const startWidth = projectState.explorerWidth
    let nextWidth = startWidth

    const finish = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      stopResize = null
      resizing = false
      onWidthChange(nextWidth, true)
    }
    const onMove = (moveEvent: PointerEvent): void => {
      nextWidth = clampFileExplorerWidth(startWidth + startX - moveEvent.clientX)
      onWidthChange(nextWidth, false)
    }

    stopResize = finish
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  function handleFilterInput(event: Event): void {
    if (!(event.currentTarget instanceof HTMLInputElement)) return
    const nextQuery = event.currentTarget.value
    if (nextQuery === filterQuery) return
    searchRequestId += 1
    clearSearchExpansions()
    clearCollapsedOverrides()
    filterQuery = nextQuery
  }

  onDestroy(() => {
    stopResize?.()
    clearSearchExpansions()
  })

  onMount(() => {
    if (selectedPath) void projectFilesWorkspace.focusFileInExplorer(projectId, selectedPath)
  })

  async function openFilter(): Promise<void> {
    filterOpen = true
    await tick()
    filterInput?.focus()
    filterInput?.select()
  }

  function closeFilter(clearReveal = true): void {
    searchRequestId += 1
    clearSearchExpansions()
    filterQuery = ''
    filterOpen = false
    clearCollapsedOverrides()
    if (clearReveal) revealedSearchPath = null
  }

  function canPaste(): boolean {
    return projectFilesWorkspace.clipboard !== null
  }

  /** Track the scroll viewport without making every tree row reactive. */
  function attachTreeScroll(node: HTMLDivElement): () => void {
    treeScroll = node
    treeScrollTop = node.scrollTop
    treeViewportHeight = node.clientHeight
    const onScroll = (): void => {
      treeScrollTop = node.scrollTop
    }
    const resizeObserver = new ResizeObserver(() => {
      treeViewportHeight = node.clientHeight
    })
    node.addEventListener('scroll', onScroll, { passive: true })
    resizeObserver.observe(node)
    return () => {
      node.removeEventListener('scroll', onScroll)
      resizeObserver.disconnect()
      if (treeScroll === node) treeScroll = null
    }
  }

  function scrollTreeIndexIntoView(index: number): void {
    const scroll = treeScroll
    if (!scroll || index < 0) return
    const top = TREE_VERTICAL_PADDING + index * TREE_ROW_HEIGHT
    const bottom = top + TREE_ROW_HEIGHT
    const viewportTop = scroll.scrollTop
    const viewportBottom = viewportTop + scroll.clientHeight
    let nextTop = viewportTop
    if (top < viewportTop) nextTop = top
    else if (bottom > viewportBottom) nextTop = bottom - scroll.clientHeight
    if (nextTop === viewportTop) return
    scroll.scrollTop = nextTop
    treeScrollTop = nextTop
  }

  function scrollTreePathIntoView(path: string): void {
    const index = treeRowIndexByPath.get(path)
    if (index !== undefined) scrollTreeIndexIntoView(index)
  }

  function scrollTreeKeyIntoView(key: string): void {
    const index = treeRowIndexByKey.get(key)
    if (index !== undefined) scrollTreeIndexIntoView(index)
  }

  async function focusRevealedTreePath(path: string, focusRequest: number): Promise<void> {
    await tick()
    if (projectState.focusRequest !== focusRequest) return
    scrollTreePathIntoView(path)
    await tick()
    if (projectState.focusRequest !== focusRequest) return
    const row = [...(treeScroll?.querySelectorAll<HTMLElement>('[data-tree-path]') ?? [])].find(
      (element) => element.dataset.treePath === path
    )
    row?.focus()
  }

  $effect(() => {
    const focusRequest = projectState.focusRequest
    const path = revealedSearchPath ?? selectedPath ?? projectState.revealedPath
    if (!path || !projectState.entriesByDirectory[parentDirectory(path)]) return
    if (suppressRevealScroll) return
    void focusRevealedTreePath(path, focusRequest)
  })

  /** Suppress the auto-reveal scroll for the rest of the current pointer
   *  interaction. The flag is cleared on a macrotask so it stays active through
   *  the whole click event-turn (pointerdown -> click -> effect microtask flush)
   *  while still letting external navigation (`revealFile`/`revealDirectory`,
   *  agent links, file-changes card) scroll the tree into view. */
  function suppressScrollForPointer(): void {
    suppressRevealScroll = true
    setTimeout(() => {
      suppressRevealScroll = false
    }, 0)
  }

  /** Toggle a directory row, tracking the collapse while a filter is active so
   *  folding during search actually hides the subtree (the filter's force-render
   *  would otherwise keep it visible). Only one of `expandedDirectories` and
   *  `collapsedOverrides` is true for a path at a time. */
  async function toggleDirectoryRow(entry: ProjectFileEntry): Promise<void> {
    const filterActive = Boolean(filterQuery.trim()) || lastTurnOnly
    const wasExpanded = Boolean(projectState.expandedDirectories[entry.path])
    if (!filterActive) {
      searchExpandedDirectories.delete(entry.path)
      collapsedOverrides.delete(entry.path)
    } else {
      // Once the user touches a search-expanded directory, it is no longer
      // owned by the search session. This preserves an explicit user expansion
      // when the filter closes and prevents a later cleanup from undoing it.
      searchExpandedDirectories.delete(entry.path)
      if (wasExpanded) {
        // Record the override before the store call so the chevron and subtree
        // change in the same render, rather than leaving a one-tick mismatch.
        collapsedOverrides.add(entry.path)
        const prefix = `${entry.path}/`
        const transientDescendants = [...searchExpandedDirectories].filter((path) =>
          path.startsWith(prefix)
        )
        if (transientDescendants.length > 0) {
          projectFilesWorkspace.collapseDirectories(projectId, transientDescendants, false)
          for (const path of transientDescendants) searchExpandedDirectories.delete(path)
        }
      } else {
        collapsedOverrides.delete(entry.path)
      }
    }
    await projectFilesWorkspace.toggleDirectory(projectId, entry.path)
  }

  async function selectEntry(
    entry: ProjectFileEntry,
    mode: 'normal' | 'preview' = 'preview'
  ): Promise<void> {
    suppressScrollForPointer()
    projectFilesWorkspace.setRevealedPath(projectId, entry.path)
    projectFilesWorkspace.setSelection(projectId, [entry.path])
    projectFilesWorkspace.setSelectionAnchor(projectId, entry.path)
    // Selecting a file result keeps the filter active so the user can preview
    // multiple matches. Folder rows in the filtered tree are ordinary tree
    // rows: clicking one must toggle it, or the user can never fold/unfold
    // folders while searching.
    const selectedFromSearch = filterOpen && Boolean(filterQuery.trim()) && entry.kind === 'file'
    if (selectedFromSearch) {
      revealedSearchPath = entry.path
    } else if (entry.kind === 'directory') {
      await toggleDirectoryRow(entry)
    }

    if (entry.kind === 'file') {
      if (onFileSelect) {
        onFileSelect(entry.path, mode)
      } else if (lastTurnOnly && activeCheckpointId && activeCheckpointPaths.includes(entry.path)) {
        await projectFilesWorkspace.openCheckpointFile(
          projectId,
          activeCheckpointId,
          entry.path,
          'diff'
        )
      } else if (mode === 'normal') {
        await projectFilesWorkspace.openFile(projectId, entry.path)
      } else {
        await projectFilesWorkspace.openFilePreview(projectId, entry.path)
      }
    }
  }

  function isRowActive(path: string): boolean {
    if (revealedSearchPath === path) return true
    if (selectedPath) return selectedPath === path
    if (projectState.selectedPaths.includes(path)) return true
    return projectState.revealedPath === path
  }

  function extendSelectionTo(path: string): void {
    const anchor = projectState.selectionAnchor ?? projectState.selectedPaths.at(-1) ?? path
    const anchorIndex = rowIndexByPath.get(anchor)
    const targetIndex = rowIndexByPath.get(path)
    if (anchorIndex === undefined || targetIndex === undefined) {
      projectFilesWorkspace.setSelection(projectId, [path])
      projectFilesWorkspace.setSelectionAnchor(projectId, path)
      return
    }
    const start = Math.min(anchorIndex, targetIndex)
    const end = Math.max(anchorIndex, targetIndex)
    projectFilesWorkspace.setSelection(
      projectId,
      visibleRows.slice(start, end + 1).map((entry) => entry.path)
    )
  }

  function handleRowClick(entry: ProjectFileEntry, event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey) {
      projectFilesWorkspace.toggleSelection(projectId, entry.path)
      projectFilesWorkspace.setSelectionAnchor(projectId, entry.path)
      return
    }
    if (event.shiftKey) {
      extendSelectionTo(entry.path)
      return
    }
    void selectEntry(entry, 'preview')
  }

  function handleRowDoubleClick(entry: ProjectFileEntry, event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return
    if (entry.kind !== 'file') return
    void selectEntry(entry, 'normal')
  }

  function handleRowContextMenu(entry: ProjectFileEntry): void {
    if (!projectState.selectedPaths.includes(entry.path)) {
      projectFilesWorkspace.setSelection(projectId, [entry.path])
      projectFilesWorkspace.setSelectionAnchor(projectId, entry.path)
    }
  }

  function focusRow(path: string): void {
    scrollTreePathIntoView(path)
    void tick().then(() => {
      const row = [...(treeScroll?.querySelectorAll<HTMLElement>('[data-tree-path]') ?? [])].find(
        (element) => element.dataset.treePath === path
      )
      row?.focus()
    })
  }

  /** Directory a newly created file should land in, based on the focused row. */
  function createTargetDirectory(target: EventTarget | null): string {
    const row =
      target instanceof HTMLElement ? target.closest<HTMLElement>('[data-tree-path]') : null
    const path = row?.dataset.treePath
    if (!path) return activeDirectory()
    if (dropTargetIsDirectory(path)) return path
    return parentDirectory(path)
  }

  function handleTreeKeydown(event: KeyboardEvent): void {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return
    }
    const key = event.key
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && key.toLocaleLowerCase() === 'n') {
      event.preventDefault()
      void startCreate(createTargetDirectory(event.target), 'untitled.txt')
      return
    }
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'ArrowRight' && key !== 'ArrowLeft') {
      return
    }
    if (visibleRows.length === 0) return

    let currentIndex = -1
    if (event.target instanceof HTMLElement) {
      const row = event.target.closest<HTMLElement>('[data-tree-path]')
      if (row?.dataset.treePath) currentIndex = rowIndexByPath.get(row.dataset.treePath) ?? -1
    }
    const lastSelected = projectState.selectedPaths.at(-1)
    if (currentIndex < 0 && lastSelected !== undefined) {
      currentIndex = rowIndexByPath.get(lastSelected) ?? -1
    }

    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault()
      const direction = key === 'ArrowDown' ? 1 : -1
      const nextIndex =
        currentIndex < 0
          ? direction === 1
            ? 0
            : visibleRows.length - 1
          : Math.min(visibleRows.length - 1, Math.max(0, currentIndex + direction))
      const entry = visibleRows[nextIndex]
      if (!entry) return
      if (event.shiftKey) {
        extendSelectionTo(entry.path)
      } else {
        projectFilesWorkspace.setSelection(projectId, [entry.path])
        projectFilesWorkspace.setSelectionAnchor(projectId, entry.path)
      }
      focusRow(entry.path)
      return
    }

    const entry = visibleRows[currentIndex]
    if (!entry) return
    if (key === 'ArrowRight') {
      event.preventDefault()
      if (entry.kind === 'directory') {
        if (!projectState.expandedDirectories[entry.path]) {
          void toggleDirectoryRow(entry)
        } else {
          const child = visibleRows[currentIndex + 1]
          if (child) {
            projectFilesWorkspace.setSelection(projectId, [child.path])
            projectFilesWorkspace.setSelectionAnchor(projectId, child.path)
            focusRow(child.path)
          }
        }
      }
      return
    }
    if (key === 'ArrowLeft') {
      event.preventDefault()
      if (entry.kind === 'directory' && projectState.expandedDirectories[entry.path]) {
        void toggleDirectoryRow(entry)
      } else {
        const parent = parentDirectory(entry.path)
        const parentIndex = parent ? rowIndexByPath.get(parent) : undefined
        if (parentIndex !== undefined) {
          const parentEntry = visibleRows[parentIndex]
          projectFilesWorkspace.setSelection(projectId, [parentEntry.path])
          projectFilesWorkspace.setSelectionAnchor(projectId, parentEntry.path)
          focusRow(parentEntry.path)
        }
      }
    }
  }

  function handleTreeContainerClick(event: MouseEvent): void {
    if (event.target === treeScroll) {
      projectFilesWorkspace.clearSelection(projectId)
    }
  }

  async function copyForPaste(paths: string[], mode: ProjectFileTransferMode): Promise<void> {
    const label = selectionLabel(paths)
    projectFilesWorkspace.setClipboard(projectId, paths, mode)
    try {
      await copyText(paths.map((path) => `@${path}`).join('\n'))
      toast.success(mode === 'copy' ? `${label} copied` : `${label} ready to move`)
    } catch {
      toast.success(mode === 'copy' ? `${label} copied` : `${label} ready to move`)
    }
  }

  async function copyPaths(paths: string[]): Promise<void> {
    const label = paths.length === 1 ? 'Path' : `${paths.length} paths`
    try {
      const infos = await Promise.all(
        paths.map((path) => projectFilesWorkspace.fileInfo(projectId, path))
      )
      await copyText(infos.map((info) => info.absolutePath).join('\n'))
      toast.success(`${label} copied`)
    } catch {
      toast.error(`The ${label.toLocaleLowerCase()} could not be copied`)
    }
  }

  /** Focus the row's inline editor input, which lives inside the virtualised
   *  tree, after the tree has re-rendered around the new edit row. */
  async function focusInlineInput(select: boolean): Promise<void> {
    await tick()
    const input = treeScroll?.querySelector<HTMLInputElement>('[data-inline-input]')
    if (!input) return
    input.focus()
    if (select) input.select()
  }

  async function startCreate(directory: string, value = ''): Promise<void> {
    if (directory) {
      projectFilesWorkspace.markDirectoryExpanded(projectId, directory)
      await projectFilesWorkspace.loadDirectory(projectId, directory)
    }
    inlineEdit = { kind: 'create', directory, value }
    await tick()
    scrollTreeKeyIntoView(`create:${directory}`)
    await focusInlineInput(true)
  }

  async function startCreateFolder(directory: string): Promise<void> {
    if (directory) {
      projectFilesWorkspace.markDirectoryExpanded(projectId, directory)
      await projectFilesWorkspace.loadDirectory(projectId, directory)
    }
    inlineEdit = { kind: 'create-directory', directory, value: '' }
    await tick()
    scrollTreeKeyIntoView(`create:${directory}`)
    await focusInlineInput(false)
  }

  async function startRename(entry: ProjectFileEntry): Promise<void> {
    inlineEdit = { kind: 'rename', entry, value: entry.name }
    await focusInlineInput(true)
  }

  async function commitInlineEdit(): Promise<void> {
    if (!inlineEdit || operationPending) return
    const edit = inlineEdit
    const name = edit.value.trim()
    if (!name) {
      inlineEdit = null
      return
    }
    if (edit.kind === 'rename' && name === edit.entry.name) {
      inlineEdit = null
      return
    }
    operationPending = true
    try {
      if (edit.kind === 'create') {
        await projectFilesWorkspace.createFile(projectId, edit.directory, name)
      } else if (edit.kind === 'create-directory') {
        await projectFilesWorkspace.createDirectory(projectId, edit.directory, name)
      } else {
        await projectFilesWorkspace.renameFile(projectId, edit.entry.path, name)
      }
      inlineEdit = null
    } catch (error) {
      reportError(error, 'The file operation failed')
      await focusInlineInput(false)
    } finally {
      operationPending = false
    }
  }

  function handleInlineKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      inlineEdit = null
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void commitInlineEdit()
    }
  }

  async function pasteInto(directory: string): Promise<void> {
    try {
      await projectFilesWorkspace.pasteFile(projectId, directory)
      toast.success('Pasted')
    } catch (error) {
      reportError(error, 'The item could not be pasted')
    }
  }

  /** Import a set of absolute OS paths (dropped or clipboard-copied) into a directory. */
  async function importInto(directory: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return
    try {
      const entries = await projectFilesWorkspace.importExternalPaths(projectId, paths, directory)
      toast.success(
        entries.length === 1
          ? `Imported ${entries[0].name}`
          : `Imported ${entries.length} files or folders`
      )
    } catch (error) {
      reportError(error, 'The files could not be imported')
    }
  }

  async function dropInto(directory: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return
    try {
      const results = await projectFilesWorkspace.dropExternalPaths(projectId, paths, directory)
      toast.success(
        results.length === 1
          ? `Dropped ${results[0].entry.name}`
          : `Dropped ${results.length} items`
      )
    } catch (error) {
      reportError(error, 'The files could not be dropped')
    }
  }

  function handleFilePointerDown(entry: ProjectFileEntry): void {
    suppressScrollForPointer()
    const paths = selectionPathsFor(entry, projectState.selectedPaths)
    if (!projectState.selectedPaths.includes(entry.path)) {
      projectFilesWorkspace.setSelection(projectId, paths)
      projectFilesWorkspace.setSelectionAnchor(projectId, entry.path)
    }
  }

  function handleFileDragStart(entry: ProjectFileEntry, event: DragEvent): void {
    const paths = [...selectionPathsFor(entry, projectState.selectedPaths)].map(String)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove'
    event.preventDefault()
    try {
      window.api.startFileDrag(projectId, paths)
    } catch (error) {
      reportError(error, 'Native dragging is unavailable')
    }
  }

  /** Whether any subfolder is currently expanded, driving the collapse/expand-all toggle. */
  let anyDirExpanded = $derived(
    Object.keys(projectState.expandedDirectories).some(
      (path) => path !== '' && projectState.expandedDirectories[path]
    )
  )

  async function toggleExpandAll(): Promise<void> {
    if (treeBusy) return
    treeBusy = true
    try {
      if (anyDirExpanded) {
        projectFilesWorkspace.collapseAllDirectories(projectId)
        searchExpandedDirectories.clear()
        // With a filter active the matching directories would force-render
        // again; remember them as collapsed so the whole tree actually folds.
        if (filterQuery.trim() || lastTurnOnly) {
          collapsedOverrides.clear()
          for (const directory of Object.keys(projectState.entriesByDirectory)) {
            if (directory) collapsedOverrides.add(directory)
          }
        }
      } else {
        collapsedOverrides.clear()
        await projectFilesWorkspace.expandAllDirectories(projectId)
      }
    } finally {
      treeBusy = false
    }
  }

  function activeDirectory(): string {
    const path = projectState.revealedPath ?? selectedPath
    if (!path) return ''
    return parentDirectory(path)
  }

  /** Paste either OS-copied files or the in-app clipboard into a directory. */
  function handlePaste(event: ClipboardEvent): void {
    if (inlineEdit || filterOpen) {
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
    }
    const paths = pastedFilePaths(event.clipboardData)
    if (paths.length > 0) {
      event.preventDefault()
      void importInto(activeDirectory(), paths)
      return
    }
    // No OS file items: fall back to the in-app clipboard (copy/cut within or across projects).
    if (projectFilesWorkspace.clipboard) {
      event.preventDefault()
      void pasteInto(activeDirectory())
    }
  }

  function clearDropState(): void {
    if (dropExpandTimer) {
      clearTimeout(dropExpandTimer)
      dropExpandTimer = undefined
    }
    dropHoverPath = null
    dropActive = false
    dropTargetPath = null
    dropIndicator = null
    dropFolder = null
  }

  /** Cancel a pending auto-expand (e.g. the drag moved off the folder). */
  function cancelFolderExpand(): void {
    if (dropExpandTimer) {
      clearTimeout(dropExpandTimer)
      dropExpandTimer = undefined
    }
    dropHoverPath = null
  }

  /** Auto-expand a collapsed folder after the drag has hovered on it for ~1s, so
   *  the user can keep dragging into its subfolders. Deterministic: only expands
   *  on a sustained hover and is cancelled the moment the drag leaves the folder. */
  function scheduleFolderExpand(path: string): void {
    if (projectState.expandedDirectories[path]) return
    if (dropHoverPath === path) return
    dropHoverPath = path
    if (dropExpandTimer) clearTimeout(dropExpandTimer)
    dropExpandTimer = setTimeout(() => {
      dropExpandTimer = undefined
      if (dropHoverPath === path) {
        projectFilesWorkspace.markDirectoryExpanded(projectId, path)
        void projectFilesWorkspace.loadDirectory(projectId, path)
      }
    }, 1000)
  }

  function handleDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    dropActive = true
    const target = event.target
    if (target instanceof Element) {
      const row = target.closest<HTMLElement>('[data-tree-path]')
      const path = row?.dataset.treePath ?? null
      if (path && dropTargetIsDirectory(path)) {
        dropTargetPath = path
        dropFolder = path
        dropIndicator = { path, position: 'after' }
        scheduleFolderExpand(path)
      } else if (path) {
        cancelFolderExpand()
        dropTargetPath = parentDirectory(path)
        dropFolder = parentDirectory(path)
        if (row) {
          const rect = row.getBoundingClientRect()
          dropIndicator = {
            path,
            position: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
          }
        } else {
          dropIndicator = { path, position: 'after' }
        }
      } else {
        cancelFolderExpand()
        dropTargetPath = activeDirectory()
        dropFolder = null
        dropIndicator = null
      }
    }
  }

  function handleDragLeave(event: DragEvent): void {
    if (
      event.currentTarget instanceof HTMLElement &&
      event.currentTarget.contains(event.relatedTarget as Node)
    ) {
      return
    }
    clearDropState()
  }

  function handleDrop(event: DragEvent): void {
    const paths = droppedFilePaths(event.dataTransfer?.files ?? null)
    const target = dropTargetPath
    clearDropState()
    if (paths.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    const directory = target
      ? dropTargetIsDirectory(target)
        ? target
        : parentDirectory(target)
      : activeDirectory()
    void dropInto(directory, paths)
  }

  function dropTargetIsDirectory(path: string): boolean {
    const parent = parentDirectory(path)
    return (projectState.entriesByDirectory[parent] ?? []).some(
      (entry) => entry.path === path && entry.kind === 'directory'
    )
  }

  async function deleteSelected(): Promise<void> {
    if (!deleteTarget || operationPending) return
    operationPending = true
    const count = deleteTarget.paths.length
    try {
      await projectFilesWorkspace.deletePaths(projectId, deleteTarget.paths)
      projectFilesWorkspace.clearSelection(projectId)
      deleteTarget = null
      toast.success(count === 1 ? 'Item moved to Trash' : `${count} items moved to Trash`)
    } catch (error) {
      reportError(error, 'The items could not be deleted')
    } finally {
      operationPending = false
    }
  }

  async function showInfo(entry: ProjectFileEntry): Promise<void> {
    try {
      info = await projectFilesWorkspace.fileInfo(projectId, entry.path)
    } catch (error) {
      reportError(error, 'File information is unavailable')
    }
  }

  async function revealInFileManager(entry: ProjectFileEntry): Promise<void> {
    try {
      const info = await projectFilesWorkspace.fileInfo(projectId, entry.path)
      const revealed = await invoke('shell:revealPath', info.absolutePath)
      if (!revealed) toast.error('The item could not be revealed in the file manager')
    } catch (error) {
      reportError(error, 'The item could not be revealed')
    }
  }

  /** Serve a directory (or the directory holding one HTML file) over a loopback
   *  origin and open it in a browser, so scripts, stylesheets, and relative and
   *  absolute asset URLs all resolve the way a static host serves them. */
  async function openEntryInBrowser(entry: ProjectFileEntry | null): Promise<void> {
    if (browserPreviewPending) return
    browserPreviewPending = true
    try {
      const session = await projectFilesWorkspace.openDirectoryPreview(projectId, entry?.path ?? '')
      await openInBrowser(session.url)
    } catch (error) {
      reportError(error, 'The directory could not be served for browser preview')
    } finally {
      browserPreviewPending = false
    }
  }

  async function loadAncestorDirectories(paths: string[]): Promise<void> {
    for (const directory of collectAncestorDirectories(paths)) {
      await projectFilesWorkspace.loadDirectory(projectId, directory)
    }
  }

  $effect(() => {
    if (!lastTurnOnly) return
    void loadAncestorDirectories([...lastTurnPaths])
  })

  $effect(() => {
    if (!conflictsOnly || conflictPaths.length === 0) return
    void loadAncestorDirectories([...conflictPaths])
  })

  $effect(() => {
    const trigger = findNavState.focusFileTreeFilter
    if (trigger > 0) {
      void openFilter()
    }
  })
</script>

<aside
  class="relative flex h-full min-h-0 min-w-44 shrink-0 flex-col border-l border-border bg-surface"
  style:width={`${projectState.explorerWidth}px`}
  aria-label="Project file explorer"
  data-region="file-tree"
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
  onpaste={handlePaste}
>
  <ProjectFileExplorerHeader
    {projectName}
    explorerWidth={projectState.explorerWidth}
    {resizing}
    {dropActive}
    {dropFolder}
    {anyDirExpanded}
    {treeBusy}
    {filterOpen}
    rootLoading={Boolean(projectState.loadingDirectories[''])}
    onStartResize={startResize}
    onResizeKeydown={handleResizeKeydown}
    onToggleExpandAll={() => void toggleExpandAll()}
    onToggleFilter={() => (filterOpen ? closeFilter() : void openFilter())}
    onRefresh={() => void projectFilesWorkspace.refresh(projectId, selectedPath ?? undefined)}
  />

  <ProjectFileExplorerFilters
    {filterOpen}
    {filterQuery}
    includeCio={cioSearchVisibility.includeCio}
    {lastTurnOnly}
    lastTurnCount={lastTurnPaths.length}
    lastTurnDisabled={lastTurnPaths.length === 0 && !lastTurnOnly}
    {conflictsOnly}
    conflictCount={conflictPaths.length}
    showConflicts={conflictPaths.length > 0 || conflictsOnly}
    onFilterInputElement={(element) => (filterInput = element)}
    onFilterInput={handleFilterInput}
    onCloseFilter={() => closeFilter()}
    onToggleCio={(checked) => cioSearchVisibility.setIncludeCio(checked)}
    onToggleLastTurn={toggleLastTurnFilter}
    onToggleConflicts={toggleConflictsFilter}
  />

  <ProjectFileContextMenu
    entry={null}
    selectedPaths={projectState.selectedPaths}
    canPaste={canPaste()}
    onCreateFile={() => void startCreate('')}
    onCreateFolder={() => void startCreateFolder('')}
    onCopy={() => undefined}
    onCopyPath={() => undefined}
    onCut={() => undefined}
    onPaste={() => void pasteInto('')}
    onRename={() => undefined}
    onDelete={() => undefined}
    onInfo={() => undefined}
    onReveal={() => undefined}
    onOpenInBrowser={() => void openEntryInBrowser(null)}
  >
    <div
      {@attach attachTreeScroll}
      class="min-h-0 flex-1 overflow-auto py-1"
      role="tree"
      tabindex="0"
      onclick={handleTreeContainerClick}
      onkeydown={handleTreeKeydown}
      aria-label="Project files tree"
    >
      {#if projectState.directoryErrors['']}
        <div class="px-3 py-3">
          <p class="text-[0.6875rem] leading-relaxed text-danger">
            {projectState.directoryErrors['']}
          </p>
          <button
            type="button"
            class="mt-2 text-[0.6875rem] font-medium text-foreground hover:underline"
            onclick={() => void projectFilesWorkspace.loadDirectory(projectId, '', true)}
          >
            Try again
          </button>
        </div>
      {:else if (projectState.entriesByDirectory[''] ?? []).length === 0 && !inlineEdit}
        <p class="px-3 py-3 text-[0.6875rem] text-dimmed">This project directory is empty.</p>
      {:else if topLevelVisibleEntries.length === 0 && !inlineEdit}
        <p class="px-3 py-3 text-[0.6875rem] text-dimmed">
          {conflictsOnly
            ? 'No conflicted files match this filter.'
            : lastTurnOnly
              ? 'No changed files match this filter.'
              : 'No files match this filter.'}
        </p>
      {:else}
        <div class="relative w-full" style:height={`${virtualTree.total}px`}>
          {#each virtualTree.rows as virtualRow (virtualRow.row.key)}
            <div
              class="absolute inset-x-0 top-0 h-7"
              style:transform={`translateY(${virtualRow.offset}px)`}
            >
              <ProjectFileExplorerTreeRow
                row={virtualRow.row}
                {inlineEdit}
                {operationPending}
                {projectState}
                {dropFolder}
                {dropIndicator}
                canPaste={canPaste()}
                {isRowActive}
                onCommitInline={() => void commitInlineEdit()}
                onInlineKeydown={handleInlineKeydown}
                onRetryLoad={(path) =>
                  void projectFilesWorkspace.loadDirectory(projectId, path, true)}
                onCreateFile={(directory) => void startCreate(directory)}
                onCreateFolder={(entry) =>
                  void startCreateFolder(
                    entry.kind === 'directory' ? entry.path : parentDirectory(entry.path)
                  )}
                onCopy={(entry) =>
                  void copyForPaste(selectionPathsFor(entry, projectState.selectedPaths), 'copy')}
                onCopyPath={(entry) =>
                  void copyPaths(selectionPathsFor(entry, projectState.selectedPaths))}
                onCut={(entry) =>
                  void copyForPaste(selectionPathsFor(entry, projectState.selectedPaths), 'move')}
                onPaste={(entry) => void pasteInto(pasteDirectory(entry))}
                onRename={(entry) => void startRename(entry)}
                onDelete={(entry) => {
                  const paths = selectionPathsFor(entry, projectState.selectedPaths)
                  deleteTarget = {
                    paths,
                    label: paths.length === 1 ? entry.name : `${paths.length} items`
                  }
                }}
                onInfo={(entry) => void showInfo(entry)}
                onReveal={(entry) => void revealInFileManager(entry)}
                onOpenInBrowser={(entry) => void openEntryInBrowser(entry)}
                onRowClick={handleRowClick}
                onRowDoubleClick={handleRowDoubleClick}
                onRowContextMenu={handleRowContextMenu}
                onRowPointerDown={handleFilePointerDown}
                onRowDragStart={handleFileDragStart}
              />
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </ProjectFileContextMenu>
</aside>

<ProjectFileExplorerDialogs
  {deleteTarget}
  {operationPending}
  onClearDeleteTarget={() => (deleteTarget = null)}
  onConfirmDelete={() => void deleteSelected()}
  {info}
  onClearInfo={() => (info = null)}
/>
