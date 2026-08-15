<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { AlertDialog, Dialog } from 'bits-ui'
  import { toast } from 'svelte-sonner'
  import {
    ChevronRight,
    Code2,
    Eye,
    FileDiff,
    FolderOpen,
    Loader2,
    PanelRight,
    Save,
    X
  } from '@lucide/svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { isAudioMime, isImageMime, isSvgMime, isVideoMime, mimeFromPath } from '$lib/mime'
  import { projectFilePreviewUrl } from '$lib/file-preview'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
  import { findNavState } from '$lib/stores/find-nav.svelte'
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import EditorOpenControl from './EditorOpenControl.svelte'
  import FileDiffView from './FileDiffView.svelte'
  import { diffDetails } from './file-diff'
  import DiffLayoutToggle from '../ui/DiffLayoutToggle.svelte'
  import { diffLayoutState, diffLayoutToggleLabel } from '$lib/stores/diff-layout.svelte'
  import { wrapTextState } from '$lib/stores/wrap-text.svelte'
  import FileImagePreview from './FileImagePreview.svelte'
  import FileMediaPreview from './FileMediaPreview.svelte'
  import FindInBar from './FindInBar.svelte'
  import GoToLine from './GoToLine.svelte'
  import ProjectFileExplorer from './ProjectFileExplorer.svelte'
  import ProjectTextEditor from './ProjectTextEditor.svelte'
  import ProjectFileViewerMenu from './ProjectFileViewerMenu.svelte'
  import type { AgentEvent, TurnCheckpointSummary } from '$shared/types'
  import type { ProjectTextFile } from '$shared/types'

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
  let markdown = $derived(activeTab ? /\.(?:md|mdown|markdown)$/iu.test(activeTab.path) : false)
  let pdf = $derived(activeTab ? /\.pdf$/iu.test(activeTab.path) : false)
  let image = $derived(activeTab ? isImageMime(mimeFromPath(activeTab.path)) : false)
  let svg = $derived(activeTab ? isSvgMime(mimeFromPath(activeTab.path)) : false)
  let video = $derived(activeTab ? isVideoMime(mimeFromPath(activeTab.path)) : false)
  let audio = $derived(activeTab ? isAudioMime(mimeFromPath(activeTab.path)) : false)
  let previewUrl = $derived(
    activeTab && (pdf || image || video || audio) && !svg
      ? projectFilePreviewUrl(projectId, activeTab.path)
      : null
  )
  // SVG is rendered natively in the renderer via a blob URL (animated SVGs
  // play), instead of the privileged `appfile://` scheme, which intentionally
  // refuses to serve project-controlled SVG.
  let svgPreviewUrl = $state<string | null>(null)
  let svgPreviewFailed = $state(false)
  $effect(() => {
    if (!activeTab || !svg) {
      if (svgPreviewUrl) {
        URL.revokeObjectURL(svgPreviewUrl)
        svgPreviewUrl = null
      }
      svgPreviewFailed = false
      return
    }
    let cancelled = false
    svgPreviewFailed = false
    void invoke('projectFiles:read', projectId, activeTab.path)
      .then((source: ProjectTextFile) => {
        if (cancelled) return
        const url = URL.createObjectURL(new Blob([source.content], { type: 'image/svg+xml' }))
        svgPreviewUrl = url
      })
      .catch(() => {
        if (cancelled) return
        svgPreviewFailed = true
      })
    return () => {
      cancelled = true
      if (svgPreviewUrl) {
        URL.revokeObjectURL(svgPreviewUrl)
        svgPreviewUrl = null
      }
      svgPreviewFailed = false
    }
  })
  let imagePreviewSrc = $derived(svg ? svgPreviewUrl : previewUrl)
  let imagePreviewFailed = $derived(svg ? svgPreviewFailed : false)
  let historicalContent = $derived(checkpointDiff?.after ?? checkpointDiff?.before ?? '')
  let visibleContent = $derived(
    deletedAtCheckpoint ? historicalContent : (activeSession?.draft ?? historicalContent)
  )
  let breadcrumbParts = $derived(activeTab?.path.split('/') ?? [])
  let visibleLineCount = $derived(visibleContent.split('\n').length)
  let showLineNumbers = $state(true)
  const wrapLines = $derived(wrapTextState.wrapped)
  let fullscreenOpen = $state(false)
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
      activeSession &&
      dirty &&
      !deletedAtCheckpoint &&
      !activeSession.saving
    ) {
      event.preventDefault()
      void projectFilesWorkspace.save(projectId, activeTab.path)
    }
  }

  function handleEditorKeydown(event: KeyboardEvent): void {
    if (
      event.key !== 'Tab' ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      !activeTab ||
      !activeSession ||
      !(event.currentTarget instanceof HTMLTextAreaElement)
    ) {
      return
    }
    event.preventDefault()
    const editor = event.currentTarget
    const start = editor.selectionStart
    const end = editor.selectionEnd
    const next = activeSession.draft.slice(0, start) + '  ' + activeSession.draft.slice(end)
    projectFilesWorkspace.updateDraft(projectId, activeTab.path, next)
    requestAnimationFrame(() => editor.setSelectionRange(start + 2, start + 2))
  }

  function handleEditorInput(event: Event): void {
    if (
      deletedAtCheckpoint ||
      !activeTab ||
      projectState.loadingPaths[activeTab.path] ||
      !(event.currentTarget instanceof HTMLTextAreaElement)
    ) {
      return
    }
    projectFilesWorkspace.updateDraft(projectId, activeTab.path, event.currentTarget.value)
  }

  function reloadSelected(): void {
    if (!activeTab) return
    if (dirty && !window.confirm(`Discard unsaved changes to ${activeTab.path} and reload it?`)) {
      return
    }
    void projectFilesWorkspace.reload(projectId, activeTab.path)
  }

  function fullscreenOpenFile(path: string): void {
    if (!activeTab) {
      void projectFilesWorkspace.openFile(projectId, path)
      return
    }
    if (activeTab.checkpointId && activeCheckpointPaths.includes(path)) {
      void projectFilesWorkspace.openCheckpointFile(projectId, activeTab.checkpointId, path, 'diff')
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

  function cancelFullscreenNavigate(): void {
    fullscreenPendingPath = null
  }

  function revealBreadcrumb(index: number): void {
    const directory = index < 0 ? '' : breadcrumbParts.slice(0, index + 1).join('/')
    void projectFilesWorkspace.revealDirectory(projectId, directory)
  }

  async function openSelectedInEditor(): Promise<void> {
    if (!activeTab) return
    await invoke('projectFiles:openInEditor', projectId, activeTab.path)
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
      toast.error(error instanceof Error ? error.message : 'The file could not be renamed')
    } finally {
      mutationPending = false
    }
  }

  function handleRenameSubmit(event: SubmitEvent): void {
    event.preventDefault()
    void renameSelected()
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
      toast.error(error instanceof Error ? error.message : 'The file could not be deleted')
    } finally {
      mutationPending = false
    }
  }

  let editorFindValue = $state('')
  let editorFindActive = $state(0)
  let editorFindTotal = $state(0)

  function closeEditorFind(): void {
    findNavState.closeEditorFind()
    editorFindValue = ''
    editorFindActive = 0
    editorFindTotal = 0
  }

  function handleEditorFindQuery(query: string): void {
    editorFindValue = query
    editorFindActive = 0
    editorFindTotal = 0
    findNavState.editorFindQuery = query
    findNavState.editorFindActiveIndex = 0
    findNavState.editorFindMatches = 0
    findNavState.editorFindOpen = true
  }

  function handleEditorFindMatches(matches: number): void {
    editorFindTotal = matches
    findNavState.editorFindMatches = matches
  }

  function editorFindNext(): void {
    if (editorFindTotal === 0) return
    const next = (editorFindActive + 1) % editorFindTotal
    editorFindActive = next
    findNavState.editorFindActiveIndex = next
  }

  function editorFindPrev(): void {
    if (editorFindTotal === 0) return
    const prev = (editorFindActive - 1 + editorFindTotal) % editorFindTotal
    editorFindActive = prev
    findNavState.editorFindActiveIndex = prev
  }

  function submitGoToLine(line: number): void {
    if (!activeTab) return
    goToLineOpen = false
    projectFilesWorkspace.focusLine(projectId, activeTab.id, line)
  }
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

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
          class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-[10px] text-muted"
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
          <PanelRight size={15} />
        </button>
      </div>

      {#if activeTab}
        <div class="flex h-8 shrink-0 items-center gap-0.5 border-b border-border px-2">
          <button
            type="button"
            class={[
              'flex h-6 w-6 items-center justify-center rounded transition-colors disabled:opacity-30',
              activeTab.view === 'diff'
                ? 'bg-overlay text-foreground'
                : 'text-dimmed hover:bg-elevated hover:text-foreground'
            ]}
            aria-label="Show file diff"
            aria-pressed={activeTab.view === 'diff'}
            title="Diff"
            disabled={!checkpointDiff}
            onclick={() => projectFilesWorkspace.setView(projectId, activeTab.id, 'diff')}
          >
            <FileDiff size={12} />
          </button>
          {#if markdown || pdf || image || video || audio}
            <button
              type="button"
              class={[
                'flex h-6 w-6 items-center justify-center rounded transition-colors',
                activeTab.view === 'preview'
                  ? 'bg-overlay text-foreground'
                  : 'text-dimmed hover:bg-elevated hover:text-foreground'
              ]}
              aria-label={pdf
                ? 'Preview PDF'
                : video
                  ? 'Preview video'
                  : audio
                    ? 'Preview audio'
                    : image
                      ? 'Preview image'
                      : 'Preview Markdown'}
              aria-pressed={activeTab.view === 'preview'}
              title={pdf
                ? 'PDF preview'
                : video
                  ? 'Video preview'
                  : audio
                    ? 'Audio preview'
                    : image
                      ? 'Image preview'
                      : 'Markdown preview'}
              onclick={() => projectFilesWorkspace.setView(projectId, activeTab.id, 'preview')}
            >
              <Eye size={12} />
            </button>
          {/if}
          <button
            type="button"
            class={[
              'flex h-6 w-6 items-center justify-center rounded transition-colors',
              activeTab.view === 'source'
                ? 'bg-overlay text-foreground'
                : 'text-dimmed hover:bg-elevated hover:text-foreground'
            ]}
            aria-label="Edit source"
            aria-pressed={activeTab.view === 'source'}
            title={deletedAtCheckpoint ? 'View deleted source' : 'Edit source'}
            onclick={() => projectFilesWorkspace.setView(projectId, activeTab.id, 'source')}
          >
            <Code2 size={12} />
          </button>
          {#if deletedAtCheckpoint}
            <span class="ml-1 text-[9px] font-medium text-danger">Deleted · read-only</span>
          {/if}
          {#if diffStats}
            <span
              class="ml-1 font-mono text-[10px] tabular-nums text-success"
              aria-label="Added lines">+{diffStats.additions}</span
            >
            <span class="font-mono text-[10px] tabular-nums text-danger" aria-label="Deleted lines"
              >−{diffStats.deletions}</span
            >
            {#if checkpointDiff?.truncated}
              <span class="text-[9px] text-warning" title="Preview truncated at 64 KiB"
                >Truncated</span
              >
            {/if}
            <DiffLayoutToggle title={diffLayoutToggleLabel(diffLayoutState.layout)} size={12} />
          {/if}
          <span class="flex-1"></span>
          <ProjectFileViewerMenu
            diffView={activeTab.view === 'diff'}
            lineNumbers={showLineNumbers}
            wrap={wrapLines}
            reloadDisabled={deletedAtCheckpoint ||
              !activeSession ||
              Boolean(projectState.loadingPaths[activeTab.path]) ||
              activeSession.saving}
            mutationDisabled={deletedAtCheckpoint || mutationPending}
            onReload={reloadSelected}
            onToggleLineNumbers={() => (showLineNumbers = !showLineNumbers)}
            onToggleWrap={() => wrapTextState.toggle()}
            onFullscreen={() => (fullscreenOpen = true)}
            onRename={startRename}
            onDelete={() => (deleteTargetPath = activeTab.path)}
          />
          {#if activeTab.view !== 'diff'}
            <button
              type="button"
              class="flex h-6 items-center gap-1 rounded bg-primary px-2 text-[10px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-30"
              disabled={deletedAtCheckpoint || !dirty || activeSession?.saving}
              title="Save file (Cmd/Ctrl+S)"
              onclick={() => void projectFilesWorkspace.save(projectId, activeTab.path)}
            >
              {#if activeSession?.saving}
                <Loader2 size={11} class="animate-spin" />
              {:else}
                <Save size={11} />
              {/if}
              Save
            </button>
          {/if}
        </div>
      {/if}

      {#if activeSession?.error}
        <div
          class="shrink-0 border-b border-danger/20 bg-danger/10 px-3 py-2 text-[10px] leading-relaxed text-danger"
        >
          {activeSession.error}
        </div>
      {/if}

      {#if findNavState.editorFindOpen && !fullscreenOpen && activeTab && activeTab.view !== 'diff' && activeTab.view !== 'preview'}
        <FindInBar
          query={editorFindValue}
          matches={editorFindTotal}
          activeIndex={editorFindActive}
          label="Find in file"
          floating
          focusTrigger={findNavState.editorFindFocusTrigger}
          onQueryChange={handleEditorFindQuery}
          onNext={editorFindNext}
          onPrev={editorFindPrev}
          onClose={closeEditorFind}
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
            <p class="mt-1 text-[10px] text-dimmed">Select a file from the workspace tree.</p>
            {#if !projectState.explorerVisible}
              <button
                type="button"
                class="mt-3 rounded border border-border bg-elevated px-3 py-1.5 text-[10px] font-medium text-foreground hover:bg-overlay"
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
            <p class="mt-1 text-[10px] leading-4 text-dimmed">{activeTab.error}</p>
          </div>
          {#if activeTab.checkpointId}
            <button
              type="button"
              class="rounded border border-border bg-elevated px-3 py-1.5 text-[10px] font-medium text-muted hover:bg-overlay hover:text-foreground"
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
        <div class="flex flex-1 items-center justify-center gap-2 text-[11px] text-dimmed">
          <Loader2 size={13} class="animate-spin" />
          Loading diff
        </div>
      {:else if activeTab.view === 'diff' && checkpointDiff}
        <FileDiffView diff={checkpointDiff} />
      {:else if activeTab.view === 'preview' && markdown}
        <div class="min-h-0 flex-1 overflow-auto px-4 py-3">
          <MarkdownView text={visibleContent} class="text-sm text-foreground" />
        </div>
      {:else if activeTab.view === 'preview' && pdf}
        <div class="min-h-0 flex-1 overflow-auto">
          {#if previewUrl}
            <iframe
              src={previewUrl}
              class="h-full w-full border-0"
              title={`Preview ${activeTab.path}`}
            ></iframe>
          {/if}
        </div>
      {:else if activeTab.view === 'preview' && image}
        <FileImagePreview src={imagePreviewSrc} alt={activeTab.path} failed={imagePreviewFailed} />
      {:else if activeTab.view === 'preview' && (video || audio)}
        <FileMediaPreview src={previewUrl} alt={activeTab.path} kind={video ? 'video' : 'audio'} />
      {:else if projectState.loadingPaths[activeTab.path] && !activeSession && !deletedAtCheckpoint}
        <div class="flex flex-1 items-center justify-center gap-2 text-[11px] text-dimmed">
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
              <p class="mt-1 text-[10px] text-dimmed">You can open it with your editor.</p>
            </div>
            <button
              type="button"
              class="rounded border border-border bg-elevated px-3 py-1.5 text-[10px] font-medium text-muted hover:text-foreground"
              onclick={openSelectedInEditor}
            >
              Open in editor
            </button>
          </div>
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
            findQuery={findNavState.editorFindOpen && !fullscreenOpen ? editorFindValue : ''}
            findActiveIndex={editorFindActive}
            focusLine={activeTab.focusLine}
            focusLineRequest={activeTab.focusLineRequest}
            onFindMatches={fullscreenOpen ? undefined : handleEditorFindMatches}
            onInput={handleEditorInput}
            onKeydown={handleEditorKeydown}
          />
        {/key}
      {/if}
    </section>

    {#if projectState.explorerVisible}
      <ProjectFileExplorer
        {projectId}
        {projectName}
        {projectState}
        selectedPath={activeTab?.path ?? null}
        {lastTurnPaths}
        {activeCheckpointPaths}
        activeCheckpointId={activeTab?.checkpointId ?? null}
      />
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
        {#if activeTab?.view !== 'diff'}
          <button
            type="button"
            class="titlebar-no-drag flex h-7 items-center gap-1 rounded bg-primary px-2 text-[10px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-30"
            disabled={deletedAtCheckpoint || !dirty || activeSession?.saving}
            title="Save file (Cmd/Ctrl+S)"
            onclick={() => activeTab && void projectFilesWorkspace.save(projectId, activeTab.path)}
          >
            {#if activeSession?.saving}
              <Loader2 size={11} class="animate-spin" />
            {:else}
              <Save size={11} />
            {/if}
            Save
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
          <PanelRight size={15} />
        </button>
        <Dialog.Close
          class="titlebar-no-drag flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          aria-label={activeTab?.view === 'diff'
            ? 'Close fullscreen diff'
            : 'Close fullscreen editor'}
          title={activeTab?.view === 'diff' ? 'Close fullscreen diff' : 'Close fullscreen editor'}
        >
          <X size={14} />
        </Dialog.Close>
      </div>
      {#if activeTab}
        <div class="flex h-8 shrink-0 items-center gap-0.5 border-b border-border px-2">
          <button
            type="button"
            class={[
              'flex h-6 w-6 items-center justify-center rounded transition-colors disabled:opacity-30',
              activeTab.view === 'diff'
                ? 'bg-overlay text-foreground'
                : 'text-dimmed hover:bg-elevated hover:text-foreground'
            ]}
            aria-label="Show file diff"
            aria-pressed={activeTab.view === 'diff'}
            title="Diff"
            disabled={!checkpointDiff}
            onclick={() => projectFilesWorkspace.setView(projectId, activeTab.id, 'diff')}
          >
            <FileDiff size={12} />
          </button>
          {#if markdown || pdf || image || video || audio}
            <button
              type="button"
              class={[
                'flex h-6 w-6 items-center justify-center rounded transition-colors',
                activeTab.view === 'preview'
                  ? 'bg-overlay text-foreground'
                  : 'text-dimmed hover:bg-elevated hover:text-foreground'
              ]}
              aria-label={pdf
                ? 'Preview PDF'
                : video
                  ? 'Preview video'
                  : audio
                    ? 'Preview audio'
                    : image
                      ? 'Preview image'
                      : 'Preview Markdown'}
              aria-pressed={activeTab.view === 'preview'}
              title={pdf
                ? 'PDF preview'
                : video
                  ? 'Video preview'
                  : audio
                    ? 'Audio preview'
                    : image
                      ? 'Image preview'
                      : 'Markdown preview'}
              onclick={() => projectFilesWorkspace.setView(projectId, activeTab.id, 'preview')}
            >
              <Eye size={12} />
            </button>
          {/if}
          <button
            type="button"
            class={[
              'flex h-6 w-6 items-center justify-center rounded transition-colors',
              activeTab.view === 'source'
                ? 'bg-overlay text-foreground'
                : 'text-dimmed hover:bg-elevated hover:text-foreground'
            ]}
            aria-label="Edit source"
            aria-pressed={activeTab.view === 'source'}
            title={deletedAtCheckpoint ? 'View deleted source' : 'Edit source'}
            onclick={() => projectFilesWorkspace.setView(projectId, activeTab.id, 'source')}
          >
            <Code2 size={12} />
          </button>
          {#if deletedAtCheckpoint}
            <span class="ml-1 text-[9px] font-medium text-danger">Deleted · read-only</span>
          {/if}
          {#if diffStats}
            <span
              class="ml-1 font-mono text-[10px] tabular-nums text-success"
              aria-label="Added lines">+{diffStats.additions}</span
            >
            <span class="font-mono text-[10px] tabular-nums text-danger" aria-label="Deleted lines"
              >−{diffStats.deletions}</span
            >
            {#if checkpointDiff?.truncated}
              <span class="text-[9px] text-warning" title="Preview truncated at 64 KiB"
                >Truncated</span
              >
            {/if}
            <DiffLayoutToggle title={diffLayoutToggleLabel(diffLayoutState.layout)} size={12} />
          {/if}
          <span class="flex-1"></span>
          <ProjectFileViewerMenu
            diffView={activeTab.view === 'diff'}
            lineNumbers={showLineNumbers}
            wrap={wrapLines}
            reloadDisabled={deletedAtCheckpoint ||
              !activeSession ||
              Boolean(projectState.loadingPaths[activeTab.path]) ||
              activeSession.saving}
            mutationDisabled={deletedAtCheckpoint || mutationPending}
            hideFullscreen
            onReload={reloadSelected}
            onToggleLineNumbers={() => (showLineNumbers = !showLineNumbers)}
            onToggleWrap={() => wrapTextState.toggle()}
            onFullscreen={() => (fullscreenOpen = true)}
            onRename={startRename}
            onDelete={() => (deleteTargetPath = activeTab.path)}
          />
        </div>
      {/if}
      <div class="flex min-h-0 min-w-0 flex-1">
        <div
          class="relative flex min-h-0 min-w-0 flex-1 flex-col"
          data-region="editor"
          data-find-active={fullscreenOpen ? 'true' : undefined}
        >
          {#if findNavState.editorFindOpen && fullscreenOpen && activeTab && activeTab.view !== 'diff' && activeTab.view !== 'preview'}
            <FindInBar
              query={editorFindValue}
              matches={editorFindTotal}
              activeIndex={editorFindActive}
              label="Find in file"
              floating
              focusTrigger={findNavState.editorFindFocusTrigger}
              onQueryChange={handleEditorFindQuery}
              onNext={editorFindNext}
              onPrev={editorFindPrev}
              onClose={closeEditorFind}
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
          {:else if activeTab?.view === 'preview' && markdown}
            <div class="min-h-0 flex-1 overflow-auto px-4 py-3">
              <MarkdownView text={visibleContent} class="text-sm text-foreground" />
            </div>
          {:else if activeTab?.view === 'preview' && pdf}
            <div class="min-h-0 flex-1 overflow-auto">
              {#if previewUrl}
                <iframe
                  src={previewUrl}
                  class="h-full w-full border-0"
                  title={`Preview ${activeTab.path}`}
                ></iframe>
              {/if}
            </div>
          {:else if activeTab?.view === 'preview' && image}
            <FileImagePreview
              src={imagePreviewSrc}
              alt={activeTab.path}
              failed={imagePreviewFailed}
            />
          {:else if activeTab?.view === 'preview' && (video || audio)}
            <FileMediaPreview
              src={previewUrl}
              alt={activeTab.path}
              kind={video ? 'video' : 'audio'}
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
            {:else}
              <ProjectTextEditor
                value={visibleContent}
                path={activeTab.path}
                readonly={deletedAtCheckpoint || Boolean(projectState.loadingPaths[activeTab.path])}
                ariaLabel={`${deletedAtCheckpoint ? 'View' : 'Edit'} ${activeTab.path} fullscreen`}
                spellcheck={markdown}
                {showLineNumbers}
                wrap={wrapLines}
                findQuery={findNavState.editorFindOpen ? editorFindValue : ''}
                findActiveIndex={editorFindActive}
                focusLine={activeTab.focusLine}
                focusLineRequest={activeTab.focusLineRequest}
                onFindMatches={handleEditorFindMatches}
                onInput={handleEditorInput}
                onKeydown={handleEditorKeydown}
              />
            {/if}
          {/if}
        </div>
        {#if fullscreenExplorerOpen && activeTab}
          <ProjectFileExplorer
            {projectId}
            {projectName}
            {projectState}
            selectedPath={activeTab.path}
            {lastTurnPaths}
            {activeCheckpointPaths}
            activeCheckpointId={activeTab.checkpointId}
            onFileSelect={fullscreenOpenFile}
          />
        {/if}
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<AlertDialog.Root
  bind:open={
    () => fullscreenPendingPath !== null, (open) => !open && (fullscreenPendingPath = null)
  }
>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-50 bg-overlay/70" />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <AlertDialog.Title class="text-sm font-semibold text-foreground">
        Unsaved changes
      </AlertDialog.Title>
      <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
        Save changes to {activeTab?.path} before viewing another file?
      </AlertDialog.Description>
      <div class="mt-5 flex justify-end gap-2">
        <AlertDialog.Cancel
          class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
          onclick={cancelFullscreenNavigate}
        >
          Cancel
        </AlertDialog.Cancel>
        <AlertDialog.Action
          class="h-8 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          onclick={() => void confirmFullscreenSaveAndNavigate()}
        >
          Save
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>

<Dialog.Root bind:open={() => renameTarget !== null, (open) => !open && (renameTarget = null)}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-overlay/70" />
    <Dialog.Content
      class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <Dialog.Title class="text-sm font-semibold text-foreground">Rename file</Dialog.Title>
      <Dialog.Description class="mt-1 text-xs text-muted">
        Enter a new file name, including its extension.
      </Dialog.Description>
      {#if renameTarget}
        <form class="mt-4" onsubmit={handleRenameSubmit}>
          <label class="text-xs font-medium text-foreground" for="viewer-rename-file">
            File name
          </label>
          <input
            id="viewer-rename-file"
            bind:value={renameTarget.name}
            class="mt-1 h-9 w-full rounded-lg border border-border bg-app px-3 text-sm text-foreground outline-none focus:border-primary"
            autocomplete="off"
          />
          <div class="mt-5 flex justify-end gap-2">
            <Dialog.Close
              class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
            >
              Cancel
            </Dialog.Close>
            <button
              type="submit"
              class="h-8 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
              disabled={mutationPending || !renameTarget.name.trim()}
            >
              Rename
            </button>
          </div>
        </form>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<AlertDialog.Root
  bind:open={() => deleteTargetPath !== null, (open) => !open && (deleteTargetPath = null)}
>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-50 bg-overlay/70" />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <AlertDialog.Title class="text-sm font-semibold text-foreground">
        Delete file?
      </AlertDialog.Title>
      <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
        {deleteTargetPath} will be moved to Trash. Its open tab will close.
      </AlertDialog.Description>
      <div class="mt-5 flex justify-end gap-2">
        <AlertDialog.Cancel
          class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
        >
          Cancel
        </AlertDialog.Cancel>
        <AlertDialog.Action
          class="h-8 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
          disabled={mutationPending}
          onclick={() => void deleteSelected()}
        >
          Move to Trash
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
