<script lang="ts">
  import { tick } from 'svelte'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import { AlertDialog, Dialog } from 'bits-ui'
  import { toast } from 'svelte-sonner'
  import {
    ChevronDown,
    ChevronRight,
    ChevronsDown,
    ChevronsUp,
    FileDiff,
    FolderOpen,
    Loader2,
    RefreshCw,
    Search,
    X
  } from '@lucide/svelte'
  import type { ProjectFileEntry, ProjectFileInfo, ProjectFileTransferMode } from '$shared/types'
  import { invoke } from '$lib/ipc.svelte'
  import { copyText } from '$lib/copy-text'
  import { projectFilesWorkspace, type ProjectFilesState } from '$lib/stores/project-files.svelte'
  import { findNavState } from '$lib/stores/find-nav.svelte'
  import FileTypeIcon from './FileTypeIcon.svelte'
  import FolderTypeIcon from './FolderTypeIcon.svelte'
  import ProjectFileContextMenu from './ProjectFileContextMenu.svelte'

  interface Props {
    projectId: string
    projectName: string
    projectState: ProjectFilesState
    selectedPath: string | null
    lastTurnPaths: string[]
    activeCheckpointId: string | null
    /** Paths changed by the active checkpoint tab, used to keep browsing in diff view. */
    activeCheckpointPaths?: string[]
    onFileSelect?: (path: string) => void
  }

  let {
    projectId,
    projectName,
    projectState,
    selectedPath,
    lastTurnPaths,
    activeCheckpointId,
    activeCheckpointPaths = [],
    onFileSelect = undefined
  }: Props = $props()
  let filterQuery = $state('')
  let filterOpen = $state(false)
  let revealedSearchPath = $state<string | null>(null)
  let lastTurnOnly = $state(false)
  let autoFiltered = $state(false)
  let searchRequestId = 0
  let lastAppliedCheckpointId = $state<string | null>(null)
  let inlineEdit = $state<
    | { kind: 'create'; directory: string; value: string }
    | { kind: 'rename'; entry: ProjectFileEntry; value: string }
    | null
  >(null)
  let inlineInput = $state<HTMLInputElement | null>(null)
  let operationPending = $state(false)
  let deleteTarget = $state<{ paths: string[]; label: string } | null>(null)
  let info = $state<ProjectFileInfo | null>(null)
  let treeScroll = $state<HTMLDivElement | null>(null)
  let filterInput = $state<HTMLInputElement | null>(null)
  let dropActive = $state(false)
  let dropTargetPath = $state<string | null>(null)
  let dropIndicator = $state<{ path: string; position: 'before' | 'after' } | null>(null)
  let dropFolder = $state<string | null>(null)
  let dropExpandTimer: ReturnType<typeof setTimeout> | undefined
  let dropHoverPath: string | null = null
  let treeBusy = $state(false)
  /** When true, the next reveal scroll is suppressed. Set during a pointer
   *  interaction on the tree so a user clicking a row isn't yanked around;
   *  cleared on a macrotask so external reveals still auto-scroll. */
  let suppressRevealScroll = false
  const lastTurnPathSet = $derived(new Set(lastTurnPaths))

  /** Flattened, depth-first list of the tree rows currently visible, matching the
   *  render order of `directoryRows`. Used for range selection and keyboard nav. */
  let visibleRows = $derived.by((): ProjectFileEntry[] => {
    const rows: ProjectFileEntry[] = []
    const walk = (directory: string): void => {
      for (const entry of visibleEntries(directory)) {
        rows.push(entry)
        if (entry.kind === 'directory' && shouldRenderDirectory(entry.path)) {
          walk(entry.path)
        }
      }
    }
    walk('')
    return rows
  })
  let rowIndexByPath = $derived.by((): Map<string, number> => {
    const indexByPath = new SvelteMap<string, number>()
    visibleRows.forEach((entry, index) => indexByPath.set(entry.path, index))
    return indexByPath
  })

  $effect(() => {
    const checkpointId = activeCheckpointId
    if (checkpointId && checkpointId !== lastAppliedCheckpointId) {
      lastAppliedCheckpointId = checkpointId
      lastTurnOnly = true
      autoFiltered = true
    } else if (!checkpointId && autoFiltered) {
      lastAppliedCheckpointId = null
      lastTurnOnly = false
      autoFiltered = false
    }
  })

  $effect(() => {
    const query = filterQuery.trim()
    if (!query) return

    const requestId = ++searchRequestId

    const timer = setTimeout(async () => {
      try {
        const results = await invoke('projectFiles:search', projectId, query, 'all')
        if (requestId !== searchRequestId) return

        const dirsToLoad = new SvelteSet<string>()
        for (const result of results) {
          const segments = result.path.split('/')
          for (let i = 1; i < segments.length; i++) {
            dirsToLoad.add(segments.slice(0, i).join('/'))
          }
        }

        const sorted = [...dirsToLoad].sort((a, b) => a.split('/').length - b.split('/').length)
        for (const dir of sorted) {
          projectFilesWorkspace.markDirectoryExpanded(projectId, dir)
          await projectFilesWorkspace.loadDirectory(projectId, dir)
        }
      } catch {
        // search failed silently
      }
    }, 200)

    return () => clearTimeout(timer)
  })

  function toggleLastTurnFilter(): void {
    lastTurnOnly = !lastTurnOnly
    autoFiltered = false
  }

  async function openFilter(): Promise<void> {
    filterOpen = true
    await tick()
    filterInput?.focus()
    filterInput?.select()
  }

  function closeFilter(clearReveal = true): void {
    searchRequestId += 1
    filterQuery = ''
    filterOpen = false
    if (clearReveal) revealedSearchPath = null
  }

  function parentDirectory(path: string): string {
    const segments = path.split('/')
    segments.pop()
    return segments.join('/')
  }

  function pasteDirectory(entry: ProjectFileEntry | null): string {
    if (!entry) return ''
    return entry.kind === 'directory' ? entry.path : parentDirectory(entry.path)
  }

  function canPaste(): boolean {
    return projectFilesWorkspace.clipboard !== null
  }

  $effect(() => {
    const path = revealedSearchPath ?? projectState.revealedPath ?? selectedPath
    if (!path || !projectState.entriesByDirectory[parentDirectory(path)]) return
    if (suppressRevealScroll) return
    void tick().then(() => {
      const selected = [
        ...(treeScroll?.querySelectorAll<HTMLElement>('[data-tree-path]') ?? [])
      ].find((element) => element.dataset.treePath === path)
      selected?.scrollIntoView({ block: 'nearest' })
    })
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

  async function selectEntry(
    entry: ProjectFileEntry,
    mode: 'normal' | 'preview' = 'preview'
  ): Promise<void> {
    suppressScrollForPointer()
    projectFilesWorkspace.setRevealedPath(projectId, entry.path)
    projectFilesWorkspace.setSelection(projectId, [entry.path])
    projectFilesWorkspace.setSelectionAnchor(projectId, entry.path)
    const selectedFromSearch = filterOpen && Boolean(filterQuery.trim())
    if (selectedFromSearch) {
      revealedSearchPath = entry.path
      closeFilter(false)
      if (entry.kind === 'directory') {
        await projectFilesWorkspace.revealDirectory(projectId, entry.path)
      } else {
        await projectFilesWorkspace.revealFile(projectId, entry.path)
      }
    } else if (entry.kind === 'directory') {
      await projectFilesWorkspace.toggleDirectory(projectId, entry.path)
    }

    if (entry.kind === 'file') {
      if (onFileSelect) {
        onFileSelect(entry.path)
      } else if (activeCheckpointId && activeCheckpointPaths.includes(entry.path)) {
        await projectFilesWorkspace.openCheckpointFile(
          projectId,
          activeCheckpointId,
          entry.path,
          'diff'
        )
      } else if (mode === 'normal' || selectedFromSearch) {
        await projectFilesWorkspace.openFile(projectId, entry.path)
      } else {
        await projectFilesWorkspace.openFilePreview(projectId, entry.path)
      }
    }
  }

  function isRowActive(path: string): boolean {
    if (projectState.selectedPaths.includes(path)) return true
    if (revealedSearchPath === path) return true
    if (projectState.selectedPaths.length === 0) {
      return selectedPath === path || projectState.revealedPath === path
    }
    return false
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
    void tick().then(() => {
      const row = [...(treeScroll?.querySelectorAll<HTMLElement>('[data-tree-path]') ?? [])].find(
        (element) => element.dataset.treePath === path
      )
      row?.focus()
    })
  }

  function handleTreeKeydown(event: KeyboardEvent): void {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return
    }
    const key = event.key
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
          void projectFilesWorkspace.toggleDirectory(projectId, entry.path)
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
        void projectFilesWorkspace.toggleDirectory(projectId, entry.path)
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

  function selectionPathsFor(entry: ProjectFileEntry | null): string[] {
    if (!entry) return projectState.selectedPaths
    if (projectState.selectedPaths.includes(entry.path)) return projectState.selectedPaths
    return [entry.path]
  }

  function selectionLabel(paths: string[]): string {
    return paths.length === 1 ? 'Item' : `${paths.length} items`
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
      await copyText(paths.map((path) => `@${path}`).join('\n'))
      toast.success(`${label} copied`)
    } catch {
      toast.error(`The ${label.toLocaleLowerCase()} could not be copied`)
    }
  }

  async function startCreate(directory: string): Promise<void> {
    if (directory) {
      projectFilesWorkspace.markDirectoryExpanded(projectId, directory)
      await projectFilesWorkspace.loadDirectory(projectId, directory)
    }
    inlineEdit = { kind: 'create', directory, value: '' }
    await tick()
    inlineInput?.focus()
  }

  async function startRename(entry: ProjectFileEntry): Promise<void> {
    inlineEdit = { kind: 'rename', entry, value: entry.name }
    await tick()
    inlineInput?.focus()
    inlineInput?.select()
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
      } else {
        await projectFilesWorkspace.renameFile(projectId, edit.entry.path, name)
      }
      inlineEdit = null
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The file operation failed')
      await tick()
      inlineInput?.focus()
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
      toast.error(error instanceof Error ? error.message : 'The item could not be pasted')
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
      toast.error(error instanceof Error ? error.message : 'The files could not be imported')
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
      toast.error(error instanceof Error ? error.message : 'The files could not be dropped')
    }
  }

  function handleFilePointerDown(entry: ProjectFileEntry): void {
    suppressScrollForPointer()
    const paths = selectionPathsFor(entry)
    if (!projectState.selectedPaths.includes(entry.path)) {
      projectFilesWorkspace.setSelection(projectId, paths)
      projectFilesWorkspace.setSelectionAnchor(projectId, entry.path)
    }
  }

  function handleFileDragStart(entry: ProjectFileEntry, event: DragEvent): void {
    const paths = [...selectionPathsFor(entry)].map(String)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove'
    event.preventDefault()
    try {
      window.api.startFileDrag(projectId, paths)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Native dragging is unavailable')
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
      } else {
        await projectFilesWorkspace.expandAllDirectories(projectId)
      }
    } finally {
      treeBusy = false
    }
  }

  /** Resolve absolute paths for OS-dropped File objects (folder/file). */
  function droppedFilePaths(files: FileList | null): string[] {
    if (!files) return []
    const paths: string[] = []
    for (const file of Array.from(files)) {
      try {
        const path = window.api.getPathForFile(file)
        if (path) paths.push(path)
      } catch {
        // Not a local file; skip.
      }
    }
    return paths
  }

  /** Resolve absolute paths from an OS file paste (uses items, like the composer). */
  function pastedFilePaths(data: DataTransfer | null): string[] {
    if (!data) return []
    const paths: string[] = []
    for (const item of Array.from(data.items)) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (!file) continue
      try {
        const path = window.api.getPathForFile(file)
        if (path) paths.push(path)
      } catch {
        // Pasted item is not a local file; skip.
      }
    }
    return paths
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
      toast.error(error instanceof Error ? error.message : 'The items could not be deleted')
    } finally {
      operationPending = false
    }
  }

  async function showInfo(entry: ProjectFileEntry): Promise<void> {
    try {
      info = await projectFilesWorkspace.fileInfo(projectId, entry.path)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'File information is unavailable')
    }
  }

  function directoryContainsLastTurnFile(path: string): boolean {
    const prefix = path ? `${path}/` : ''
    return lastTurnPaths.some((changedPath) => changedPath.startsWith(prefix))
  }

  function directoryMatchesQuery(path: string): boolean {
    const query = filterQuery.trim().toLocaleLowerCase()
    if (!query) return true

    const children = projectState.entriesByDirectory[path]
    if (!children) return false

    return children.some((entry) => {
      const matchesTurn =
        !lastTurnOnly ||
        (entry.kind === 'file'
          ? lastTurnPathSet.has(entry.path)
          : directoryContainsLastTurnFile(entry.path))
      return (
        matchesTurn &&
        (entry.name.toLocaleLowerCase().includes(query) ||
          (entry.kind === 'directory' && directoryMatchesQuery(entry.path)))
      )
    })
  }

  function visibleEntries(directory: string): ProjectFileEntry[] {
    const query = filterQuery.trim().toLocaleLowerCase()
    const entries = projectState.entriesByDirectory[directory] ?? []
    return entries.filter((entry) => {
      const matchesTurn =
        !lastTurnOnly ||
        (entry.kind === 'file'
          ? lastTurnPathSet.has(entry.path)
          : directoryContainsLastTurnFile(entry.path))
      if (!matchesTurn) return false
      if (!query) return true
      return (
        entry.name.toLocaleLowerCase().includes(query) ||
        (entry.kind === 'directory' && directoryMatchesQuery(entry.path))
      )
    })
  }

  function shouldRenderDirectory(path: string): boolean {
    if (lastTurnOnly && directoryContainsLastTurnFile(path)) return true
    if (projectState.expandedDirectories[path]) return true
    if (!filterQuery.trim() || !projectState.entriesByDirectory[path]) return false
    return directoryMatchesQuery(path)
  }

  async function loadLastTurnDirectories(paths: string[]): Promise<void> {
    const directories = new SvelteSet<string>()
    for (const path of paths) {
      const segments = path.split('/')
      segments.pop()
      for (let index = 0; index < segments.length; index += 1) {
        directories.add(segments.slice(0, index + 1).join('/'))
      }
    }
    for (const directory of [...directories].sort(
      (left, right) => left.split('/').length - right.split('/').length
    )) {
      await projectFilesWorkspace.loadDirectory(projectId, directory)
    }
  }

  $effect(() => {
    if (!lastTurnOnly) return
    void loadLastTurnDirectories([...lastTurnPaths])
  })

  $effect(() => {
    const trigger = findNavState.focusFileTreeFilter
    if (trigger > 0) {
      void openFilter()
    }
  })
</script>

{#snippet directoryRows(directory: string, depth: number)}
  {#if inlineEdit?.kind === 'create' && inlineEdit.directory === directory}
    <div
      class="flex h-7 items-center gap-1.5 pr-2 text-[11px] text-foreground"
      style:padding-left={`${22 + depth * 14}px`}
    >
      <FileTypeIcon path={inlineEdit.value} />
      <input
        bind:this={inlineInput}
        bind:value={inlineEdit.value}
        class="h-6 min-w-0 flex-1 rounded border border-primary bg-app px-1.5 text-[11px] text-foreground outline-none"
        aria-label="New file name"
        placeholder="filename.ext"
        disabled={operationPending}
        onkeydown={handleInlineKeydown}
        onblur={() => void commitInlineEdit()}
      />
    </div>
  {/if}
  {#each visibleEntries(directory) as entry (entry.path)}
    <ProjectFileContextMenu
      {entry}
      selectedPaths={projectState.selectedPaths}
      canPaste={canPaste()}
      onCreateFile={() => void startCreate(entry.path)}
      onCopy={() => void copyForPaste(selectionPathsFor(entry), 'copy')}
      onCopyPath={() => void copyPaths(selectionPathsFor(entry))}
      onCut={() => void copyForPaste(selectionPathsFor(entry), 'move')}
      onPaste={() => void pasteInto(pasteDirectory(entry))}
      onRename={() => void startRename(entry)}
      onDelete={() => {
        const paths = selectionPathsFor(entry)
        deleteTarget = {
          paths,
          label: paths.length === 1 ? entry.name : `${paths.length} items`
        }
      }}
      onInfo={() => void showInfo(entry)}
    >
      {#if inlineEdit?.kind === 'rename' && inlineEdit.entry.path === entry.path}
        <div
          class="flex h-7 items-center gap-1.5 pr-2 text-[11px] text-foreground"
          style:padding-left={`${22 + depth * 14}px`}
        >
          {#if inlineEdit.entry.kind === 'directory'}
            <FolderTypeIcon name={inlineEdit.value} size={13} />
          {:else}
            <FileTypeIcon path={inlineEdit.value} />
          {/if}
          <input
            bind:this={inlineInput}
            bind:value={inlineEdit.value}
            class="h-6 min-w-0 flex-1 rounded border border-primary bg-app px-1.5 text-[11px] text-foreground outline-none"
            aria-label={`Rename ${entry.name}`}
            disabled={operationPending}
            onkeydown={handleInlineKeydown}
            onblur={() => void commitInlineEdit()}
          />
        </div>
      {:else}
        <button
          type="button"
          data-tree-path={entry.path}
          draggable="true"
          class={[
            'relative flex h-7 w-full items-center gap-1.5 pr-2 text-left text-[11px] transition-colors hover:bg-elevated',
            isRowActive(entry.path) ? 'bg-overlay text-foreground' : 'text-muted',
            dropFolder === entry.path ? 'bg-primary/10' : ''
          ]}
          style:padding-left={`${8 + depth * 14}px`}
          title={entry.path}
          onclick={(event: MouseEvent) => handleRowClick(entry, event)}
          ondblclick={(event: MouseEvent) => handleRowDoubleClick(entry, event)}
          oncontextmenu={() => handleRowContextMenu(entry)}
          onpointerdown={() => handleFilePointerDown(entry)}
          ondragstart={(event: DragEvent) => handleFileDragStart(entry, event)}
        >
          <div
            class="pointer-events-none absolute left-0 right-0 top-0 h-[2px] transition-opacity duration-100 {dropIndicator?.path ===
              entry.path && dropIndicator.position === 'before'
              ? 'bg-primary opacity-100'
              : 'opacity-0'}"
          ></div>
          <div
            class="pointer-events-none absolute bottom-0 left-0 right-0 h-[2px] transition-opacity duration-100 {dropIndicator?.path ===
              entry.path && dropIndicator.position === 'after'
              ? 'bg-primary opacity-100'
              : 'opacity-0'}"
          ></div>
          {#if entry.kind === 'directory'}
            {#if projectState.loadingDirectories[entry.path]}
              <Loader2 size={12} class="shrink-0 animate-spin text-dimmed" />
            {:else if projectState.expandedDirectories[entry.path]}
              <ChevronDown size={12} class="shrink-0 text-dimmed" />
            {:else}
              <ChevronRight size={12} class="shrink-0 text-dimmed" />
            {/if}
            {#if projectState.expandedDirectories[entry.path]}
              <FolderTypeIcon name={entry.name} open size={13} />
            {:else}
              <FolderTypeIcon name={entry.name} size={13} />
            {/if}
          {:else}
            <span class="w-3 shrink-0"></span>
            <FileTypeIcon path={entry.path} />
          {/if}
          <span class="min-w-0 flex-1 truncate">{entry.name}</span>
          {#if entry.kind === 'file' && projectState.sessions[entry.path] && projectState.sessions[entry.path].draft !== projectState.sessions[entry.path].source.content}
            <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Unsaved changes"
            ></span>
          {/if}
        </button>
      {/if}
    </ProjectFileContextMenu>
    {#if entry.kind === 'directory' && projectState.expandedDirectories[entry.path] && projectState.directoryErrors[entry.path]}
      <div
        class="flex items-center gap-2 py-1 pr-2 text-[10px] text-danger"
        style:padding-left={`${22 + depth * 14}px`}
      >
        <span class="min-w-0 flex-1 truncate">{projectState.directoryErrors[entry.path]}</span>
        <button
          type="button"
          class="shrink-0 font-medium text-foreground hover:underline"
          onclick={() => void projectFilesWorkspace.loadDirectory(projectId, entry.path, true)}
        >
          Retry
        </button>
      </div>
    {:else if entry.kind === 'directory' && shouldRenderDirectory(entry.path)}
      {@render directoryRows(entry.path, depth + 1)}
    {/if}
  {/each}
{/snippet}

<aside
  class="relative flex h-full min-h-0 w-52 min-w-44 max-w-[45%] shrink-0 flex-col border-l border-border bg-surface"
  aria-label="Project file explorer"
  data-region="file-tree"
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
  onpaste={handlePaste}
>
  {#if dropActive}
    <div
      class="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center"
      aria-hidden="true"
    >
      <span
        class="mt-1.5 rounded-full bg-primary px-2.5 py-0.5 text-[10px] font-medium text-on-primary shadow-lg"
        >{dropFolder ? `Drop into ${dropFolder || ''}` : 'Drop to import'}</span
      >
    </div>
  {/if}
  <div class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
    <FolderOpen size={13} class="shrink-0 text-primary" />
    <span class="min-w-0 flex-1 truncate text-[10px] font-semibold text-foreground">
      {projectName}
    </span>
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
      aria-label={anyDirExpanded ? 'Collapse all folders' : 'Expand all folders'}
      title={anyDirExpanded ? 'Collapse all folders' : 'Expand all folders'}
      disabled={treeBusy}
      onclick={() => void toggleExpandAll()}
    >
      {#if anyDirExpanded}
        <ChevronsUp size={12} />
      {:else}
        <ChevronsDown size={12} />
      {/if}
    </button>
    <button
      type="button"
      class={[
        'flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground',
        filterOpen ? 'bg-elevated text-foreground' : ''
      ]}
      aria-label="Search project files"
      title="Search project files (Cmd/Ctrl+F)"
      aria-pressed={filterOpen}
      onclick={() => (filterOpen ? closeFilter() : void openFilter())}
    >
      <Search size={12} />
    </button>
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
      aria-label="Refresh project files"
      title="Refresh files"
      disabled={Boolean(projectState.loadingDirectories[''])}
      onclick={() => void projectFilesWorkspace.refresh(projectId, selectedPath ?? undefined)}
    >
      <RefreshCw size={12} class={projectState.loadingDirectories[''] ? 'animate-spin' : ''} />
    </button>
  </div>

  {#if filterOpen}
    <div
      class="absolute left-2 right-2 top-10 z-20 flex items-center gap-1 rounded-xl border border-border bg-surface p-1.5 shadow-xl"
      role="search"
      aria-label="Search project files"
    >
      <Search size={13} class="shrink-0 text-dimmed" />
      <input
        bind:this={filterInput}
        type="search"
        class="h-7 min-w-0 flex-1 rounded-lg bg-app px-2 text-[11px] text-foreground outline-none placeholder:text-dimmed"
        placeholder="Search files and folders…"
        bind:value={filterQuery}
        onkeydown={(event: KeyboardEvent) => event.key === 'Escape' && closeFilter()}
      />
      <button
        type="button"
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-dimmed hover:bg-elevated hover:text-foreground"
        aria-label="Close file search"
        title="Close file search (Escape)"
        onclick={() => closeFilter()}
      >
        <X size={12} />
      </button>
    </div>
  {/if}

  <div class="shrink-0 border-b border-border p-2">
    <button
      type="button"
      class={[
        'mt-1.5 flex h-7 w-full items-center gap-1.5 rounded border px-2 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        lastTurnOnly
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'border-border text-muted hover:bg-elevated hover:text-foreground'
      ]}
      aria-label="Filter files changed in the last turn"
      aria-pressed={lastTurnOnly}
      title="Show only files changed in the last completed turn"
      disabled={lastTurnPaths.length === 0 && !lastTurnOnly}
      onclick={toggleLastTurnFilter}
    >
      <FileDiff size={12} />
      <span class="flex-1 text-left">Last turn</span>
      <span class="tabular-nums text-dimmed">{lastTurnPaths.length}</span>
    </button>
  </div>

  <ProjectFileContextMenu
    entry={null}
    selectedPaths={projectState.selectedPaths}
    canPaste={canPaste()}
    onCreateFile={() => void startCreate('')}
    onCopy={() => undefined}
    onCopyPath={() => undefined}
    onCut={() => undefined}
    onPaste={() => void pasteInto('')}
    onRename={() => undefined}
    onDelete={() => undefined}
    onInfo={() => undefined}
  >
    <div
      bind:this={treeScroll}
      class="min-h-0 flex-1 overflow-auto py-1"
      role="tree"
      tabindex="0"
      onclick={handleTreeContainerClick}
      onkeydown={handleTreeKeydown}
      aria-label="Project files tree"
    >
      {#if projectState.directoryErrors['']}
        <div class="px-3 py-3">
          <p class="text-[11px] leading-relaxed text-danger">{projectState.directoryErrors['']}</p>
          <button
            type="button"
            class="mt-2 text-[11px] font-medium text-foreground hover:underline"
            onclick={() => void projectFilesWorkspace.loadDirectory(projectId, '', true)}
          >
            Try again
          </button>
        </div>
      {:else if (projectState.entriesByDirectory[''] ?? []).length === 0 && !inlineEdit}
        <p class="px-3 py-3 text-[11px] text-dimmed">This project directory is empty.</p>
      {:else if visibleEntries('').length === 0 && !inlineEdit}
        <p class="px-3 py-3 text-[11px] text-dimmed">
          {lastTurnOnly ? 'No changed files match this filter.' : 'No files match this filter.'}
        </p>
      {:else}
        {@render directoryRows('', 0)}
      {/if}
    </div>
  </ProjectFileContextMenu>
</aside>

<AlertDialog.Root bind:open={() => deleteTarget !== null, (open) => !open && (deleteTarget = null)}>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-50 bg-overlay/70" />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <AlertDialog.Title class="text-sm font-semibold text-foreground"
        >Delete {deleteTarget?.paths.length === 1
          ? 'this item'
          : `${deleteTarget?.paths.length ?? 0} items`}?</AlertDialog.Title
      >
      <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
        {deleteTarget?.label} will be moved to Trash. Open tabs for the deleted items will close.
      </AlertDialog.Description>
      <div class="mt-5 flex justify-end gap-2">
        <AlertDialog.Cancel
          class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
        >
          Cancel
        </AlertDialog.Cancel>
        <AlertDialog.Action
          class="h-8 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
          disabled={operationPending}
          onclick={() => void deleteSelected()}
        >
          Move to Trash
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>

<Dialog.Root bind:open={() => info !== null, (open) => !open && (info = null)}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-overlay/70" />
    <Dialog.Content
      class="fixed left-1/2 top-1/2 z-50 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <Dialog.Title class="text-sm font-semibold text-foreground">File info</Dialog.Title>
      <Dialog.Description class="sr-only"
        >Information about the selected project file</Dialog.Description
      >
      {#if info}
        <dl class="mt-4 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2 text-xs">
          <dt class="text-dimmed">Name</dt>
          <dd class="truncate text-foreground">{info.name}</dd>
          <dt class="text-dimmed">Path</dt>
          <dd class="break-all font-mono text-foreground">{info.absolutePath}</dd>
          <dt class="text-dimmed">Type</dt>
          <dd class="capitalize text-foreground">{info.kind}</dd>
          <dt class="text-dimmed">Size</dt>
          <dd class="text-foreground">
            {info.size === undefined ? '—' : `${info.size.toLocaleString()} bytes`}
          </dd>
          <dt class="text-dimmed">Modified</dt>
          <dd class="text-foreground">{new Date(info.modifiedAt ?? 0).toLocaleString()}</dd>
          <dt class="text-dimmed">Created</dt>
          <dd class="text-foreground">{new Date(info.createdAt).toLocaleString()}</dd>
        </dl>
      {/if}
      <div class="mt-5 flex justify-end">
        <Dialog.Close
          class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
        >
          Close
        </Dialog.Close>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
