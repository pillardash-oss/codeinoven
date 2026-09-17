import { toast } from 'svelte-sonner'
import { invoke, subscribe } from '$lib/ipc.svelte'
import {
  captureError,
  errorHeadline,
  showToastError,
  showToastWarning
} from '$lib/stores/app-errors.svelte'
import { clearDraftLabelCookie } from '$lib/stores/draft-label'
import { notificationPanelState } from '$lib/stores/notification-panel.svelte'
import { pipState } from '$lib/stores/pip.svelte'
import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
import { scopeConfirmations } from '$lib/stores/scope-confirmations.svelte'
import { scopeJobs } from '$lib/stores/scope-jobs.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { standaloneFiles } from '$lib/stores/standalone-files.svelte'
import { temporaryChatUnread } from '$lib/stores/temporary-chat-unread.svelte'
import { threadNotesState } from '$lib/stores/thread-notes.svelte'
import { updaterState } from '$lib/stores/updater.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { DEFAULT_THREAD_TITLE, type OpenedPath, type Project, type Thread } from '$shared/types'
import type {
  AgentNotificationPayload,
  CloseConfirmationPayload,
  ThreadClickedPayload
} from '$shared/ipc-contract'

export interface AppIpcSubscriptionDeps {
  openThreadFromNotification: (
    thread: Thread,
    project: Project | null,
    temporaryChatId?: string
  ) => Promise<void>
  setCloseConfirmation: (payload: CloseConfirmationPayload | null) => void
  confirmForceClose: () => Promise<void>
  settleCloseConfirmationThread: (thread: Thread) => void
  handleCloseShortcut: () => void
  handleNewTerminalShortcut: () => void
  goBack: () => Promise<void>
  goForward: () => Promise<void>
  handleOpenedPaths: (paths: OpenedPath[]) => Promise<void>
}

async function openNotificationThread(
  payload: ThreadClickedPayload,
  deps: AppIpcSubscriptionDeps
): Promise<void> {
  const { projectId, threadId } = payload
  notificationPanelState.dismissForThread(projectId, threadId)
  try {
    const [project, thread] = await Promise.all([
      invoke('project:get', projectId),
      invoke('thread:get', projectId, threadId)
    ])
    if (!project || !thread) return
    await deps.openThreadFromNotification(thread, project, payload.temporaryChatId)
  } catch {
    // The project or thread may have been deleted before the notification was clicked.
  }
}

function showAgentNotification(
  payload: AgentNotificationPayload,
  deps: AppIpcSubscriptionDeps
): void {
  const onSelectedThread =
    workspaceState.selectedThread?.id === payload.threadId &&
    workspaceState.selectedThread?.projectId === payload.projectId
  if (
    !onSelectedThread &&
    payload.source === 'temporary-chat' &&
    payload.kind === 'chat-completed' &&
    payload.temporaryChatId
  ) {
    // The side chat finished while the user is away from its thread: flag
    // the parent thread's row so the response is discoverable from the
    // thread list. Cleared when the side-chat panel is focused.
    temporaryChatUnread.markUnread(payload.projectId, payload.threadId, payload.temporaryChatId)
  }
  if (onSelectedThread) {
    return
  }
  notificationPanelState.add(payload)
  const id = payload.id
  const options = {
    id,
    description: payload.body,
    duration: 8_000,
    onDismiss: () => notificationPanelState.dismiss(id),
    action: {
      label: 'Open thread',
      onClick: (): void => {
        void openNotificationThread(payload, deps)
      }
    }
  }

  const chatResponseToastStyle =
    '--success-bg: color-mix(in srgb, var(--color-chat-success) 12%, var(--color-surface));' +
    ' --success-border: var(--color-chat-success);' +
    ' --success-text: var(--color-chat-success);'

  if (payload.kind === 'completed') {
    toast.success(payload.title, options)
  } else if (payload.kind === 'chat-completed') {
    toast.success(payload.title, { ...options, style: chatResponseToastStyle })
  } else if (payload.kind === 'attention') {
    // A thread waiting for input is a status notice owned by the panel's
    // Attention tab, never an app error/warning entry.
    showToastWarning(payload.title, options)
  } else if (payload.kind === 'spec') {
    toast.info(payload.title, options)
  } else {
    // Record the real failure (message plus raw detail/stack) for the app
    // errors panel, then toast the generic title directly so the wrapper does
    // not re-capture a details-less duplicate entry.
    const detail = payload.errorDetail?.trim()
    captureError(detail ? errorHeadline(detail) : payload.title, {
      ...(detail ? { details: detail } : {}),
      thread: { projectId: payload.projectId, threadId: payload.threadId }
    })
    showToastError(payload.title, options)
  }
}

/**
 * Wire every renderer-side IPC push subscription App owns and return the
 * cleanup that unsubscribes them all.
 */
export function installAppIpcSubscriptions(deps: AppIpcSubscriptionDeps): () => void {
  const unsubscribeClick = subscribe('notification:threadClicked', (payload) => {
    void openNotificationThread(payload, deps)
  })
  const unsubscribeShow = subscribe('notification:show', (payload) =>
    showAgentNotification(payload, deps)
  )
  const unsubscribeConfirmClose = subscribe('window:confirmClose', (payload) => {
    // The renderer owns the unsaved-file editor state, so it computes the
    // pending files here. With nothing pending the close proceeds right away.
    const files = [...projectFilesWorkspace.getUnsavedFiles(), ...standaloneFiles.getUnsavedFiles()]
    if (payload.projects.length === 0 && files.length === 0) {
      void deps.confirmForceClose()
      return
    }
    deps.setCloseConfirmation({ projects: payload.projects, files })
  })
  const unsubscribeThreadUpdated = subscribe('thread:updated', (...args: unknown[]) => {
    const thread = args[0] as Thread
    // Once a real title exists the draft-derived label is no longer needed.
    if (thread.title !== DEFAULT_THREAD_TITLE) {
      clearDraftLabelCookie(thread.id)
    }
    scopeState.updateThread(thread)
    if (workspaceState.selectedThread?.id === thread.id) {
      workspaceState.updateThread(thread)
    }
    if (thread.read) {
      notificationPanelState.dismissForThread(thread.projectId, thread.id)
    }
    deps.settleCloseConfirmationThread(thread)
  })
  const unsubscribeThreadDeleted = subscribe('thread:deleted', (projectId, threadId) => {
    scopeState.removeThread(threadId)
    notificationPanelState.dismissForThread(projectId, threadId)
    temporaryChatUnread.clearThread(projectId, threadId)
    if (workspaceState.selectedThread?.id === threadId) workspaceState.clearThread()
  })
  // An agent created, renamed, archived, deleted, synced or merged a scope:
  // reload the board it changed so the user sees the worktree it made instead
  // of a stale snapshot.
  const unsubscribeScopeBoardChanged = subscribe('scope:boardChanged', (event) => {
    void scopeState.handleBoardChangedEvent(event)
  })
  // A destructive scope action an agent asked for waits on this dialog; its
  // answer is what releases the agent's parked tool call.
  const unsubscribeScopeConfirmation = subscribe('scope:agentConfirmation', (request) => {
    scopeConfirmations.enqueue(request)
  })
  // Listen from app start (not from the first local job): an agent-run
  // worktree has no renderer-owned job until its first progress event.
  scopeJobs.listen()
  const unsubscribeCloseShortcut = subscribe('window:closeShortcut', () => {
    deps.handleCloseShortcut()
  })
  const unsubscribeNewTerminalShortcut = subscribe('window:newTerminalShortcut', () => {
    deps.handleNewTerminalShortcut()
  })
  const unsubscribeHistoryBack = subscribe('window:historyBack', () => {
    void deps.goBack()
  })
  const unsubscribeHistoryForward = subscribe('window:historyForward', () => {
    void deps.goForward()
  })
  // OS hand-offs that arrive after mount; the queue drain below covers the
  // paths that were already waiting when the renderer started.
  const unsubscribeOpenedPaths = subscribe('openWith:paths', (paths: OpenedPath[]) => {
    void deps.handleOpenedPaths(paths)
  })
  void invoke('openWith:consumePending')
    .then((paths: OpenedPath[]) => deps.handleOpenedPaths(paths))
    .catch(() => undefined)
  updaterState.init()
  // The PiP overlay subscribes to `computerUse:pipFrame`/`pipState` events;
  // initialise the store here so the overlay's dynamic import can be gated on
  // `pipState.active` without ever missing a frame.
  pipState.init()
  // Load which threads carry a user note so sidebar rows and the right-dock
  // indicator can react; the store keeps itself in sync via `note:changed`.
  threadNotesState.init()
  return () => {
    unsubscribeClick()
    unsubscribeShow()
    unsubscribeConfirmClose()
    unsubscribeThreadUpdated()
    unsubscribeThreadDeleted()
    unsubscribeScopeBoardChanged()
    unsubscribeScopeConfirmation()
    unsubscribeCloseShortcut()
    unsubscribeNewTerminalShortcut()
    unsubscribeHistoryBack()
    unsubscribeHistoryForward()
    unsubscribeOpenedPaths()
    updaterState.destroy()
  }
}
