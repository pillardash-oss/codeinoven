<script lang="ts">
  import { AppPanelPortal } from '$lib/app-panel-portal'
  const sidebarIdeStatusPortal = new AppPanelPortal()
  const fullscreenIdeStatusPortal = new AppPanelPortal()
  import { fileTabLabels } from '$lib/file-tab-labels'
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioTemporaryChat from '@pdslng/cio-icon/CioTemporaryChat.svelte'
  import { fullscreenFileChatSlot, fullscreenFileChatTabs } from '$lib/fullscreen-file-chat-portal'
  import CioFiles from '@pdslng/cio-icon/CioFiles.svelte'
  import CioFolderOpen from '@pdslng/cio-icon/CioFolderOpen.svelte'
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import CioMinimize from '@pdslng/cio-icon/CioMinimize.svelte'
  import CioSave from '@pdslng/cio-icon/CioSave.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { onMount, tick } from 'svelte'
  import { LastKnown } from '$lib/last-known'
  import { slide } from 'svelte/transition'
  import { cubicOut } from 'svelte/easing'
  import { toast } from 'svelte-sonner'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { htmlPreviewFrame } from '$lib/document-preview-frame'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { AssistantDefaultIcon } from '$lib/assistant-icons'
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
  import { mimeFromPath, supportsFilePreview } from '$lib/mime'
  import { hasNoTextSource } from '$lib/stores/project-files-state'
  import { projectFilePreviewUrl } from '$lib/file-preview'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import type { FilesContextTab } from '$lib/stores/context-sidebar.svelte'
  import {
    projectFilesWorkspace,
    type ProjectFileTab,
    type ProjectFileView
  } from '$lib/stores/project-files.svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import { findNavState } from '$lib/stores/find-nav.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'
  import EditorOpenControl from './EditorOpenControl.svelte'
  import FileDiffView from './FileDiffView.svelte'
  import { FileDiffState } from './file-diff-state.svelte'
  import { wrapTextState } from '$lib/stores/wrap-text.svelte'
  import { beautifyFileContent, fileBeautifyLabel } from '$lib/file-beautify'
  import FileImagePreview from './FileImagePreview.svelte'
  import FileMediaPreview from './FileMediaPreview.svelte'
  import FindInBar from './FindInBar.svelte'
  import FindInSurface from '../threads/FindInSurface.svelte'
  import GoToLine from './GoToLine.svelte'
  import ProjectFileExplorer from './ProjectFileExplorer.svelte'
  import FileTypeIcon from './FileTypeIcon.svelte'
  import FileInfoDialog from './FileInfoDialog.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import ProjectFilesPanelDialogs from './ProjectFilesPanelDialogs.svelte'
  import ProjectFilesPanelAnnotator from './ProjectFilesPanelAnnotator.svelte'
  import ProjectFilesPanelPreviewPane from './ProjectFilesPanelPreviewPane.svelte'
  import ProjectFilesPanelToolbar from './ProjectFilesPanelToolbar.svelte'
  import ProjectFilesPanelReadAlong from './ProjectFilesPanelReadAlong.svelte'
  import { ProjectFilesPanelFind } from './project-files-panel-find.svelte'
  import { ProjectFilesPanelDocumentPreview } from './project-files-panel-document-preview.svelte'
  import {
    canAnnotateDocument,
    filePreviewFlags,
    hasAnyPreview,
    previewKindLabel as previewKindLabelFor
  } from './project-files-panel-preview'
  import {
    documentReadAloudId,
    hasSpeakableText,
    type DocumentReadAloud
  } from './project-files-panel-read-aloud'
  import ProjectTextEditor from './ProjectTextEditor.svelte'
  import type { AgentEvent, ProjectFileInfo, TurnCheckpointSummary } from '$shared/types'
  import { posixDirname } from '$shared/paths'
  import { ovenRootThread } from '$lib/oven-root-target'
  import { speechController } from '$lib/speech/speech-controller.svelte'
  import { usesThreadWorkspaceMount } from '$shared/types'

  interface Props {
    projectId: string
    projectName: string
    /** Label shown as the tree's root name. Empty when the root names itself
     *  with the icon alone, which is the case for an assistant, whose name is
     *  often a whole sentence. */
    projectLabel?: string
    projectIconUrl?: string | null
    /** True when the tree's root is an assistant, so the root icon falls back to
     *  the assistant default mark instead of a generic folder. */
    assistantRoot?: boolean
    /** Accent colour of the tree's root identity, or null for the default
     *  accent. An assistant task's tree mounts on its assistant's own workspace,
     *  so the parent passes that assistant's colour here. */
    projectAccentColor?: string | null
  }

  let {
    projectId,
    projectName,
    projectLabel = projectName,
    projectIconUrl = null,
    assistantRoot = false,
    projectAccentColor = null
  }: Props = $props()

  let contextTab = $derived(
    contextSidebarState.sidebarActiveTab?.kind === 'files'
      ? contextSidebarState.sidebarActiveTab
      : null
  )
  const lastFilesContext = new LastKnown<FilesContextTab>()
  let retainedContextTab = $derived(lastFilesContext.get(contextTab))
  let activeThreadId = $derived(retainedContextTab?.threadId ?? null)
  /** A conversation's file tree mounts on the thread's own app-owned workspace
   *  directory (a chat's artifact directory, an assistant task's working
   *  directory); real projects always use the project root regardless of the
   *  open thread. */
  let mountThreadId = $derived(
    usesThreadWorkspaceMount(projectId) || ovenRootThread(projectId) ? activeThreadId : null
  )
  /** Whether this tree is reading a checkout that lives on an Oven. */
  let ovenFile = $derived(Boolean(ovenRootThread(projectId)))
  $effect(() => {
    projectFilesWorkspace.setThreadMount(projectId, mountThreadId)
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
    retainedContextTab?.fileTabId
      ? (projectState.tabs.find((tab) => tab.id === retainedContextTab?.fileTabId) ?? null)
      : null
  )
  let activeSession = $derived(activeTab ? (projectState.sessions[activeTab.path] ?? null) : null)
  let dirty = $derived(activeSession ? activeSession.draft !== activeSession.source.content : false)
  /** The mime of the file on screen, and whether it has any text form at all.
   *  A rendered type with a text form (SVG, which is XML) keeps its source view. */
  let activeMime = $derived(activeTab ? mimeFromPath(activeTab.path) : null)
  let renderOnlyFile = $derived(activeMime !== null && hasNoTextSource(activeMime))
  let checkpointDiff = $derived(activeTab?.checkpointDiff ?? null)
  const diffComputation = new FileDiffState(() =>
    activeTab?.view === 'diff' && checkpointDiff && !checkpointDiff.binary
      ? {
          before: checkpointDiff.before,
          after: checkpointDiff.after,
          beforeStartLine: checkpointDiff.beforeStartLine,
          afterStartLine: checkpointDiff.afterStartLine
        }
      : null
  )
  let diffStats = $derived(diffComputation.details)
  let deletedAtCheckpoint = $derived(checkpointDiff?.kind === 'deleted')
  /** Reload is available for text files with a session and for previewable
   *  files without one (media, images, SVG, PDF, Files), which re-read
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
  /** What one editor surface (sidebar or fullscreen) last reported about its own
   *  undo/redo depth. The tab id rides along so a report from the file that was
   *  open a moment ago can never light up the current file's buttons. */
  interface EditorHistoryReport {
    tabId: string
    canUndo: boolean
    canRedo: boolean
  }
  let sidebarHistory = $state<EditorHistoryReport | null>(null)
  let fullscreenHistory = $state<EditorHistoryReport | null>(null)
  const reportsHistory = (report: EditorHistoryReport, tabId: string | undefined): boolean =>
    tabId !== undefined && report.tabId === tabId
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
  /** Undo/redo are only live when the editor behind that toolbar still holds
   *  history in that direction. The two surfaces own separate CodeMirror
   *  instances, so each toolbar reads its own report rather than sharing one. */
  let sidebarCanUndo = $derived(
    canUndoRedo &&
      sidebarHistory !== null &&
      reportsHistory(sidebarHistory, activeTab?.id) &&
      sidebarHistory.canUndo
  )
  let sidebarCanRedo = $derived(
    canUndoRedo &&
      sidebarHistory !== null &&
      reportsHistory(sidebarHistory, activeTab?.id) &&
      sidebarHistory.canRedo
  )
  let fullscreenCanUndo = $derived(
    canUndoRedo &&
      fullscreenHistory !== null &&
      reportsHistory(fullscreenHistory, activeTab?.id) &&
      fullscreenHistory.canUndo
  )
  let fullscreenCanRedo = $derived(
    canUndoRedo &&
      fullscreenHistory !== null &&
      reportsHistory(fullscreenHistory, activeTab?.id) &&
      fullscreenHistory.canRedo
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
   *  (images, PDF, media, Files, SVG) and clean sessions show no button. */
  let showSaveButton = $derived(
    activeTab !== null &&
      activeTab.view !== 'diff' &&
      !deletedAtCheckpoint &&
      (activeFileInMergeEditor || (activeSession !== null && dirty))
  )
  const previewFlags = $derived(filePreviewFlags(activeTab?.path ?? null))
  /**
   * Which find the reader can offer, and it is never both.
   *
   * The source view is an editor: it counts its own matches and owns replace.
   * Every other readable view (annotate, a Markdown preview, a diff) exists only
   * as rendered DOM, so its text is found by a document search instead. Asking
   * the editor for matches in those views answered nothing, which is why find
   * used to look broken the moment the document was not the raw file.
   */
  let editorFindAvailable = $derived(activeTab?.view === 'source')
  let documentFindAvailable = $derived.by(() => {
    if (!activeTab) return false
    if (activeTab.view === 'annotate') return showAnnotateToggle && activeThreadId !== null
    // An HTML, PDF or converted document preview is a sandboxed frame, so its
    // text is not reachable from this document at all. Only the Markdown
    // preview renders into the reader's own DOM.
    if (activeTab.view === 'preview') return previewFlags.markdown
    if (activeTab.view === 'diff') return Boolean(checkpointDiff)
    return false
  })
  /** The element the document search reads, and the one the reader marks with
   *  the surface its find command targets. */
  let sidebarEditorRegion = $state<HTMLElement | null>(null)
  let fullscreenEditorRegion = $state<HTMLElement | null>(null)
  let markdown = $derived(previewFlags.markdown)
  let htmlPreview = $derived(previewFlags.html)
  let pdf = $derived(previewFlags.pdf)
  let image = $derived(previewFlags.image)
  let video = $derived(previewFlags.video)
  let audio = $derived(previewFlags.audio)
  let previewReloadToken = $derived(
    activeTab ? (projectState.previewReloadTokens[activeTab.path] ?? 0) : 0
  )
  /** Every rendered file streams from disk through `appfile://`, SVG included:
   *  its response carries `default-src 'none'` and the `<img>` this feeds never
   *  runs the document's scripts, so no blob round-trip is needed. */
  let previewUrl = $derived(
    activeTab && (pdf || image || video || audio)
      ? projectFilePreviewUrl(
          projectId,
          activeTab.path,
          mountThreadId ?? undefined,
          previewReloadToken
        )
      : null
  )
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
      mountThreadId ?? undefined
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
  /** The annotate view is offered for the rendered documents that can carry a
   *  note (Markdown), and never while the conflict editor owns the body. */
  let showAnnotateToggle = $derived(canAnnotateDocument(previewFlags) && !activeFileInMergeEditor)
  /** An annotation is a composer reference, so there has to be a conversation
   *  open for it to attach to; the toolbar explains that instead of hiding. */
  let annotateDisabled = $derived(!activeThreadId || deletedAtCheckpoint)
  /** The active document as a read-aloud target. Read-aloud is offered for
   *  exactly the documents that carry annotations, the rendered Markdown whose
   *  text the viewer holds as plain source; the speaker control then hides
   *  itself while no text-to-speech model is installed. */
  let documentReadAloud = $derived.by<DocumentReadAloud | null>(() => {
    if (!activeTab || !showAnnotateToggle) return null
    return {
      messageId: documentReadAloudId(projectId, activeTab.path),
      markdown: visibleContent,
      scope: { kind: 'project', projectId, threadId: activeThreadId ?? undefined },
      disabled: !hasSpeakableText(visibleContent)
    }
  })
  /** Segments of this document's read-aloud while the read-along is up, so the
   *  body shows the lines being read instead of the file itself; null whenever
   *  the file belongs on screen. */
  let readAlongSegments = $derived(
    documentReadAloud !== null &&
      'messageId' in speechController.playback &&
      speechController.playback.messageId === documentReadAloud.messageId &&
      speechController.readingOverlayActive
      ? speechController.activeSegments
      : null
  )
  let fullscreenOpen = $derived(projectState.fullscreenActive)
  /** The editor region that is on screen, and therefore the one a document
   *  search reads. Both regions exist while the reader is up, so the search must
   *  never be handed the copy behind the modal. */
  let activeEditorRegion = $derived(fullscreenOpen ? fullscreenEditorRegion : sidebarEditorRegion)
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
  let fullscreenChatEnabled = $state(true)
  let fullscreenChatTabs = $derived(
    contextSidebarState.sidebarTabs.filter(
      (tab) => tab.kind === 'temporary-chat' && tab.projectId === projectId
    )
  )
  let fullscreenChatOpen = $derived(
    fullscreenChatEnabled &&
      contextSidebarState.sidebarVisible &&
      contextSidebarState.sidebarActiveTab?.kind === 'temporary-chat' &&
      fullscreenChatTabs.some((tab) => tab.id === contextSidebarState.sidebarActiveTabId)
  )

  function toggleFullscreenChat(): void {
    if (fullscreenChatOpen) {
      fullscreenChatEnabled = false
      return
    }
    const tab = fullscreenChatTabs.at(-1)
    if (!tab) return
    fullscreenChatEnabled = true
    contextSidebarState.focus(tab.id)
  }

  /** The reader's right side holds one panel at a time, so asking for the file
   *  tree puts the chat away and reveals the tree as it was left; asking again
   *  folds it back, exactly like the tree's own button in the sidebar reader. */
  function toggleFullscreenExplorer(): void {
    if (fullscreenChatOpen) {
      fullscreenChatEnabled = false
      // The chat held this side, so the tree keeps its own remembered state and
      // only needs opening here if the user had folded it earlier.
      if (!fullscreenExplorerOpen) projectFilesWorkspace.toggleExplorer(projectId)
      return
    }
    projectFilesWorkspace.toggleExplorer(projectId)
  }

  /** The toggle exists only once there is a temporary chat to show, so the
   *  reader stays as it was until a passage is explained or quick-chatted. */
  let fullscreenChatTitle = $derived(
    fullscreenChatOpen ? 'Hide temporary chats' : 'Show temporary chats'
  )

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
    restoreFullscreenChat()
  }

  function restoreFullscreenChat(): void {
    const tabId = fullscreenFileChatTabs.get(projectId)
    if (tabId && fullscreenChatTabs.some((tab) => tab.id === tabId)) {
      fullscreenChatEnabled = true
      contextSidebarState.focus(tabId)
    }
  }

  onMount(() => {
    if (fullscreenOpen) restoreFullscreenChat()
  })

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
    // The store is the whole transition: the editor's `open` is derived from it,
    // so there is no local mirror to keep in step. Assigning that derived as
    // well only overrides it  the store write is what closes the surface.
    const tabId = contextSidebarState.sidebarActiveTabId
    if (fullscreenChatOpen && tabId) fullscreenFileChatTabs.set(projectId, tabId)
    else fullscreenFileChatTabs.delete(projectId)
    findNavState.closeFileDocumentFind()
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
      keymapState.matches('files-goto-line', event) &&
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
    if (keymapState.matches('files-save', event) && conflictController !== null) {
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
      keymapState.matches('files-save', event) &&
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
      mountThreadId ?? undefined
    )
  }

  /**
   * Download one Oven file to this computer.
   *
   * The file lives on the Oven, so an external editor on this machine can only
   * work on a copy; the panel offers this in place of Open in editor. The copy
   * is read-only for the checkout   edits belong in the app editor, which saves
   * back to the Oven.
   */
  async function saveSelectedAs(): Promise<void> {
    if (!activeTab) return
    try {
      const path = await invoke(
        'projectFiles:saveAs',
        projectId,
        activeTab.path,
        workspaceState.activeScopeBucketIdFor(projectId),
        mountThreadId ?? undefined
      )
      if (path) toast.success('Saved a copy', { description: path })
    } catch (error) {
      reportError(error, 'The file could not be saved')
    }
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
  /** Whether the reader's own search command asked for replace as well, which
   *  the find bar honours as its initial state. */
  let editorFindWithReplace = $state(false)

  /**
   * Run the reader's find on the surface that is actually on screen.
   *
   * Replace belongs to the source editor alone, so it opens the same bar with
   * its replace row expanded, and it is refused anywhere else: a rendered
   * document has no draft to rewrite.
   */
  function openReaderFind(withReplace: boolean): void {
    findNavState.closeFileDocumentFind()
    if (documentFindAvailable && !editorFindAvailable) {
      findNavState.openFileDocumentFind()
      return
    }
    editorFindWithReplace = withReplace
    findNavState.openEditorFind()
  }

  /**
   * A find belongs to the surface that was searched, so a view change puts it
   * away instead of leaving a bar aimed at text that is no longer on screen.
   */
  function changeView(view: ProjectFileView): void {
    if (!activeTab) return
    findNavState.closeFileDocumentFind()
    findNavState.closeEditorFind()
    projectFilesWorkspace.setView(projectId, activeTab.id, view)
  }

  /**
   * Clear the one-shot requests and matches the panel hands its editor when the
   * file on screen changes.
   *
   * This panel no longer remounts on a sidebar file-tab switch (see the files
   * panel key in `WorkspaceContextPanelContent`), so what its remount used to
   * reset has to be reset here. A `replaceRequest` or an undo/redo request left
   * over from the previous file would be applied by the editor that mounts for
   * the new one, because that editor's handled-nonce counters start at zero.
   *
   * The active file tab is the trigger and not the sidebar tab: a swap that
   * keeps the sidebar tab (the full screen "save and continue" hand-over rewrites
   * its file mapping in place, and `swapFileSilent` retitles the tab) still
   * changes the file the editor is showing.
   *
   * `$effect.pre` and not `$effect`: it has to land before the DOM updates in
   * the new editor. Svelte flushes every `$effect.pre` before any `$effect`, and
   * `ProjectTextEditor` reads these requests inside effects.
   *
   * Writing these back to their empty state is the point, so this is a reset and
   * not a value kept in step: the requests are raised by user actions, and an
   * identity check keeps it from firing on anything but the file changing.
   */
  let requestTabId: string | null = null
  $effect.pre(() => {
    const nextTabId = activeTab?.id ?? null
    if (nextTabId === requestTabId) return
    requestTabId = nextTabId
    editRequest = null
    editorFind.reset()
    goToLineOpen = false
  })

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

  let fullscreenFileLabels = $derived(
    fileTabLabels(fullscreenFileTabs.flatMap((tab) => (tab.path ? [tab.path] : [])))
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
        'absolute left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 border border-warning/40 bg-warning/10 px-3 py-1.5 shadow-lg',
        positionClass
      ]}
      role="alert"
    >
      <CioAttention size={13} class="shrink-0 text-warning" />
      <span class="text-[0.625rem] font-medium text-warning">Viewing an older version</span>
      <button
        type="button"
        class="bg-warning/20 px-2 py-0.5 text-[0.625rem] font-semibold text-warning transition-colors hover:bg-warning/30"
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
      data-find-surface={documentFindAvailable ? 'document' : 'editor'}
      bind:this={sidebarEditorRegion}
    >
      <div class="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <div
          class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-[0.625rem] text-muted"
          aria-label={activeTab ? `Path ${activeTab.path}` : 'No file selected'}
        >
          <button
            type="button"
            class="shrink-0"
            title={assistantRoot ? projectName : 'Show project root'}
            onclick={() => revealBreadcrumb(-1)}
          >
            {#if projectIconUrl}
              <img src={projectIconUrl} alt={projectName} class="h-4 w-4 shrink-0" />
            {:else if assistantRoot}
              <AssistantDefaultIcon
                size={14}
                class="shrink-0"
                style="color: {projectAccentColor ?? 'var(--color-primary)'}"
              />
            {:else}
              <span class="font-medium hover:text-foreground">{projectLabel}</span>
            {/if}
          </button>
          {#each breadcrumbParts as part, index (`${part}:${index}`)}
            <CioForward size={10} class="shrink-0 text-dimmed" />
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
            'flex h-7 w-7 shrink-0 items-center justify-center transition-colors',
            projectState.explorerVisible
              ? 'bg-overlay text-primary'
              : 'text-dimmed hover:bg-elevated hover:text-foreground'
          ]}
          aria-label={projectState.explorerVisible ? 'Hide file explorer' : 'Show file explorer'}
          aria-pressed={projectState.explorerVisible}
          title={projectState.explorerVisible ? 'Hide file explorer' : 'Show file explorer'}
          onclick={() => projectFilesWorkspace.toggleExplorer(projectId)}
        >
          <CioFiles size={15} />
        </button>
      </div>

      {#if activeTab}
        <ProjectFilesPanelToolbar
          ideStatusPortal={sidebarIdeStatusPortal}
          ideModeEnabled={projectState.ideModeEnabled}
          ideModeDisabled={ovenFile}
          onIdeModeChange={(enabled) => (projectState.ideModeEnabled = enabled)}
          {activeTab}
          {checkpointDiff}
          {diffStats}
          {previewKindLabel}
          showPreviewToggle={hasAnyPreview(previewFlags)}
          {showAnnotateToggle}
          {annotateDisabled}
          readAloud={documentReadAloud}
          {deletedAtCheckpoint}
          showUndoRedo={canUndoRedo}
          canUndo={sidebarCanUndo}
          canRedo={sidebarCanRedo}
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
          saveLabel={activeFileInMergeEditor
            ? conflictSaveText
            : `Save file (${keymapState.labelFor('files-save')})`}
          saveTitle={activeFileInMergeEditor ? conflictSaveTitle : undefined}
          fullscreen={false}
          findDisabled={!editorFindAvailable && !documentFindAvailable}
          replaceDisabled={!editorFindAvailable}
          onSearch={() => openReaderFind(false)}
          onSearchReplace={() => openReaderFind(true)}
          onSetView={changeView}
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

      {#if findNavState.fileDocumentFindOpen && documentFindAvailable && !fullscreenOpen}
        <FindInSurface
          container={activeEditorRegion}
          focusTrigger={findNavState.fileDocumentFindFocusTrigger}
          label="Find in document"
          placeholder="Find in document…"
          onClose={() => findNavState.closeFileDocumentFind()}
        />
      {/if}

      {#if findNavState.editorFindOpen && !fullscreenOpen && activeTab && editorFindAvailable}
        <FindInBar
          query={editorFind.value}
          matches={editorFind.total}
          activeIndex={editorFind.active}
          label="Find in file"
          floating
          focusTrigger={findNavState.editorFindFocusTrigger}
          onQueryChange={(query) => editorFind.setQuery(query)}
          enableReplace={!deletedAtCheckpoint}
          initialReplaceOpen={editorFindWithReplace}
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

      {#if readAlongSegments}
        <ProjectFilesPanelReadAlong
          segments={readAlongSegments}
          activeIndex={speechController.visibleSegmentIndex}
          spokenProgress={speechController.activeSegmentProgress}
        />
      {:else if !activeTab}
        <div class="flex min-h-0 flex-1 items-center justify-center px-6">
          <div class="text-center">
            <CioFolderOpen size={24} class="mx-auto mb-2 text-dimmed" />
            <p class="text-xs font-medium text-foreground">Open file</p>
            <p class="mt-1 text-[0.625rem] text-dimmed">Select a file from the workspace tree.</p>
            {#if !projectState.explorerVisible}
              <button
                type="button"
                class="mt-3 border border-border bg-elevated px-3 py-1.5 text-[0.625rem] font-medium text-foreground hover:bg-overlay"
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
              class="border border-border bg-elevated px-3 py-1.5 text-[0.625rem] font-medium text-muted hover:bg-overlay hover:text-foreground"
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
          <CioSpinner size={13} class="animate-spin" />
          Loading diff
        </div>
      {:else if activeTab.view === 'diff' && checkpointDiff}
        {#if diffComputation.error}
          <p class="px-3 py-4 text-xs text-muted" role="note">{diffComputation.error}</p>
        {:else if diffStats || checkpointDiff.binary}
          <FileDiffView diff={checkpointDiff} preparedDetails={diffStats} />
        {:else}
          <p class="px-3 py-4 text-xs text-muted" role="status">Computing diff…</p>
        {/if}
      {:else if activeTab.view === 'annotate' && showAnnotateToggle && activeThreadId}
        <ProjectFilesPanelAnnotator
          {projectId}
          threadId={activeThreadId}
          path={activeTab.path}
          content={visibleContent}
        />
      {:else if activeTab.view === 'preview' && hasAnyPreview(previewFlags)}
        <ProjectFilesPanelPreviewPane
          path={activeTab.path}
          flags={previewFlags}
          {visibleContent}
          {htmlPreviewSrcdoc}
          {previewUrl}
          documentLoading={docPreview.loading}
          documentHtml={docPreview.html}
          documentFailed={docPreview.failed}
          documentError={docPreview.error}
          showDocumentError
        />
      {:else if projectState.loadingPaths[activeTab.path] && !activeSession && !deletedAtCheckpoint}
        <div class="flex flex-1 items-center justify-center gap-2 text-[0.6875rem] text-dimmed">
          <CioSpinner size={13} class="animate-spin" />
          Loading file
        </div>
      {:else if activeTab && !activeSession && !deletedAtCheckpoint}
        {#if image}
          <FileImagePreview src={previewUrl} alt={activeTab.path} />
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
              <p class="mt-1 text-[0.625rem] text-dimmed">
                {ovenFile
                  ? 'It lives on the Oven. Save a copy to open it here.'
                  : 'You can open it with your editor.'}
              </p>
            </div>
            <button
              type="button"
              class="border border-border bg-elevated px-3 py-1.5 text-[0.625rem] font-medium text-muted hover:text-foreground"
              onclick={ovenFile ? saveSelectedAs : openSelectedInEditor}
            >
              {ovenFile ? 'Save a copy…' : 'Open in editor'}
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
            ideStatusPortal={sidebarIdeStatusPortal}
            {projectName}
            {projectId}
            scopeBucketId={workspaceState.activeScopeBucketIdFor(projectId)}
            threadId={mountThreadId ?? undefined}
            ideEnabled={projectState.ideModeEnabled &&
              !deletedAtCheckpoint &&
              activeTab.origin === 'working' &&
              !ovenFile}
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
            focusCharacter={activeTab.focusCharacter}
            focusLine={activeTab.focusLine}
            focusLineRequest={activeTab.focusLineRequest}
            onFindMatches={fullscreenOpen ? undefined : (matches) => editorFind.setMatches(matches)}
            onReplaceDone={(replaced) => editorFind.handleReplaceDone(replaced)}
            onHistoryChange={(history) => {
              if (!activeTab) return
              sidebarHistory = { tabId: activeTab.id, ...history }
            }}
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
          {projectLabel}
          {projectIconUrl}
          {assistantRoot}
          {projectAccentColor}
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
  onEscapeKeydown={(event) => {
    // Escape dismisses the search first. While focus sits in the find bar the bar
    // claims the press itself, but a press anywhere else in the reader still has
    // to reach it, and the reader is what would otherwise be thrown away with
    // the search still open.
    if (findNavState.editorFindOpen) {
      event.preventDefault()
      editorFind.close()
      return
    }
    if (findNavState.fileDocumentFindOpen) {
      event.preventDefault()
      findNavState.closeFileDocumentFind()
    }
  }}
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
              'group flex min-w-0 max-w-52 shrink-0 items-center',
              retainedContextTab?.id === fileTab.id
                ? 'bg-elevated text-foreground'
                : 'text-muted hover:bg-elevated hover:text-foreground'
            ]}
            role="tab"
            aria-selected={retainedContextTab?.id === fileTab.id}
          >
            <button
              type="button"
              data-active={retainedContextTab?.id === fileTab.id ? 'true' : undefined}
              class="flex min-w-0 items-center gap-1.5 py-1.5 pl-2 text-left"
              title={fileTab.path ?? fileTab.title}
              onclick={() => focusFullscreenFileTab(fileTab.id)}
            >
              <FileTypeIcon path={fileTab.path ?? fileTab.title} size={12} />
              <span
                class={[
                  'max-w-40 truncate text-[0.6875rem] font-medium',
                  fileTab.preview ? 'italic' : ''
                ]}
                >{fileTab.path
                  ? (fullscreenFileLabels.get(fileTab.path) ?? fileTab.title)
                  : fileTab.title}</span
              >
              {#if fileDirty}
                <span class="h-1.5 w-1.5 shrink-0 bg-accent" title="Unsaved changes"></span>
              {/if}
            </button>
            {#if fileTab.fileTabId}
              <button
                type="button"
                class="mr-1 flex h-6 w-6 shrink-0 items-center justify-center text-dimmed opacity-70 transition-colors hover:bg-raised hover:text-foreground group-hover:opacity-100"
                aria-label={`Close ${fileTab.title}`}
                title={`Close ${fileTab.title}`}
                onclick={() =>
                  fileTab.fileTabId && closeFullscreenFileTab(fileTab.id, fileTab.fileTabId)}
              >
                <CioClose size={11} />
              </button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
    {#if showSaveButton}
      <button
        type="button"
        class="titlebar-no-drag flex h-7 items-center gap-1 bg-primary px-2 text-[0.625rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-30"
        disabled={deletedAtCheckpoint ||
          (activeFileInMergeEditor ? !conflictSaveReady : !dirty) ||
          (activeFileInMergeEditor ? conflictStatus.saving : activeSession?.saving)}
        title={activeFileInMergeEditor
          ? conflictSaveTitle
          : `Save file (${keymapState.labelFor('files-save')})`}
        onclick={runPanelSave}
      >
        {#if activeFileInMergeEditor ? conflictStatus.saving : activeSession?.saving}
          <CioSpinner size={11} class="animate-spin" />
        {:else}
          <CioSave size={11} />
        {/if}
        {#if activeFileInMergeEditor}
          {conflictSaveText}
        {:else}Save{/if}
      </button>
    {/if}
    {#if fullscreenChatTabs.length > 0}
      <button
        type="button"
        class={[
          'titlebar-no-drag ml-1 flex h-7 w-7 items-center justify-center transition-colors',
          fullscreenChatOpen
            ? 'bg-overlay text-primary'
            : 'text-dimmed hover:bg-elevated hover:text-foreground'
        ]}
        aria-label={fullscreenChatTitle}
        title={fullscreenChatTitle}
        aria-pressed={fullscreenChatOpen}
        onclick={toggleFullscreenChat}
      >
        <CioTemporaryChat size={15} />
      </button>
    {/if}
    <button
      type="button"
      class={[
        'titlebar-no-drag ml-1 flex h-7 w-7 items-center justify-center transition-colors',
        fullscreenExplorerOpen && !fullscreenChatOpen
          ? 'bg-overlay text-primary'
          : 'text-dimmed hover:bg-elevated hover:text-foreground'
      ]}
      aria-label={fullscreenExplorerOpen && !fullscreenChatOpen
        ? 'Hide file tree'
        : 'Show file tree'}
      aria-pressed={fullscreenExplorerOpen && !fullscreenChatOpen}
      title={fullscreenExplorerOpen && !fullscreenChatOpen ? 'Hide file tree' : 'Show file tree'}
      onclick={toggleFullscreenExplorer}
    >
      <CioFiles size={15} />
    </button>
    <button
      type="button"
      class="titlebar-no-drag ml-1 flex h-7 w-7 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      aria-label="Minimize fullscreen file viewer"
      title="Minimize fullscreen file viewer"
      onclick={closeFullscreen}
    >
      <CioMinimize size={14} />
    </button>
  </div>
  <div class="relative flex min-h-0 min-w-0 flex-1">
    <div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {#if activeTab && !activeFileInMergeEditor}
        <ProjectFilesPanelToolbar
          ideModeEnabled={projectState.ideModeEnabled}
          ideModeDisabled={ovenFile}
          onIdeModeChange={(enabled) => (projectState.ideModeEnabled = enabled)}
          {activeTab}
          {checkpointDiff}
          {diffStats}
          {previewKindLabel}
          showPreviewToggle={hasAnyPreview(previewFlags)}
          {showAnnotateToggle}
          {annotateDisabled}
          readAloud={documentReadAloud}
          {deletedAtCheckpoint}
          showUndoRedo={canUndoRedo}
          canUndo={fullscreenCanUndo}
          canRedo={fullscreenCanRedo}
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
          ideStatusPortal={fullscreenIdeStatusPortal}
          findDisabled={!editorFindAvailable && !documentFindAvailable}
          replaceDisabled={!editorFindAvailable}
          onSearch={() => openReaderFind(false)}
          onSearchReplace={() => openReaderFind(true)}
          onSetView={changeView}
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
        data-find-surface={documentFindAvailable ? 'document' : 'editor'}
        bind:this={fullscreenEditorRegion}
      >
        {#if findNavState.fileDocumentFindOpen && documentFindAvailable && fullscreenOpen}
          <FindInSurface
            container={activeEditorRegion}
            focusTrigger={findNavState.fileDocumentFindFocusTrigger}
            label="Find in document"
            placeholder="Find in document…"
            onClose={() => findNavState.closeFileDocumentFind()}
          />
        {/if}
        {#if findNavState.editorFindOpen && fullscreenOpen && activeTab && editorFindAvailable}
          <FindInBar
            query={editorFind.value}
            matches={editorFind.total}
            activeIndex={editorFind.active}
            label="Find in file"
            floating
            focusTrigger={findNavState.editorFindFocusTrigger}
            onQueryChange={(query) => editorFind.setQuery(query)}
            enableReplace={!deletedAtCheckpoint}
            initialReplaceOpen={editorFindWithReplace}
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
        {#if readAlongSegments}
          <ProjectFilesPanelReadAlong
            segments={readAlongSegments}
            activeIndex={speechController.visibleSegmentIndex}
            spokenProgress={speechController.activeSegmentProgress}
          />
        {:else if activeTab?.view === 'diff' && checkpointDiff}
          {#if diffComputation.error}
            <p class="px-3 py-4 text-xs text-muted" role="note">{diffComputation.error}</p>
          {:else if diffStats || checkpointDiff.binary}
            <FileDiffView diff={checkpointDiff} preparedDetails={diffStats} />
          {:else}
            <p class="px-3 py-4 text-xs text-muted" role="status">Computing diff…</p>
          {/if}
        {:else if activeTab?.view === 'annotate' && showAnnotateToggle && activeThreadId}
          <ProjectFilesPanelAnnotator
            {projectId}
            threadId={activeThreadId}
            path={activeTab.path}
            content={visibleContent}
            fullscreen
            onOpenTemporaryChat={() => (fullscreenChatEnabled = true)}
            onExitFullscreen={closeFullscreen}
          />
        {:else if activeTab?.view === 'preview' && hasAnyPreview(previewFlags)}
          <ProjectFilesPanelPreviewPane
            path={activeTab.path}
            flags={previewFlags}
            {visibleContent}
            {htmlPreviewSrcdoc}
            {previewUrl}
            documentLoading={docPreview.loading}
            documentHtml={docPreview.html}
            documentFailed={docPreview.failed}
            documentError={docPreview.error}
            showDocumentError={false}
          />
        {:else if activeTab && (image || video || audio || activeSession || deletedAtCheckpoint)}
          {#if image && (renderOnlyFile || activeTab.view !== 'source')}
            <FileImagePreview src={previewUrl} alt={activeTab.path} />
          {:else if (video || audio) && (renderOnlyFile || activeTab.view !== 'source')}
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
          {:else if projectState.loadingPaths[activeTab.path] && !activeSession}
            <div
              class="flex flex-1 items-center justify-center gap-2 text-[0.6875rem] text-dimmed"
              role="status"
            >
              <CioSpinner size={13} class="animate-spin" />
              Loading file
            </div>
          {:else}
            {#key activeTab.id}
              <ProjectTextEditor
                {projectName}
                ideStatusPortal={fullscreenIdeStatusPortal}
                {projectId}
                scopeBucketId={workspaceState.activeScopeBucketIdFor(projectId)}
                threadId={mountThreadId ?? undefined}
                ideEnabled={projectState.ideModeEnabled &&
                  !deletedAtCheckpoint &&
                  activeTab.origin === 'working' &&
                  !ovenFile}
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
                focusCharacter={activeTab.focusCharacter}
                focusLine={activeTab.focusLine}
                focusLineRequest={activeTab.focusLineRequest}
                onFindMatches={(matches) => editorFind.setMatches(matches)}
                onReplaceDone={(replaced) => editorFind.handleReplaceDone(replaced)}
                onHistoryChange={(history) => {
                  if (!activeTab) return
                  fullscreenHistory = { tabId: activeTab.id, ...history }
                }}
                onInput={handleEditorInput}
              />
            {/key}
          {/if}
        {/if}
      </div>
    </div>
    {#if fullscreenChatOpen}
      <div
        class="h-full min-h-0 shrink-0 border-l border-border"
        style:width="{contextSidebarState.width}px"
        style:max-width="60%"
        {@attach fullscreenFileChatSlot}
      ></div>
    {:else if fullscreenExplorerOpen && activeTab}
      <div
        class="min-h-0"
        transition:slide={{ axis: 'x', duration: motionDuration(180), easing: cubicOut }}
      >
        <ProjectFileExplorer
          {projectId}
          {projectName}
          {projectLabel}
          {projectIconUrl}
          {assistantRoot}
          {projectAccentColor}
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
