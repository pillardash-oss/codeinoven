import { BrowserWindow } from 'electron'
import type { AgentEvent, RemoteAgentEventPayload, Thread } from '../../lib/types'
import type { AuthoredWorkKind } from '../../lib/ipc/design'
import type { NotificationService } from '../notifications/notification-service'
import type { PowerWakeService } from '../system/power-wake-service'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { broadcastAppToast } from '../ipc/app-toast'
import { instanceRegistry } from '../system/instance-registry'
import { instanceEventBus } from '../system/instance-event-bus'

type CheckpointUpdatedEvent = Extract<AgentEvent, { type: 'checkpoint.updated' }>

/**
 * The service that owns the menu bar icon. Injected as a narrow port rather
 * than imported, because this module is loaded by the chat engine and must not
 * pull in the whole background lifecycle: every persisted thread update is
 * exactly the moment the icon's error state and its working-thread figure can
 * have changed.
 */
interface BackgroundTrayPort {
  /** Coalesced, so calling it on every thread update is cheap. */
  requestTrayRefresh: () => void
}

interface ThreadCorpusListener {
  updated(thread: Thread): void
  deleted(thread: Pick<Thread, 'projectId' | 'id'>): void
  draftUpdated(projectId: string, threadId: string, drafting: boolean): void
}
const corpusListeners = new Set<ThreadCorpusListener>()

export function subscribeThreadCorpus(listener: ThreadCorpusListener): () => void {
  corpusListeners.add(listener)
  return () => {
    corpusListeners.delete(listener)
  }
}

let _notificationService: NotificationService | null = null
let _powerWakeService: PowerWakeService | null = null
let _backgroundTray: BackgroundTrayPort | null = null

export function setNotificationService(service: NotificationService | null): void {
  _notificationService = service
}

export function setPowerWakeService(service: PowerWakeService | null): void {
  _powerWakeService = service
}

export function setBackgroundTray(port: BackgroundTrayPort | null): void {
  _backgroundTray = port
}

export function markNotificationAborting(projectId: string, threadId: string): void {
  _notificationService?.markAborting(projectId, threadId)
}

export function clearNotificationAborting(projectId: string, threadId: string): void {
  _notificationService?.clearAborting(projectId, threadId)
}

/** Keep provider-owned retry windows aligned with the power-wake policy. */
export function updateRetryWakeWindow(sessionId: string, retryAt: number | null): void {
  _powerWakeService?.onRetryWindowChanged(sessionId, retryAt)
}

/** Dismiss delivered OS notifications + badge entry for a thread. */
export function dismissThreadNotifications(projectId: string, threadId: string): void {
  _notificationService?.dismissForThread(projectId, threadId)
}

/**
 * Push a thread snapshot to every renderer window so live UI (sidebar
 * indicators, headers) can react to status/read changes without polling,
 * then fire an OS notification if the app is backgrounded.
 */
export function broadcastThreadUpdate(thread: Thread): void {
  for (const listener of corpusListeners) listener.updated(thread)
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'thread:updated', thread)
  }
  if (thread.read) {
    dismissThreadNotifications(thread.projectId, thread.id)
  }
  _powerWakeService?.onThreadUpdate(thread)
  // The menu bar mirrors the thread's error card and carries the number of
  // working threads, so every persisted status or read change is a moment the
  // icon's state can have changed.
  _backgroundTray?.requestTrayRefresh()
  void _notificationService?.notify(thread)
  // The row is shared with every other instance, and none of them receives this
  // fan-out, so the change is also announced for a sibling to re-read.
  instanceRegistry.publishThreadChanged(thread.projectId, thread.id, 'row')
}

/**
 * Tell every renderer window that this thread's mirrored conversation changed.
 *
 * The mirror over the same database is what a sibling instance writes into, so
 * its rows are already there: a window only has to re-read the tail it shows.
 * Deliberately not a `thread:updated` push, which would also re-run the whole
 * row reconcile (working state, notices, draft label) for a change that never
 * touched the row.
 */
export function broadcastThreadMessagesChanged(projectId: string, threadId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'thread:messagesChanged', projectId, threadId)
  }
}

/**
 * Push a thread snapshot another instance settled to every renderer window.
 *
 * Deliberately narrower than `broadcastThreadUpdate`: the change was produced by
 * the sibling that owns the run, and that process already notified the user,
 * rang its OS card, badged the icon and updated the power policy for it. Doing
 * any of that again here would tell the user twice about one finished run. What
 * this window owes its own renderer is the corrected row, so its sidebar, status
 * counts and badges stop showing work that is no longer happening.
 */
export function broadcastCrossInstanceThreadUpdate(thread: Thread): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'thread:updated', thread)
  }
  // The menu bar mirrors the thread states of the shared database, so a row
  // corrected from a sibling's write is a moment its own state can have changed.
  _backgroundTray?.requestTrayRefresh()
}

/**
 * Announce to every other instance that this process wrote this thread's mirror.
 *
 * Wired into the transcript store once at boot, so every durable message write
 * says so whichever flow made it. The announcement carries no messages at all:
 * a sibling re-reads the shared rows, which is why a coalesced batch is enough
 * and why a lost one costs only freshness.
 */
export function publishThreadMessagesChanged(projectId: string, threadId: string): void {
  instanceRegistry.publishThreadChanged(projectId, threadId, 'messages')
}

/**
 * Push just a thread's draft state (drafting flag + committed draft content)
 * to every renderer window, and nowhere else.
 *
 * Deliberately lighter than `broadcastThreadUpdate`: draft commits happen while
 * the user is actively typing, and the full thread broadcast forces ThreadView's
 * message reconcile to reload and re-merge the whole transcript, which would
 * freeze the composer mid-keystroke on large conversations. Only surfaces that
 * render draft state need this event.
 *
 * Split from the announcing variant below because a sibling's draft, applied
 * here, must never be announced back: two instances would keep re-publishing the
 * same draft at each other.
 */
export function sendThreadDraftUpdated(
  projectId: string,
  threadId: string,
  drafting: boolean,
  draftJson: string | null
): void {
  for (const listener of corpusListeners) listener.draftUpdated(projectId, threadId, drafting)
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'thread:draftUpdated', projectId, threadId, drafting, draftJson)
  }
}

/**
 * Push just a thread's draft state to every renderer window, and tell siblings
 * the shared draft slot moved.
 *
 * A draft is one value on the shared row rather than a per-window buffer, so a
 * sibling mirroring it needs to know about a commit and, above all, about a
 * clear: a message sent here must not leave its words standing as a draft in
 * every other instance.
 */
export function broadcastThreadDraftUpdated(
  projectId: string,
  threadId: string,
  drafting: boolean,
  draftJson: string | null
): void {
  sendThreadDraftUpdated(projectId, threadId, drafting, draftJson)
  instanceRegistry.publishThreadChanged(projectId, threadId, 'draft')
}

/**
 * Push just a settled git branch to every renderer window. Deliberately
 * lighter than `broadcastThreadUpdate`: branch settlement is cosmetic and can
 * land at any time after a thread is opened (creation-time detection, or a
 * lazy heal on read), including while the user is actively typing. Routing it
 * through the full thread broadcast would force every `thread:updated`
 * subscriber   including ThreadView's message reconcile, which reloads and
 * re-merges the whole transcript   to run at that moment, freezing input on
 * large conversations for a purely cosmetic field.
 */
export function broadcastThreadBranchUpdated(thread: Thread): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(
      win.webContents,
      'thread:branchUpdated',
      thread.projectId,
      thread.id,
      thread.branch
    )
  }
}

/**
 * Push just a thread's authored-work markers to every renderer window.
 *
 * Deliberately lighter than `broadcastThreadUpdate`, for the same reason as the
 * branch update above: the markers land the moment a design or video preview
 * records the session, which is mid-turn, and routing it through the full
 * `thread:updated` fan-out would force ThreadView's message reconcile to reload
 * and re-merge the whole transcript at that moment. Only surfaces that draw the
 * markers need to react, and they patch the fields in place.
 *
 * Both facts travel: `kind` is the session the thread is in now and `kinds` is
 * every session it has entered, which is what the row draws one marker per.
 */
export function broadcastThreadAuthoredWorkUpdated(
  projectId: string,
  threadId: string,
  kind: AuthoredWorkKind,
  kinds: readonly AuthoredWorkKind[]
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'thread:authoredWorkUpdated', projectId, threadId, kind, [
      ...kinds
    ])
  }
}

/** Push permanent task deletion so every renderer view drops it. */
export function broadcastThreadDeleted(thread: Pick<Thread, 'projectId' | 'id'>): void {
  broadcastCrossInstanceThreadDeleted(thread)
  // Nothing in this instance can re-read a row that is gone, so the deletion
  // itself is what siblings are told: without it a window keeps a row for a
  // thread that no longer exists.
  instanceRegistry.publishThreadChanged(thread.projectId, thread.id, 'deleted')
}

/**
 * Drop a thread from this instance's renderers after another instance deleted it.
 *
 * This is the local half of `broadcastThreadDeleted`, deliberately without its
 * cross-instance announcement: re-announcing a sibling's deletion would send the
 * two instances to each other forever.
 */
export function broadcastCrossInstanceThreadDeleted(
  thread: Pick<Thread, 'projectId' | 'id'>
): void {
  for (const listener of corpusListeners) listener.deleted(thread)
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'thread:deleted', thread.projectId, thread.id)
  }
  dismissThreadNotifications(thread.projectId, thread.id)
}

/** Surface a failed optimistic thread operation without making its IPC acknowledgement blocking. */
export function broadcastThreadOperationError(
  message: string,
  projectId: string,
  threadId: string
): void {
  broadcastAppToast({ message, type: 'error', projectId, threadId })
}

/** Keep note-presence indicators synchronized across renderer windows. */
export function broadcastNoteChanged(projectId: string, threadId: string, hasNote: boolean): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'note:changed', projectId, threadId, hasNote)
  }
}

/** Notify renderers that one task's live process list changed. */
export function broadcastAgentProcessesChanged(projectId: string, threadId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'agent:processesChanged', projectId, threadId)
  }
  broadcastTaskManagerProcessesChanged()
}

/** Notify renderers that the app-wide task manager process list changed. */
export function broadcastTaskManagerProcessesChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'taskManager:processesChanged')
  }
}

/** Deliver another process's persisted checkpoint invalidation locally. */
function deliverCrossInstanceCheckpointUpdated(event: CheckpointUpdatedEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'agent:event', event)
  }
}

instanceRegistry.onCheckpointUpdated(deliverCrossInstanceCheckpointUpdated)

/**
 * Deliver one stream event another instance produced for a shared thread.
 *
 * Deliberately its own channel rather than `agent:event`: the local channel is
 * wired to every action that follows a run this process owns (approving a
 * permission, answering a question, dispatching a queued message, refreshing a
 * git panel), and none of those can act on a harness process held by a sibling.
 * This channel is consumed by the transcript cache and the conversation surface,
 * which only render.
 */
function deliverCrossInstanceAgentEvent(payload: RemoteAgentEventPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    sendToRenderer(win.webContents, 'agent:remoteEvent', payload)
  }
}

instanceEventBus.onRemoteEvent(deliverCrossInstanceAgentEvent)

/**
 * Carry this process's shared-thread batches over that same link.
 *
 * The registry entry stays the durable half of every announcement   it reaches a
 * sibling before any socket exists, and it is the only path a peer built before
 * this channel understands   while the link is the immediate half. Both carry the
 * same batch id and the registry dedupes by it, so a sibling that receives both
 * applies one, and losing either copy costs freshness and never state.
 */
instanceRegistry.onLocalThreadChanged((batch) => instanceEventBus.publishThreadChange(batch))

/**
 * Apply a sibling's thread batch that arrived over the live link.
 *
 * Deliberately the same entry point the registry file uses: one dedupe, one
 * staleness rule and one listener fan-out, so a consumer like
 * `CrossInstanceThreadService` cannot tell which path delivered a batch and
 * every surface behind it works identically either way.
 */
instanceEventBus.onRemoteThreadChange((batch) => instanceRegistry.deliverRemoteThreadBatch(batch))

/**
 * Pipe a temporary chat (side chat) completion through the parent thread's
 * notification channel so the user learns their side chat is done even when
 * they are not on that thread.
 */
export function notifyTemporaryChat(
  thread: Thread,
  temporaryChatId: string,
  kind: 'completed' | 'error',
  errorDetail?: string
): void {
  void _notificationService?.notifyTemporaryChat(thread, temporaryChatId, kind, errorDetail)
}

/**
 * Pipe an independent (spec-less) audit completion through the coordinator
 * thread's notification channel so the user learns the audit is done even when
 * they are not on that thread.
 */
export function notifyIndependentAudit(
  thread: Thread,
  kind: 'completed' | 'error',
  errorDetail?: string
): void {
  void _notificationService?.notifyIndependentAudit(thread, kind, errorDetail)
}
