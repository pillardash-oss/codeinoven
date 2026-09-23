<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { slide } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'
  import { toast } from 'svelte-sonner'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import {
    ChevronRight,
    FolderTree,
    FolderOpen,
    Loader2,
    Minimize2,
    Save,
    TriangleAlert,
    X
  } from '@lucide/svelte'
  import { htmlPreviewFrame } from '$lib/document-preview-frame'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import ConflictResolutionView from './ConflictResolutionView.svelte'
  import StalePanelNotice from '$lib/components/ui/StalePanelNotice.svelte'
  import {
    conflictSaveActionLabels,
    conflictSaveActionTitle,
    conflictSaveStep
  } from './conflict-resolution'
  import type {
    ConflictResolutionController,
    ConflictResolutionStatus
  } from './conflict-resolution'
  import { motionDuration } from '$lib/motion'
  import { supportsFilePreview } from '$lib/mime'
  import { projectFilePreviewUrl } from '$lib/file-preview'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import type { FilesContextTab } from '$lib/stores/context-sidebar.svelte'
  import { projectFilesWorkspace, type ProjectFileTab } from '$lib/stores/project-files.svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import { findNavState } from '$lib/stores/find-nav.svelte'
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'
  import EditorOpenControl from './EditorOpenControl.svelte'
  import FileDiffView from './FileDiffView.svelte'
  import { diffDetails } from './file-diff'
  import { wrapTextState } from '$lib/stores/wrap-text.svelte'
  import { beautifyFileContent, fileBeautifyLabel } from '$lib/file-beautify'
  import FileImagePreview from './FileImagePreview.svelte'
  import FileMediaPreview from './FileMediaPreview.svelte'
  import FindInBar from './FindInBar.svelte'
  import GoToLine from './GoToLine.svelte'
  import ProjectFileExplorer from './ProjectFileExplorer.svelte'
  import FileTypeIcon from './FileTypeIcon.svelte'
  import FileInfoDialog from './FileInfoDialog.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import ProjectFilesPanelDialogs from './ProjectFilesPanelDialogs.svelte'
  import ProjectFilesPanelPreviewPane from './ProjectFilesPanelPreviewPane.svelte'
  import ProjectFilesPanelToolbar from './ProjectFilesPanelToolbar.svelte'
  import { ProjectFilesPanelSvgPreview } from './project-files-panel-svg-preview.svelte'
  import { ProjectFilesPanelFind } from './project-files-panel-find.svelte'
  import { ProjectFilesPanelDocumentPreview } from './project-files-panel-document-preview.svelte'
  import {
    filePreviewFlags,
    hasAnyPreview,
    previewKindLabel as previewKindLabelFor
  } from './project-files-panel-preview'
  import ProjectTextEditor from './ProjectTextEditor.svelte'
  import type { AgentEvent, ProjectFileInfo, TurnCheckpointSummary } from '$shared/types'
  import { posixDirname } from '$shared/paths'
  import { INBOX_PROJECT_ID } from '$shared/types'

  interface Props {
    projectId: string
    projectName: string
    projectIconUrl?: string | null
  }

  let { projectId, projectName, projectIconUrl = null }: Props = $props()

  let contextTab = $derived(
    contextSidebarState.sidebarActiveTab?.kind === 'files'
      ? contextSidebarState.sidebarActiveTab
      : null
  )
  let activeThreadId = $derived(contextTab?.threadId ?? null)
  /** Inbox chats mount the file tree on the thread's own artifact directory;
   *  real projects always use the project root regardless of the open thread. */
  let chatThreadId = $derived(projectId === INBOX_PROJECT_ID ? activeThreadId : null)
  $effect(() => {
    projectFilesWorkspace.setChatThread(projectId, chatThreadId)
  })
  // This panel can be restored directly from persisted sidebar state before a
  // file action has had a chance to prepare the workspace store.
  function prepareProjectFilesState(): void {
    projectFilesWorkspace.ensureState(projectId)
  }
  prepareProjectFilesState()
  let projectState = $derived(projectFilesWorkspace.getState(projectId))
  /** Read the tree for the mount the open thread belongs to. Only remounting
   *  (closing and reopening the panel) runs this, so a thread switch alone never
   *  swaps the tree out from under the user: it raises the stale-scope notice
   *  instead, and the toggle the notice asks for is what lands the new root. */
  $effect(() => {
    if (!projectState.explorerVisible) return
    void projectFilesWorkspace.loadDirectory(projectId, '')
  })
  /** This panel is project-scoped: it survives a thread switch, so after the
   *  open thread moves to another worktree its listings still describe the
   *  previous scope root. The notice below makes that visible instead of
   *  silently showing another checkout's files. */
  let scopeStale = $derived(!projectFilesWorkspace.listingsMatchMount(projectId))
  let activeTab = $derived(
    contextTab?.fileTabId
      ? (projectState.tabs.find((tab) => tab.id === contextTab?.fileTabId) ?? null)
      : null
  )
  let activeSession = $derived(activeTab ? (projectState.sessions[activeTab.path] ?? null) : null)
  let dirty = $derived(activeSession ? activeSession.draft !== activeSession.source.content : false)
  let checkpointDiff = $derived(activeTab?.checkpointDiff ?? null)
  let diffStats = $derived(
    activeTab?.view === 'diff' && checkpointDiff && !checkpointDiff.binary
      ? diffDetails(checkpointDiff.before, checkpointDiff.after)
      : null
  )
  let deletedAtCheckpoint = $derived(checkpointDiff?.kind === 'deleted')
  /** Reload is available for text files with a session and for previewable
   *  files without one (media, images, SVG, PDF, documents), which re-read
   *  their preview content instead. */
  let reloadDisabled = $derived(
    deletedAtCheckpoint ||
      !activeTab ||
      (!activeSession && !supportsFilePreview(activeTab.path)) ||
      Boolean(projectState.loadingPaths[activeTab.path]) ||
      Boolean(activeSession?.saving)
  )
  /** The active file has unsaved changes while the disk version moved on:
   *  the viewer shows the "Viewing an older version" alert (see below). */
  let staleSession = $derived(
    activeSession !== null &&
      !deletedAtCheckpoint &&
      projectState.staleFiles[activeSession.source.path] === true
  )
  let editRequest = $state<{ nonce: number; action: 'undo' | 'redo' } | null>(null)
  let editNonce = 0

  function requestEdit(action: 'undo' | 'redo'): void {
    if (!activeTab) return
    editRequest = { nonce: ++editNonce, action }
  }
  /** Paths still carrying merge/rebase conflicts, straight from the git store. */
  let conflictedPaths = $derived([...gitState.conflicted])
  /**
   * Whether the "Conflicts" file-tree filter is active. Mirrors the git panel's
   * Resolve flow: resolving from Git routes here with the filter on, and the
   * explorer's Conflicts button toggles it directly.
   */
  let conflictsOnly = $derived(gitState.conflictsMode)
  /**
   * The tab whose conflicted file the user handed to the file editor from the
   * merge editor's size notice. A conflicted working file belongs to the merge
   * editor whenever one is open, so without this the escape hatch would route
   * straight back into the surface that refused the file. The hand-over is held
   * by the tab itself, so closing the file and opening it again brings the merge
   * editor back.
   */
  let rawConflictTab = $state<ProjectFileTab | null>(null)
  /** Whether the merge editor owns the active file's body. False while the file
   *  is conflicted but the user asked for the raw source, which is the case the
   *  file editor resolves by hand. */
  let activeFileInMergeEditor = $derived(
    activeTab?.origin === 'working' &&
      conflictedPaths.includes(activeTab.path) &&
      rawConflictTab !== activeTab
  )
  /** Undo/redo toolbar buttons apply to the plain file editor only: the
   *  editable source view with a session, not diffs, previews, the
   *  conflict-resolution editor, or read-only deleted files. */
  let canUndoRedo = $derived(
    activeSession !== null &&
      !deletedAtCheckpoint &&
      !activeFileInMergeEditor &&
      activeTab?.view === 'source'
  )
  /** Beautify is offered for the same editable source view as undo/redo, and
   *  only for a format the editor can reformat. The label doubles as the flag,
   *  so no action is shown that could not run. */
  let beautifyLabel = $derived(
    activeTab !== null &&
      activeSession !== null &&
      !deletedAtCheckpoint &&
      !activeFileInMergeEditor &&
      !projectState.loadingPaths[activeTab.path] &&
      activeTab.view === 'source'
      ? fileBeautifyLabel(activeTab.path)
      : null
  )
  /** The Save button only exists for editable content: a conflicted file being
   *  resolved, or a text session with unsaved changes. Preview-only content
   *  (images, PDF, media, documents, SVG) and clean sessions show no button. */
  let showSaveButton = $derived(
    activeTab !== null &&
      activeTab.view !== 'diff' &&
      !deletedAtCheckpoint &&
      (activeFileInMergeEditor || (activeSession !== null && dirty))
  )
  const previewFlags = $derived(filePreviewFlags(activeTab?.path ?? null))
  let markdown = $derived(previewFlags.markdown)
  let htmlPreview = $derived(previewFlags.html)
  let pdf = $derived(previewFlags.pdf)
  let image = $derived(previewFlags.image)
  let svg = $derived(previewFlags.svg)
  let video = $derived(previewFlags.video)
  let audio = $derived(previewFlags.audio)
  let previewReloadToken = $derived(
    activeTab ? (projectState.previewReloadTokens[activeTab.path] ?? 0) : 0
  )
  let previewUrl = $derived(
    activeTab && (pdf || image || video || audio) && !svg
      ? projectFilePreviewUrl(
          projectId,
          activeTab.path,
          chatThreadId ?? undefined,
          previewReloadToken
        )
      : null
  )
  // SVG is rendered natively in the renderer via a blob URL (animated SVGs
  // play), instead of the privileged `appfile://` scheme, which intentionally
  // refuses to serve project-controlled SVG.
  const svgPreview = new ProjectFilesPanelSvgPreview()
  $effect(() =>
    svgPreview.sync({
      projectId,
      activePath: activeTab?.path ?? null,
      isSvg: svg,
      // Reading the reload token keeps the effect reactive to explicit reloads:
      // bumping it revokes the stale blob and re-reads the file from disk.
      currentReloadToken: () =>
        activeTab ? (projectState.previewReloadTokens[activeTab.path] ?? 0) : 0,
      scopeBucketId: workspaceState.activeScopeBucketIdFor(projectId),
      chatThreadId
    })
  )
  let imagePreviewSrc = $derived(svg ? svgPreview.url : previewUrl)
  let imagePreviewFailed = $derived(svg ? svgPreview.failed : false)
  /** Office/CSV documents render as sanitized converted HTML (no PDF path). */
  let documentPreview = $derived(previewFlags.document)
  let previewKindLabel = $derived(previewKindLabelFor(previewFlags))
  const docPreview = new ProjectFilesPanelDocumentPreview()
  /** Scope bucket is read as a derived value OUTSIDE the effect: the getter
   *  touches `workspaceState.selectedThread`, which is reassigned on every
   *  thread update. Reading it inside the effect would re-run (and cancel)
   *  the preview load on each thread churn, leaving the loader stuck true. */
  let documentScopeBucketId = $derived(workspaceState.activeScopeBucketIdFor(projectId))
  $effect(() => {
    const tab = activeTab
    docPreview.sync(
      projectId,
      tab?.path ?? null,
      Boolean(tab && documentPreview && tab.view === 'preview'),
      tab ? (projectState.previewReloadTokens[tab.path] ?? 0) : 0,
      documentScopeBucketId
    )
  })
  let historicalContent = $derived(checkpointDiff?.after ?? checkpointDiff?.before ?? '')
  let visibleContent = $derived(
    deletedAtCheckpoint ? historicalContent : (activeSession?.draft ?? historicalContent)
  )
  /** Directory the active HTML file sits in, as an `appfile://` base URL, so
   *  the document's relative images and media resolve beside it. The scheme
   *  serves media only, so project stylesheets and scripts still never load. */
  let htmlPreviewBaseHref = $derived.by(() => {
    if (!activeTab || !htmlPreview) return undefined
    const directory = posixDirname(activeTab.path)
    return projectFilePreviewUrl(
      projectId,
      directory ? `${directory}/` : '',
      chatThreadId ?? undefined
    )
  })
  /** Sanitized page for the active HTML file, built from the live session draft
   *  so the preview follows unsaved edits. Mounted with `sandbox=""` below. */
  let htmlPreviewSrcdoc = $derived(
    htmlPreview ? htmlPreviewFrame(visibleContent, htmlPreviewBaseHref) : null
  )
  let breadcrumbParts = $derived(activeTab?.path.split('/') ?? [])
  let visibleLineCount = $derived(visibleContent.split('\n').length)
  let showLineNumbers = $state(true)
  const wrapLines = $derived(wrapTextState.wrapped)
  let fullscreenOpen = $derived(projectState.fullscreenActive)
  // The browser's native view floats above every DOM overlay, so a full-window
  // editor must register itself as a fullscreen surface while it is up. The
  // returned cleanup matters here: this panel is unmounted whenever the sidebar
  // hides or its active tab changes, and a key left behind would suppress the
  // browser view for the rest of the session.
  $effect(() =>
    browserVisibility.hideWhile('files-fullscreen-editor', 'fullscreen-surface', fullscreenOpen)
  )
  /**
   * The conflict editor renders in two places   the sidebar body and the
   * fullscreen modal   and each mount reports its own controller and status.
   * The panel keeps only the surface that is on screen: the modal's content
   * outlives its close until bits-ui's exit check runs a frame later, so the
   * fullscreen view's teardown would otherwise land after the sidebar view has
   * registered and leave the sidebar's save button and chord without a
   * controller. Tagging each report with its surface lets a stale teardown be
   * recognised and dropped.
   */
  type ConflictSurface = 'sidebar' | 'fullscreen'
  let conflictSurface = $state<ConflictSurface | null>(null)
  let conflictController = $state<ConflictResolutionController | null>(null)
  let conflictStatus = $state<ConflictResolutionStatus>({
    canSave: false,
    canSaveDraft: false,
    dirty: false,
    saving: false
  })
  /** What the save chord does for a conflicted file right now: the draft lands
   *  first, and only a press with no draft left to write marks the file
   *  resolved. The panel's own save controls always mark it resolved. */
  let conflictStep = $derived(conflictSaveStep(conflictStatus))
  /** The panel's save controls mark the file resolved, which needs every
   *  conflict block resolved. It does not need a draft write first. */
  let conflictSaveReady = $derived(conflictStatus.canSave)
  let conflictSaveText = $derived(conflictSaveActionLabels.resolve)
  let conflictSaveTitle = $derived(conflictSaveActionTitle('resolve'))
  let fullscreenExplorerOpen = $derived(projectState.explorerVisible)
  let fullscreenPendingPath = $state<string | null>(null)
  let renameTarget = $state<{ path: string; name: string } | null>(null)
  let deleteTargetPath = $state<string | null>(null)
  /** The file a Reload confirmation is open for, or null. */
  let reloadConfirmPath = $state<string | null>(null)
  let reloadConfirmTitle = $derived(
    reloadConfirmPath === null
      ? ''
      : `Discard unsaved changes to ${reloadConfirmPath} and reload it?`
  )
  let info = $state<ProjectFileInfo | null>(null)
  let mutationPending = $state(false)
  let goToLineOpen = $state(false)
  let goToLineFocusTrigger = $state(0)
  let lastTurnPaths = $state<string[]>([])
  let activeCheckpointPaths = $state<string[]>([])
  let lastTurnRequest = 0

  function openFullscreen(): void {
    // The editor's `open` is derived from the store, so this is the whole
    // transition: no local mirror to keep in step.
    projectFilesWorkspace.requestFullscreen(projectId)
  }

  /** Show the File info dialog (the same one the file tree's context menu
   *  opens) for the active file. */
  async function showActiveFileInfo(): Promise<void> {
    if (!activeTab) return
    try {
      info = await projectFilesWorkspace.fileInfo(projectId, activeTab.path)
    } catch (error) {
      reportError(error, 'File information is unavailable')
    }
  }

  function closeFullscreen(): void {
    fullscreenOpen = false
    projectFilesWorkspace.setFullscreenActive(projectId, false)
  }

  function handleConflictController(
    surface: ConflictSurface,
    next: ConflictResolutionController | null
  ): void {
    if (next === null) {
      // Only the surface holding the slot may clear it. The fullscreen editor's
      // teardown arrives after the sidebar editor is already live, and clearing
      // the slot then is what left the sidebar's save button doing nothing.
      if (conflictSurface !== surface) return
      conflictSurface = null
      conflictController = null
      conflictStatus = { canSave: false, canSaveDraft: false, dirty: false, saving: false }
      return
    }
    conflictSurface = surface
    conflictController = next
  }

  function handleConflictStatus(surface: ConflictSurface, next: ConflictResolutionStatus): void {
    // A status from a surface that no longer owns the slot is stale: the view
    // it describes is either closing or off screen.
    if (conflictSurface !== surface) return
    conflictStatus = next
  }

  /** What the panel's save button runs for a conflicted file: it marks the file
   *  resolved directly. Saving a draft is the conflict editor's own button. */
  async function resolveActiveConflict(): Promise<void> {
    await conflictController?.save()
  }

  /**
   * The merge editor's size notice hands the file over: the tab renders its raw
   * source, and the file tree opens on the file so the hand-over is visible
   * rather than implied. The editor's Save then writes the cleared content and
   * stages the file through the ordinary conflicted-save reconcile.
   */
  async function openRawConflictSource(): Promise<void> {
    const tab = activeTab
    if (!tab || tab.origin !== 'working') return
    rawConflictTab = tab
    await projectFilesWorkspace.revealFile(projectId, tab.path)
  }

  function runPanelSave(): void {
    if (activeFileInMergeEditor) {
      void resolveActiveConflict()
      return
    }
    void saveActiveFile()
  }

  /** Save the active tab. The Cmd/Ctrl+S chord for a conflicted file keeps a
   *  rule of its own: it writes the resolved progress as a draft first, and only
   *  a press with no draft left to write marks the file resolved, so one press
   *  cannot stage a file whose progress the scratch file has not seen. */
  async function saveActiveFile(): Promise<void> {
    if (!activeTab) return
    if (activeFileInMergeEditor) {
      if (conflictStep === 'draft') {
        await conflictController?.saveDraft()
        return
      }
      if (conflictStep === 'resolve') await conflictController?.save()
      return
    }
    await projectFilesWorkspace.save(projectId, activeTab.path)
  }

  async function loadCheckpointPaths(
    threadId: string | null,
    checkpointId: string | null
  ): Promise<void> {
    const request = ++lastTurnRequest
    if (!threadId) {
      lastTurnPaths = []
      activeCheckpointPaths = []
      return
    }
    try {
      const checkpoints = await invoke('checkpoint:list', projectId, threadId)
      if (request !== lastTurnRequest) return
      const latest = checkpoints.find(
        (checkpoint: TurnCheckpointSummary) => checkpoint.status !== 'active'
      )
      lastTurnPaths = latest ? latest.changes.map((change) => change.path) : []
      const active = checkpointId
        ? checkpoints.find((checkpoint: TurnCheckpointSummary) => checkpoint.id === checkpointId)
        : null
      activeCheckpointPaths = active ? active.changes.map((change) => change.path) : []
    } catch {
      if (request === lastTurnRequest) {
        lastTurnPaths = []
        activeCheckpointPaths = []
      }
    }
  }

  $effect(() => {
    void loadCheckpointPaths(activeThreadId, activeTab?.checkpointId ?? null)
  })

  onMount(() =>
    subscribe('agent:event', (...args: unknown[]) => {
      const event = args[0] as AgentEvent
      if (
        event.type === 'checkpoint.updated' &&
        event.projectId === projectId &&
        event.threadId === activeThreadId
      ) {
        void loadCheckpointPaths(activeThreadId, activeTab?.checkpointId ?? null)
      }
    })
  )

  function handleGlobalKeydown(event: KeyboardEvent): void {
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === 'g' &&
      activeTab &&
      (activeSession || deletedAtCheckpoint)
    ) {
      event.preventDefault()
      event.stopPropagation()
      findNavState.closeEditorFind()
      projectFilesWorkspace.setView(projectId, activeTab.id, 'source')
      goToLineOpen = true
      goToLineFocusTrigger += 1
      return
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      event.key.toLowerCase() === 's' &&
      conflictController !== null
    ) {
      // The conflict editor owns the chord while it is mounted, even when there
      // is nothing to save yet: consuming it keeps the press from falling
      // through to the workspace's left-sidebar toggle underneath the user.
      // Holding the key never escalates either, so a repeat press cannot mark
      // the file resolved while the draft write is still settling.
      event.preventDefault()
      if (event.repeat || conflictStatus.saving || conflictStep === 'none') return
      void saveActiveFile()
      return
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      event.key.toLowerCase() === 's' &&
      activeTab &&
      activeTab.view !== 'diff' &&
      activeSession &&
      dirty &&
      !deletedAtCheckpoint &&
      !activeSession.saving
    ) {
      event.preventDefault()
      void saveActiveFile()
    }
  }

  function handleEditorInput(input: { currentTarget: { value: string } }): void {
    if (deletedAtCheckpoint || !activeTab || projectState.loadingPaths[activeTab.path]) {
      return
    }
    projectFilesWorkspace.updateDraft(projectId, activeTab.path, input.currentTarget.value)
  }

  function reloadStaleActive(): void {
    if (!activeTab || !activeSession) return
    // No confirmation dialog: the alert itself is the explicit choice, and
    // the editor applies the new content as an undoable transaction, so the
    // previous draft stays recoverable through undo/redo.
    void projectFilesWorkspace.reload(projectId, activeTab.path)
  }

  function reloadSelected(): void {
    if (!activeTab) return
    if (!activeSession) {
      // Media/image/SVG/PDF/document previews have no editable text session;
      // bumping the preview reload token re-reads the file from disk.
      if (supportsFilePreview(activeTab.path)) {
        projectFilesWorkspace.reloadPreview(projectId, activeTab.path)
      }
      return
    }
    if (dirty) {
      reloadConfirmPath = activeTab.path
      return
    }
    void projectFilesWorkspace.reload(projectId, activeTab.path)
  }

  /** Reload the file the confirmation was raised for, now that the user accepted
   *  losing the draft. The path is captured at request time, so the reload never
   *  follows a tab the user switched to while the dialog was open. */
  function discardAndReloadSelected(): void {
    const path = reloadConfirmPath
    reloadConfirmPath = null
    if (path === null) return
    void projectFilesWorkspace.reload(projectId, path)
  }

  /** Reformat the active file's draft in place. The result is left unsaved on
   *  purpose: the tab goes dirty, the Save button lights up, and the editor's own
   *  history keeps the previous layout one undo away. */
  function beautifyActiveFile(): void {
    if (!activeTab || !activeSession) return
    const label = fileBeautifyLabel(activeTab.path)
    if (label === null) return
    const outcome = beautifyFileContent(activeTab.path, activeSession.draft)
    if (outcome.status === 'invalid') {
      toast.error(`${label} could not be beautified`, { description: outcome.message })
      return
    }
    if (outcome.status === 'unchanged') {
      toast.info(`${label} is already beautified`)
      return
    }
    if (outcome.status !== 'formatted') return
    projectFilesWorkspace.updateDraft(projectId, activeTab.path, outcome.text)
    // The document changed under the find bar, so its match count is stale.
    editorFind.rescan()
    toast.success(`${label} beautified`, { description: 'Save the file to keep the change.' })
  }

  function keepFullscreenOpen(): void {
    if (fullscreenOpen) projectFilesWorkspace.requestFullscreen(projectId)
  }

  function focusFullscreenFileTab(sidebarId: string): void {
    keepFullscreenOpen()
    contextSidebarState.focus(sidebarId)
  }

  function fullscreenOpenFile(path: string, mode: 'normal' | 'preview' = 'preview'): void {
    if (path === activeTab?.path) {
      if (mode === 'normal') {
        keepFullscreenOpen()
        void projectFilesWorkspace.openFile(projectId, path)
      }
      return
    }
    // Opening a checkpoint (last-turn) diff never leaves the fullscreen modal:
    // switch to the new file's diff in place.
    if (activeTab?.checkpointId && activeCheckpointPaths.includes(path)) {
      keepFullscreenOpen()
      void projectFilesWorkspace.openCheckpointFile(projectId, activeTab.checkpointId, path, 'diff')
      return
    }
    // Match the sidebar's single-click behavior: a normal active file stays
    // open, while the selected file becomes a preview tab that can be pinned
    // by opening it normally. The fullscreen request survives the context-tab
    // remount caused by focusing that new tab.
    keepFullscreenOpen()
    void (mode === 'normal'
      ? projectFilesWorkspace.openFile(projectId, path)
      : projectFilesWorkspace.openFilePreview(projectId, path))
  }

  async function confirmFullscreenSaveAndNavigate(): Promise<void> {
    const path = fullscreenPendingPath
    if (!path || !activeTab) return
    fullscreenPendingPath = null
    const currentPath = activeTab.path
    await projectFilesWorkspace.save(projectId, currentPath)
    contextSidebarState.updateProjectFileMapping(
      projectId,
      `working:${currentPath}`,
      `working:${path}`,
      path
    )
    void projectFilesWorkspace.swapFileSilent(projectId, currentPath, path)
  }

  function revealBreadcrumb(index: number): void {
    const directory = index < 0 ? '' : breadcrumbParts.slice(0, index + 1).join('/')
    void projectFilesWorkspace.revealDirectory(projectId, directory)
  }

  async function openSelectedInEditor(): Promise<void> {
    if (!activeTab) return
    await invoke(
      'projectFiles:openInEditor',
      projectId,
      activeTab.path,
      workspaceState.activeScopeBucketIdFor(projectId),
      chatThreadId ?? undefined
    )
  }

  function startRename(): void {
    if (!activeTab || deletedAtCheckpoint) return
    renameTarget = {
      path: activeTab.path,
      name: activeTab.path.split('/').at(-1) ?? activeTab.path
    }
    void tick().then(() => {
      const input = document.getElementById('viewer-rename-file')
      if (!(input instanceof HTMLInputElement)) return
      input.focus()
      input.select()
    })
  }

  async function renameSelected(): Promise<void> {
    if (!renameTarget || mutationPending) return
    const target = renameTarget
    const name = target.name.trim()
    if (!name) return
    mutationPending = true
    try {
      await projectFilesWorkspace.renameFile(projectId, target.path, name)
      renameTarget = null
    } catch (error) {
      reportError(error, 'The file could not be renamed')
    } finally {
      mutationPending = false
    }
  }

  async function deleteSelected(): Promise<void> {
    if (!deleteTargetPath || mutationPending) return
    const target = deleteTargetPath
    mutationPending = true
    try {
      await projectFilesWorkspace.deleteFile(projectId, target)
      deleteTargetPath = null
      closeFullscreen()
      toast.success('File moved to Trash')
    } catch (error) {
      reportError(error, 'The file could not be deleted')
    } finally {
      mutationPending = false
    }
  }

  const editorFind = new ProjectFilesPanelFind()

  function submitGoToLine(line: number): void {
    if (!activeTab) return
    goToLineOpen = false
    projectFilesWorkspace.focusLine(projectId, activeTab.id, line)
  }

  /** Open file tabs for this project, so the fullscreen viewer can show the
   *  same tab strip as the sidebar instead of only the active file. */
  let fullscreenFileTabs = $derived(
    contextSidebarState.tabs.filter(
      (tab): tab is FilesContextTab =>
        tab.kind === 'files' && tab.projectId === projectId && tab.fileTabId !== null
    )
  )

  function closeFullscreenFileTab(sidebarId: string, fileTabId: string): void {
    const fileTab = projectState.tabs.find((candidate) => candidate.id === fileTabId)
    const session = fileTab ? projectState.sessions[fileTab.path] : undefined
    if (fileTab && session && session.draft !== session.source.content) {
      contextSidebarState.focus(sidebarId)
      toast.info('Unsaved changes', { description: 'Save the file before closing its tab.' })
      return
    }
    projectFilesWorkspace.closeTab(projectId, fileTabId)
    contextSidebarState.close(sidebarId)
  }
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

{#snippet staleVersionAlert(positionClass: string)}
  {#if staleSession}
    <div
      class={[
        'absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-1.5 shadow-lg',
        positionClass
      ]}
      role="alert"
    >
      <TriangleAlert size={13} class="shrink-0 text-warning" />
      <span class="text-[0.625rem] font-medium text-warning">Viewing an older version</span>
      <button
        type="button"
        class="rounded bg-warning/20 px-2 py-0.5 text-[0.625rem] font-semibold text-warning transition-colors hover:bg-warning/30"
        title="Reload the current file from disk; the previous content stays recoverable with undo"
        onclick={reloadStaleActive}
      >
        Reload file
      </button>
    </div>
  {/if}
{/snippet}

<div class="flex h-full min-h-0 flex-col bg-app">
  <StalePanelNotice stale={scopeStale} />
  <div class="flex min-h-0 flex-1">
    <section
      class="relative flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label="File editor"
      data-region="editor"
      data-find-active={fullscreenOpen ? undefined : 'true'}
    >
      <div class="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <div
          class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-[0.625rem] text-muted"
          aria-label={activeTab ? `Path ${activeTab.path}` : 'No file selected'}
        >
          <button
            type="button"
            class="shrink-0"
            title="Show project root"
            onclick={() => revealBreadcrumb(-1)}
          >
            {#if projectIconUrl}
              <img src={projectIconUrl} alt={projectName} class="h-4 w-4 shrink-0" />
            {:else}
              <span class="font-medium hover:text-foreground">{projectName}</span>
            {/if}
          </button>
          {#each breadcrumbParts as part, index (`${part}:${index}`)}
            <ChevronRight size={10} class="shrink-0 text-dimmed" />
            {#if index === breadcrumbParts.length - 1}
              <span class="shrink-0 text-foreground">{part}</span>
            {:else}
              <button
                type="button"
                class="shrink-0 hover:text-foreground"
                title={`Show ${breadcrumbParts.slice(0, index + 1).join('/')}`}
                onclick={() => revealBreadcrumb(index)}
              >
                {part}
              </button>
            {/if}
          {/each}
        </div>

        {#if activeTab}
          <EditorOpenControl disabled={deletedAtCheckpoint} onOpen={openSelectedInEditor} />
        {/if}

        <button
          type="button"
          class={[
            'flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors',
            projectState.explorerVisible
              ? 'bg-overlay text-primary'
              : 'text-dimmed hover:bg-elevated hover:text-foreground'
          ]}
          aria-label={projectState.explorerVisible ? 'Hide file explorer' : 'Show file explorer'}
          aria-pressed={projectState.explorerVisible}
          title={projectState.explorerVisible ? 'Hide file explorer' : 'Show file explorer'}
          onclick={() => projectFilesWorkspace.toggleExplorer(projectId)}
        >
          <FolderTree size={15} />
        </button>
      </div>

      {#if activeTab}
        <ProjectFilesPanelToolbar
          {activeTab}
          {checkpointDiff}
          {diffStats}
          {previewKindLabel}
          showPreviewToggle={hasAnyPreview(previewFlags)}
          {deletedAtCheckpoint}
          showUndoRedo={canUndoRedo}
          {reloadDisabled}
          mutationDisabled={deletedAtCheckpoint || mutationPending}
          {showLineNumbers}
          {wrapLines}
          {beautifyLabel}
          {showSaveButton}
          saveDisabled={deletedAtCheckpoint ||
            (activeFileInMergeEditor ? !conflictSaveReady : !dirty) ||
            (activeFileInMergeEditor ? conflictStatus.saving : Boolean(activeSession?.saving))}
          saving={activeFileInMergeEditor ? conflictStatus.saving : Boolean(activeSession?.saving)}
          saveLabel={activeFileInMergeEditor ? conflictSaveText : 'Save file (Cmd/Ctrl+S)'}
          saveTitle={activeFileInMergeEditor ? conflictSaveTitle : undefined}
          fullscreen={false}
          onSetView={(view) => projectFilesWorkspace.setView(projectId, activeTab.id, view)}
          onInfo={() => void showActiveFileInfo()}
          infoDisabled={deletedAtCheckpoint}
          onUndo={() => requestEdit('undo')}
          onRedo={() => requestEdit('redo')}
          onReload={reloadSelected}
          onToggleLineNumbers={() => (showLineNumbers = !showLineNumbers)}
          onToggleWrap={() => wrapTextState.toggle()}
          onBeautify={beautifyActiveFile}
          onFullscreen={openFullscreen}
          onRename={startRename}
          onDelete={() => (deleteTargetPath = activeTab.path)}
          onSave={runPanelSave}
        />
      {/if}

      {@render staleVersionAlert('top-[4.5rem]')}

      {#if activeSession?.error}
        <div
          class="shrink-0 border-b border-danger/20 bg-danger/10 px-3 py-2 text-[0.625rem] leading-relaxed text-danger"
        >
          {activeSession.error}
        </div>
      {/if}

      {#if findNavState.editorFindOpen && !fullscreenOpen && activeTab && activeTab.view !== 'diff' && activeTab.view !== 'preview'}
        <FindInBar
          query={editorFind.value}
          matches={editorFind.total}
          activeIndex={editorFind.active}
          label="Find in file"
          floating
          focusTrigger={findNavState.editorFindFocusTrigger}
          onQueryChange={(query) => editorFind.setQuery(query)}
          enableReplace={!deletedAtCheckpoint}
          replaceValue={editorFind.replaceValue}
          onReplaceChange={(value) => (editorFind.replaceValue = value)}
          onReplaceOne={() => editorFind.replaceOne()}
          onReplaceAll={() => editorFind.replaceAll()}
          onNext={() => editorFind.next()}
          onPrev={() => editorFind.prev()}
          onClose={() => editorFind.close()}
        />
      {:else if goToLineOpen && !fullscreenOpen && activeTab}
        <GoToLine
          maxLine={visibleLineCount}
          focusTrigger={goToLineFocusTrigger}
          floating
          onSubmit={submitGoToLine}
          onClose={() => (goToLineOpen = false)}
        />
      {/if}

      {#if !activeTab}
        <div class="flex min-h-0 flex-1 items-center justify-center px-6">
          <div class="text-center">
            <FolderOpen size={24} class="mx-auto mb-2 text-dimmed" />
            <p class="text-xs font-medium text-foreground">Open file</p>
            <p class="mt-1 text-[0.625rem] text-dimmed">Select a file from the workspace tree.</p>
            {#if !projectState.explorerVisible}
              <button
                type="button"
                class="mt-3 rounded border border-border bg-elevated px-3 py-1.5 text-[0.625rem] font-medium text-foreground hover:bg-overlay"
                onclick={() => projectFilesWorkspace.toggleExplorer(projectId)}
              >
                Show explorer
              </button>
            {/if}
          </div>
        </div>
      {:else if activeTab.error && activeTab.view === 'diff' && !checkpointDiff}
        <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6">
          <div class="max-w-sm text-center">
            <p class="text-xs font-medium text-danger">The diff could not be loaded</p>
            <p class="mt-1 text-[0.625rem] leading-4 text-dimmed">{activeTab.error}</p>
          </div>
          {#if activeTab.checkpointId}
            <button
              type="button"
              class="rounded border border-border bg-elevated px-3 py-1.5 text-[0.625rem] font-medium text-muted hover:bg-overlay hover:text-foreground"
              onclick={() =>
                activeTab?.checkpointId &&
                void projectFilesWorkspace.openCheckpointFile(
                  projectId,
                  activeTab.checkpointId,
                  activeTab.path,
                  'diff'
                )}
            >
              Try again
            </button>
          {/if}
        </div>
      {:else if activeTab.loadingDiff && !checkpointDiff}
        <div class="flex flex-1 items-center justify-center gap-2 text-[0.6875rem] text-dimmed">
          <Loader2 size={13} class="animate-spin" />
          Loading diff
        </div>
      {:else if activeTab.view === 'diff' && checkpointDiff}
        <FileDiffView diff={checkpointDiff} />
      {:else if activeTab.view === 'preview' && hasAnyPreview(previewFlags)}
        <ProjectFilesPanelPreviewPane
          path={activeTab.path}
          flags={previewFlags}
          {visibleContent}
          {htmlPreviewSrcdoc}
          {previewUrl}
          {imagePreviewSrc}
          {imagePreviewFailed}
          documentLoading={docPreview.loading}
          documentHtml={docPreview.html}
          documentFailed={docPreview.failed}
          documentError={docPreview.error}
          showDocumentError
        />
      {:else if projectState.loadingPaths[activeTab.path] && !activeSession && !deletedAtCheckpoint}
        <div class="flex flex-1 items-center justify-center gap-2 text-[0.6875rem] text-dimmed">
          <Loader2 size={13} class="animate-spin" />
          Loading file
        </div>
      {:else if activeTab && !activeSession && !deletedAtCheckpoint}
        {#if image}
          <FileImagePreview
            src={imagePreviewSrc}
            alt={activeTab.path}
            failed={imagePreviewFailed}
          />
        {:else if video || audio}
          <FileMediaPreview
            src={previewUrl}
            alt={activeTab.path}
            kind={video ? 'video' : 'audio'}
          />
        {:else}
          <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6">
            <div class="text-center">
              <p class="text-xs font-medium text-dimmed">This file cannot be viewed here</p>
              <p class="mt-1 text-[0.625rem] text-dimmed">You can open it with your editor.</p>
            </div>
            <button
              type="button"
              class="rounded border border-border bg-elevated px-3 py-1.5 text-[0.625rem] font-medium text-muted hover:text-foreground"
              onclick={openSelectedInEditor}
            >
              Open in editor
            </button>
          </div>
        {/if}
      {:else if activeFileInMergeEditor && activeTab}
        {#if !fullscreenOpen}
          <ConflictResolutionView
            {projectId}
            path={activeTab.path}
            wrap={wrapLines}
            onToggleWrap={() => wrapTextState.toggle()}
            onControllerChange={(next) => handleConflictController('sidebar', next)}
            onStatusChange={(next) => handleConflictStatus('sidebar', next)}
            onOpenOriginal={() => void openRawConflictSource()}
          />
        {/if}
      {:else if activeSession || deletedAtCheckpoint}
        {#key activeTab.id}
          <ProjectTextEditor
            value={visibleContent}
            path={activeTab.path}
            readonly={deletedAtCheckpoint || Boolean(projectState.loadingPaths[activeTab.path])}
            ariaLabel={`${deletedAtCheckpoint ? 'View' : 'Edit'} ${activeTab.path}`}
            spellcheck={markdown}
            {showLineNumbers}
            wrap={wrapLines}
            findQuery={findNavState.editorFindOpen && !fullscreenOpen ? editorFind.value : ''}
            findActiveIndex={editorFind.active}
            findNonce={editorFind.nonce}
            replaceRequest={editorFind.replaceRequest}
            {editRequest}
            focusLine={activeTab.focusLine}
            focusLineRequest={activeTab.focusLineRequest}
            onFindMatches={fullscreenOpen ? undefined : (matches) => editorFind.setMatches(matches)}
            onReplaceDone={(replaced) => editorFind.handleReplaceDone(replaced)}
            onInput={handleEditorInput}
          />
        {/key}
      {/if}
    </section>

    {#if projectState.explorerVisible}
      <div
        class="min-h-0"
        transition:slide={{ axis: 'x', duration: motionDuration(180), easing: cubicOut }}
      >
        <ProjectFileExplorer
          {projectId}
          {projectName}
          {projectState}
          onWidthChange={(width, persist) =>
            projectFilesWorkspace.setExplorerWidth(projectId, width, persist)}
          selectedPath={activeTab?.path ?? null}
          {lastTurnPaths}
          {activeCheckpointPaths}
          activeCheckpointId={activeTab?.checkpointId ?? null}
          conflictPaths={conflictedPaths}
          {conflictsOnly}
          onToggleConflicts={() => (gitState.conflictsMode = !gitState.conflictsMode)}
        />
      </div>
    {/if}
  </div>
</div>

<Modal
  open={fullscreenOpen}
  title={activeTab?.path ?? 'File'}
  description={activeTab?.view === 'diff' ? 'Fullscreen file diff' : 'Fullscreen file editor'}
  onClose={closeFullscreen}
  placement="fullscreen"
  chrome={false}
  panelClass="bg-app"
>
  <div
    class="titlebar-drag flex h-12 shrink-0 items-center gap-0 border-b border-border"
    style={trafficLightInsetStyle()}
  >
    <div class="titlebar-no-drag flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
      <FileTypeIcon path={activeTab?.path ?? 'file'} size={14} />
      <span
        class="relative top-px min-w-0 max-w-[35%] shrink-0 truncate text-[0.6875rem] font-semibold leading-none text-foreground"
      >
        {activeTab?.path ?? 'File'}
      </span>
    </div>
    {#if fullscreenFileTabs.length > 1}
      <div
        class="titlebar-no-drag ml-auto flex min-w-0 max-w-[65%] items-center gap-0 overflow-x-auto"
        role="tablist"
        aria-label="Open files"
      >
        {#each fullscreenFileTabs as fileTab (fileTab.id)}
          {@const fileSession = fileTab.path ? (projectState.sessions[fileTab.path] ?? null) : null}
          {@const fileDirty = Boolean(
            fileSession && fileSession.draft !== fileSession.source.content
          )}
          <div
            class={[
              'group flex min-w-0 max-w-52 shrink-0 items-center rounded-md',
              contextTab?.id === fileTab.id
                ? 'bg-elevated text-foreground'
                : 'text-muted hover:bg-elevated hover:text-foreground'
            ]}
            role="tab"
            aria-selected={contextTab?.id === fileTab.id}
          >
            <button
              type="button"
              data-active={contextTab?.id === fileTab.id ? 'true' : undefined}
              class="flex min-w-0 items-center gap-1.5 py-1.5 pl-2 text-left"
              title={fileTab.path ?? fileTab.title}
              onclick={() => focusFullscreenFileTab(fileTab.id)}
            >
              <FileTypeIcon path={fileTab.path ?? fileTab.title} size={12} />
              <span
                class={[
                  'max-w-40 truncate text-[0.6875rem] font-medium',
                  fileTab.preview ? 'italic' : ''
                ]}>{fileTab.title}</span
              >
              {#if fileDirty}
                <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Unsaved changes"
                ></span>
              {/if}
            </button>
            {#if fileTab.fileTabId}
              <button
                type="button"
                class="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed opacity-70 transition-colors hover:bg-raised hover:text-foreground group-hover:opacity-100"
                aria-label={`Close ${fileTab.title}`}
                title={`Close ${fileTab.title}`}
                onclick={() =>
                  fileTab.fileTabId && closeFullscreenFileTab(fileTab.id, fileTab.fileTabId)}
              >
                <X size={11} />
              </button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
    {#if showSaveButton}
      <button
        type="button"
        class="titlebar-no-drag flex h-7 items-center gap-1 rounded bg-primary px-2 text-[0.625rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-30"
        disabled={deletedAtCheckpoint ||
          (activeFileInMergeEditor ? !conflictSaveReady : !dirty) ||
          (activeFileInMergeEditor ? conflictStatus.saving : activeSession?.saving)}
        title={activeFileInMergeEditor ? conflictSaveTitle : 'Save file (Cmd/Ctrl+S)'}
        onclick={runPanelSave}
      >
        {#if activeFileInMergeEditor ? conflictStatus.saving : activeSession?.saving}
          <Loader2 size={11} class="animate-spin" />
        {:else}
          <Save size={11} />
        {/if}
        {#if activeFileInMergeEditor}
          {conflictSaveText}
        {:else}Save{/if}
      </button>
    {/if}
    <button
      type="button"
      class={[
        'titlebar-no-drag ml-1 flex h-7 w-7 items-center justify-center rounded transition-colors',
        fullscreenExplorerOpen
          ? 'bg-overlay text-primary'
          : 'text-dimmed hover:bg-elevated hover:text-foreground'
      ]}
      aria-label={fullscreenExplorerOpen ? 'Hide file tree' : 'Show file tree'}
      aria-pressed={fullscreenExplorerOpen}
      title={fullscreenExplorerOpen ? 'Hide file tree' : 'Show file tree'}
      onclick={() => projectFilesWorkspace.toggleExplorer(projectId)}
    >
      <FolderTree size={15} />
    </button>
    <button
      type="button"
      class="titlebar-no-drag ml-1 flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      aria-label="Minimize fullscreen file viewer"
      title="Minimize fullscreen file viewer"
      onclick={closeFullscreen}
    >
      <Minimize2 size={14} />
    </button>
  </div>
  <div class="relative flex min-h-0 min-w-0 flex-1">
    <div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {#if activeTab && !activeFileInMergeEditor}
        <ProjectFilesPanelToolbar
          {activeTab}
          {checkpointDiff}
          {diffStats}
          {previewKindLabel}
          showPreviewToggle={hasAnyPreview(previewFlags)}
          {deletedAtCheckpoint}
          showUndoRedo={canUndoRedo}
          {reloadDisabled}
          mutationDisabled={deletedAtCheckpoint || mutationPending}
          {showLineNumbers}
          {wrapLines}
          {beautifyLabel}
          showSaveButton={false}
          saveDisabled
          saving={false}
          saveLabel=""
          fullscreen
          onSetView={(view) => projectFilesWorkspace.setView(projectId, activeTab.id, view)}
          onInfo={() => void showActiveFileInfo()}
          infoDisabled={deletedAtCheckpoint}
          onUndo={() => requestEdit('undo')}
          onRedo={() => requestEdit('redo')}
          onReload={reloadSelected}
          onToggleLineNumbers={() => (showLineNumbers = !showLineNumbers)}
          onToggleWrap={() => wrapTextState.toggle()}
          onBeautify={beautifyActiveFile}
          onFullscreen={openFullscreen}
          onRename={startRename}
          onDelete={() => (deleteTargetPath = activeTab.path)}
          onSave={runPanelSave}
        />
      {/if}
      {@render staleVersionAlert('top-2')}
      <div
        class="relative flex min-h-0 min-w-0 flex-1 flex-col"
        data-region="editor"
        data-find-active={fullscreenOpen ? 'true' : undefined}
      >
        {#if findNavState.editorFindOpen && fullscreenOpen && activeTab && activeTab.view !== 'diff' && activeTab.view !== 'preview'}
          <FindInBar
            query={editorFind.value}
            matches={editorFind.total}
            activeIndex={editorFind.active}
            label="Find in file"
            floating
            focusTrigger={findNavState.editorFindFocusTrigger}
            onQueryChange={(query) => editorFind.setQuery(query)}
            enableReplace={!deletedAtCheckpoint}
            replaceValue={editorFind.replaceValue}
            onReplaceChange={(value) => (editorFind.replaceValue = value)}
            onReplaceOne={() => editorFind.replaceOne()}
            onReplaceAll={() => editorFind.replaceAll()}
            onNext={() => editorFind.next()}
            onPrev={() => editorFind.prev()}
            onClose={() => editorFind.close()}
          />
        {:else if goToLineOpen && fullscreenOpen && activeTab}
          <GoToLine
            maxLine={visibleLineCount}
            focusTrigger={goToLineFocusTrigger}
            floating
            onSubmit={submitGoToLine}
            onClose={() => (goToLineOpen = false)}
          />
        {/if}
        {#if activeTab?.view === 'diff' && checkpointDiff}
          <FileDiffView diff={checkpointDiff} />
        {:else if activeTab?.view === 'preview' && hasAnyPreview(previewFlags)}
          <ProjectFilesPanelPreviewPane
            path={activeTab.path}
            flags={previewFlags}
            {visibleContent}
            {htmlPreviewSrcdoc}
            {previewUrl}
            {imagePreviewSrc}
            {imagePreviewFailed}
            documentLoading={docPreview.loading}
            documentHtml={docPreview.html}
            documentFailed={docPreview.failed}
            documentError={docPreview.error}
            showDocumentError={false}
          />
        {:else if activeTab && (image || video || audio || activeSession || deletedAtCheckpoint)}
          {#if image}
            <FileImagePreview
              src={imagePreviewSrc}
              alt={activeTab.path}
              failed={imagePreviewFailed}
            />
          {:else if video || audio}
            <FileMediaPreview
              src={previewUrl}
              alt={activeTab.path}
              kind={video ? 'video' : 'audio'}
            />
          {:else if activeFileInMergeEditor && activeTab}
            <ConflictResolutionView
              {projectId}
              path={activeTab.path}
              wrap={wrapLines}
              onToggleWrap={() => wrapTextState.toggle()}
              onControllerChange={(next) => handleConflictController('fullscreen', next)}
              onStatusChange={(next) => handleConflictStatus('fullscreen', next)}
              onOpenOriginal={() => void openRawConflictSource()}
            />
          {:else}
            <ProjectTextEditor
              value={visibleContent}
              path={activeTab.path}
              readonly={deletedAtCheckpoint || Boolean(projectState.loadingPaths[activeTab.path])}
              ariaLabel={`${deletedAtCheckpoint ? 'View' : 'Edit'} ${activeTab.path} fullscreen`}
              spellcheck={markdown}
              {showLineNumbers}
              wrap={wrapLines}
              findQuery={findNavState.editorFindOpen ? editorFind.value : ''}
              findActiveIndex={editorFind.active}
              findNonce={editorFind.nonce}
              replaceRequest={editorFind.replaceRequest}
              {editRequest}
              focusLine={activeTab.focusLine}
              focusLineRequest={activeTab.focusLineRequest}
              onFindMatches={(matches) => editorFind.setMatches(matches)}
              onReplaceDone={(replaced) => editorFind.handleReplaceDone(replaced)}
              onInput={handleEditorInput}
            />
          {/if}
        {/if}
      </div>
    </div>
    {#if fullscreenExplorerOpen && activeTab}
      <div
        class="min-h-0"
        transition:slide={{ axis: 'x', duration: motionDuration(180), easing: cubicOut }}
      >
        <ProjectFileExplorer
          {projectId}
          {projectName}
          {projectState}
          onWidthChange={(width, persist) =>
            projectFilesWorkspace.setExplorerWidth(projectId, width, persist)}
          selectedPath={activeTab?.path ?? null}
          {lastTurnPaths}
          {activeCheckpointPaths}
          activeCheckpointId={activeTab?.checkpointId ?? null}
          conflictPaths={conflictedPaths}
          {conflictsOnly}
          onToggleConflicts={() => (gitState.conflictsMode = !gitState.conflictsMode)}
          onFileSelect={fullscreenOpenFile}
        />
      </div>
    {/if}
  </div>
</Modal>

<ProjectFilesPanelDialogs
  {fullscreenPendingPath}
  activeTabPath={activeTab?.path}
  onClearFullscreenPending={() => (fullscreenPendingPath = null)}
  onConfirmFullscreenSaveAndNavigate={() => void confirmFullscreenSaveAndNavigate()}
  {renameTarget}
  onClearRenameTarget={() => (renameTarget = null)}
  {mutationPending}
  onRenameSubmit={() => void renameSelected()}
  {deleteTargetPath}
  onClearDeleteTarget={() => (deleteTargetPath = null)}
  onConfirmDelete={() => void deleteSelected()}
/>

<FileInfoDialog {info} onClear={() => (info = null)} />

<ConfirmDialog
  open={reloadConfirmPath !== null}
  title={reloadConfirmTitle}
  onCancel={() => (reloadConfirmPath = null)}
  onConfirm={discardAndReloadSelected}
  confirmLabel="Discard and reload"
>
  <p>The version on disk replaces your unsaved edits.</p>
</ConfirmDialog>
