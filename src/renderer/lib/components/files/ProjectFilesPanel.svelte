<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { slide } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'
  import { Dialog } from 'bits-ui'
  import { toast } from 'svelte-sonner'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import {
    ChevronRight,
    FolderTree,
    FolderOpen,
    Loader2,
    Minimize2,
    Save,
    TriangleAlert
  } from '@lucide/svelte'
  import { htmlPreviewFrame } from '$lib/document-preview-frame'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import ConflictResolutionView from './ConflictResolutionView.svelte'
  import type {
    ConflictResolutionController,
    ConflictResolutionStatus
  } from './conflict-resolution'
  import { motionDuration } from '$lib/motion'
  import { supportsFilePreview } from '$lib/mime'
  import { projectFilePreviewUrl } from '$lib/file-preview'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
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
  import type { AgentEvent, TurnCheckpointSummary } from '$shared/types'
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
  let activePathIsConflicted = $derived(
    activeTab?.origin === 'working' && conflictedPaths.includes(activeTab.path)
  )
  /** Undo/redo toolbar buttons apply to the plain file editor only: the
   *  editable source view with a session, not diffs, previews, the
   *  conflict-resolution editor, or read-only deleted files. */
  let canUndoRedo = $derived(
    activeSession !== null &&
      !deletedAtCheckpoint &&
      !activePathIsConflicted &&
      activeTab?.view === 'source'
  )
  /** Beautify is offered for the same editable source view as undo/redo, and
   *  only for a format the editor can reformat. The label doubles as the flag,
   *  so no action is shown that could not run. */
  let beautifyLabel = $derived(
    activeTab !== null &&
      activeSession !== null &&
      !deletedAtCheckpoint &&
      !activePathIsConflicted &&
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
      (activePathIsConflicted || (activeSession !== null && dirty))
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
  let fullscreenOpen = $state(false)
  // The browser's native view floats above every DOM overlay, so a full-window
  // editor must register itself as a fullscreen surface while it is up. The
  // returned cleanup matters here: this panel is unmounted whenever the sidebar
  // hides or its active tab changes, and a key left behind would suppress the
  // browser view for the rest of the session.
  $effect(() =>
    browserVisibility.hideWhile('files-fullscreen-editor', 'fullscreen-surface', fullscreenOpen)
  )
  let handledFullscreenRequest = $state(0)
  let conflictController = $state<ConflictResolutionController | null>(null)
  let conflictStatus = $state<ConflictResolutionStatus>({
    canSave: false,
    dirty: false,
    saving: false
  })
  let fullscreenExplorerOpen = $state(false)
  let fullscreenPendingPath = $state<string | null>(null)
  let renameTarget = $state<{ path: string; name: string } | null>(null)
  let deleteTargetPath = $state<string | null>(null)
  let mutationPending = $state(false)
  let goToLineOpen = $state(false)
  let goToLineFocusTrigger = $state(0)
  let lastTurnPaths = $state<string[]>([])
  let activeCheckpointPaths = $state<string[]>([])
  let lastTurnRequest = 0

  $effect(() => {
    const request = projectState.fullscreenRequest
    if (request <= handledFullscreenRequest) return
    handledFullscreenRequest = request
    fullscreenOpen = true
    if (gitState.conflictsMode) fullscreenExplorerOpen = true
  })

  function handleConflictController(next: ConflictResolutionController | null): void {
    conflictController = next
  }

  function handleConflictStatus(next: ConflictResolutionStatus): void {
    conflictStatus = next
  }

  async function saveActiveFile(): Promise<void> {
    if (!activeTab) return
    if (activePathIsConflicted) {
      await conflictController?.save()
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
      event.key.toLowerCase() === 's' &&
      activeTab &&
      activeTab.view !== 'diff' &&
      (activePathIsConflicted || activeSession) &&
      (activePathIsConflicted ? conflictStatus.canSave : dirty) &&
      !deletedAtCheckpoint &&
      !(activePathIsConflicted ? conflictStatus.saving : activeSession?.saving)
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
    if (dirty && !window.confirm(`Discard unsaved changes to ${activeTab.path} and reload it?`)) {
      return
    }
    void projectFilesWorkspace.reload(projectId, activeTab.path)
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

  function fullscreenOpenFile(path: string): void {
    if (path === activeTab?.path) return
    // Opening a checkpoint (last-turn) diff never leaves the fullscreen modal:
    // switch to the new file's diff in place.
    if (activeTab?.checkpointId && activeCheckpointPaths.includes(path)) {
      void projectFilesWorkspace.openCheckpointFile(projectId, activeTab.checkpointId, path, 'diff')
      return
    }
    if (!activeTab) {
      void projectFilesWorkspace.openFile(projectId, path)
      return
    }
    if (dirty) {
      fullscreenPendingPath = path
      return
    }
    const currentPath = activeTab.path
    contextSidebarState.updateProjectFileMapping(
      projectId,
      `working:${currentPath}`,
      `working:${path}`,
      path
    )
    void projectFilesWorkspace.swapFileSilent(projectId, currentPath, path)
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
      fullscreenOpen = false
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
            (activePathIsConflicted ? !conflictStatus.canSave : !dirty) ||
            (activePathIsConflicted ? conflictStatus.saving : Boolean(activeSession?.saving))}
          saving={activePathIsConflicted ? conflictStatus.saving : Boolean(activeSession?.saving)}
          saveLabel={activePathIsConflicted
            ? 'Replace the original file and mark it resolved'
            : 'Save file (Cmd/Ctrl+S)'}
          fullscreen={false}
          onSetView={(view) => projectFilesWorkspace.setView(projectId, activeTab.id, view)}
          onUndo={() => requestEdit('undo')}
          onRedo={() => requestEdit('redo')}
          onReload={reloadSelected}
          onToggleLineNumbers={() => (showLineNumbers = !showLineNumbers)}
          onToggleWrap={() => wrapTextState.toggle()}
          onBeautify={beautifyActiveFile}
          onFullscreen={() => (fullscreenOpen = true)}
          onRename={startRename}
          onDelete={() => (deleteTargetPath = activeTab.path)}
          onSave={() => void saveActiveFile()}
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
      {:else if activePathIsConflicted && activeTab}
        {#if !fullscreenOpen}
          <ConflictResolutionView
            {projectId}
            path={activeTab.path}
            wrap={wrapLines}
            onToggleWrap={() => wrapTextState.toggle()}
            onControllerChange={handleConflictController}
            onStatusChange={handleConflictStatus}
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

<Dialog.Root bind:open={fullscreenOpen}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-overlay/80 backdrop-blur-sm" />
    <Dialog.Content
      class="fixed inset-0 z-50 flex min-h-0 flex-col overflow-hidden bg-app shadow-xl outline-none"
    >
      <div
        class="titlebar-drag flex h-10 shrink-0 items-center gap-2 border-b border-border pr-3"
        style={trafficLightInsetStyle()}
      >
        <Dialog.Title class="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
          {activeTab?.path ?? 'File'}
        </Dialog.Title>
        <Dialog.Description class="sr-only">
          {activeTab?.view === 'diff' ? 'Fullscreen file diff' : 'Fullscreen file editor'}
        </Dialog.Description>
        {#if showSaveButton}
          <button
            type="button"
            class="titlebar-no-drag flex h-7 items-center gap-1 rounded bg-primary px-2 text-[0.625rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-30"
            disabled={deletedAtCheckpoint ||
              (activePathIsConflicted ? !conflictStatus.canSave : !dirty) ||
              (activePathIsConflicted ? conflictStatus.saving : activeSession?.saving)}
            title={activePathIsConflicted
              ? 'Replace the original file and mark it resolved'
              : 'Save file (Cmd/Ctrl+S)'}
            onclick={() => void saveActiveFile()}
          >
            {#if activePathIsConflicted ? conflictStatus.saving : activeSession?.saving}
              <Loader2 size={11} class="animate-spin" />
            {:else}
              <Save size={11} />
            {/if}
            {activePathIsConflicted ? 'Mark as resolved' : 'Save'}
          </button>
        {/if}
        <button
          type="button"
          class={[
            'titlebar-no-drag flex h-7 w-7 items-center justify-center rounded transition-colors',
            fullscreenExplorerOpen
              ? 'bg-overlay text-primary'
              : 'text-dimmed hover:bg-elevated hover:text-foreground'
          ]}
          aria-label={fullscreenExplorerOpen ? 'Hide file tree' : 'Show file tree'}
          aria-pressed={fullscreenExplorerOpen}
          title={fullscreenExplorerOpen ? 'Hide file tree' : 'Show file tree'}
          onclick={() => (fullscreenExplorerOpen = !fullscreenExplorerOpen)}
        >
          <FolderTree size={15} />
        </button>
        <Dialog.Close
          class="titlebar-no-drag flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Minimize fullscreen file viewer"
          title="Minimize fullscreen file viewer"
        >
          <Minimize2 size={14} />
        </Dialog.Close>
      </div>
      {#if activeTab && !activePathIsConflicted}
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
          onUndo={() => requestEdit('undo')}
          onRedo={() => requestEdit('redo')}
          onReload={reloadSelected}
          onToggleLineNumbers={() => (showLineNumbers = !showLineNumbers)}
          onToggleWrap={() => wrapTextState.toggle()}
          onBeautify={beautifyActiveFile}
          onFullscreen={() => (fullscreenOpen = true)}
          onRename={startRename}
          onDelete={() => (deleteTargetPath = activeTab.path)}
          onSave={() => void saveActiveFile()}
        />
      {/if}
      <div class="relative flex min-h-0 min-w-0 flex-1">
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
            {:else if activePathIsConflicted && activeTab}
              <ConflictResolutionView
                {projectId}
                path={activeTab.path}
                wrap={wrapLines}
                onToggleWrap={() => wrapTextState.toggle()}
                onControllerChange={handleConflictController}
                onStatusChange={handleConflictStatus}
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
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

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
