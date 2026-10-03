import type { BrowserDownload } from './browser'
import { ASSISTANT_SPACE_ID } from '../types'

export interface ThreadClickedPayload {
  projectId: string
  threadId: string
  /** Present when the click came from a temporary (side) chat notification, so
   *  the renderer can focus the side-chat panel after opening the parent
   *  thread. Omitted for regular thread notifications. */
  temporaryChatId?: string
}

/** One thread still being worked on, blocking the close. */
export interface CloseConfirmationThread {
  threadId: string
  title: string
  status: 'planning' | 'executing'
}

/** A project with at least one thread still being worked on. */
export interface CloseConfirmationProject {
  projectId: string
  projectName: string
  threadCount: number
  /** The exact threads blocking the close, most active first. */
  threads: CloseConfirmationThread[]
}

/** An open file with unsaved edits, blocking the close. */
export interface CloseConfirmationFile {
  projectId: string
  path: string
}

/** Sent when the user tries to close the app while threads are still working,
 *  browser downloads are running, or files have unsaved edits. `files` is
 *  populated by the renderer, which owns the unsaved-editor state. */
export interface CloseConfirmationPayload {
  projects: CloseConfirmationProject[]
  files: CloseConfirmationFile[]
  /**
   * Browser downloads a quit would stop, as the main process sees them. Main is
   * the one tracked-download owner, so this half of the prompt cannot come from
   * the renderer: its mirror of the list only exists once the browser runtime
   * chunk has loaded.
   *
   * Closing pauses each one and keeps its partial file, so the next launch
   * continues it where the server allows a range request.
   */
  downloads: BrowserDownload[]
  /**
   * The close is a park, not a quit: the window is torn down but the backend
   * keeps running so scheduled work still fires. The renderer answers with
   * `app:parkWindow` instead of `app:confirmClose`.
   */
  park?: boolean
}

export type AgentNotificationKind = 'completed' | 'chat-completed' | 'attention' | 'spec' | 'error'

/** Which bundled alert a notification maps to. */
export type NotificationSoundKind = 'default' | 'attention' | 'assistant'

/**
 * How long the app stays quiet after it played an alert. Only the first
 * notification of a burst is announced; the rest still show their card and
 * toast but stay silent, so a burst never machine-guns beeps.
 *
 * Both alert surfaces share this window: the main process gates the off-app
 * alert it dispatches, and the renderer sound module gates the in-app alert it
 * plays alongside the toast.
 */
export const NOTIFICATION_SOUND_DEDUP_MS = 2_500

/**
 * Which alert an event maps to. An attention request and a failure both mean
 * the user has to act, so they share the attention alert; a successful
 * assistant run (a thread in the assistant space that reached `completed`) has
 * its own alert; everything else is the default alert. The off-app card and the
 * in-app toast derive their alert from this one rule, so the same event never
 * sounds different per surface.
 */
export function notificationSoundKind(
  kind: AgentNotificationKind,
  projectId?: string
): NotificationSoundKind {
  if (kind === 'attention' || kind === 'error') return 'attention'
  if (kind === 'completed' && projectId === ASSISTANT_SPACE_ID) return 'assistant'
  return 'default'
}

/**
 * Which in-app alert group a sound kind belongs to. Success covers everything
 * that finished or is ready to review, including a successful assistant run;
 * an attention alert and a failure both mean the user has to act, so they share
 * the issue alert.
 */
export function inAppSoundGroup(kind: NotificationSoundKind): 'success' | 'issue' {
  return kind === 'attention' ? 'issue' : 'success'
}

/** Where a notification originated: a project thread, the global chat (inbox),
 *  the assistant space, or a temporary (side) chat piped through a parent
 *  thread. The panel routes each source to its own top tab. */
export type NotificationSource = 'project' | 'chat' | 'assistant' | 'temporary-chat'

export interface AgentNotificationPayload extends ThreadClickedPayload {
  id: string
  kind: AgentNotificationKind
  title: string
  body: string
  /** Origin of the notification, used by the panel to tag its source. */
  source: NotificationSource
  /** Name of the owning project (or the inbox "Chats" project for chats). */
  projectName: string
  /** Accent colour of the owning project, when known. */
  projectColor?: string
  /** Full diagnostic text of the failure (message plus raw detail/stack) for
   *  `error` notifications, so the panel can show what actually went wrong and
   *  offer a faithful copy action. Absent for non-error notifications and when
   *  the engine had no readable error. */
  errorDetail?: string
}

/**
 * A notification as the panel stores it, and as it survives a restart.
 *
 * The payload alone is not enough once the entry outlives the window that
 * received it: the panel renders each entry's age ("3h ago"), and that age is
 * measured from when the notification reached the app, not from when the
 * renderer that restores it happens to boot.
 */
export interface PersistedAgentNotification extends AgentNotificationPayload {
  /** When the notification reached the app, in epoch milliseconds. */
  timestamp: number
}

/**
 * Which top-level panel tab a notification belongs to, as the durable store
 * groups them. The store needs it because clearing a tab is a main-process
 * mutation now, and it must not have to re-derive the tab from a payload that
 * only carries a source and a project id.
 */
export type NotificationFamily = 'project' | 'chat' | 'assistant'

/**
 * What the durable inbox holds at the moment a window asks for it.
 *
 * The tombstones travel with the entries because the renderer's thread-state
 * hydration can rebuild an entry from a thread row that still says the same
 * thing (a thread parked on the user, or one that failed while no window was
 * open). Without the ids the user already dismissed, hydration would put a
 * cleared or dismissed entry straight back on the panel.
 */
export interface NotificationInboxSnapshot {
  notifications: PersistedAgentNotification[]
  dismissed: string[]
}

export type SystemNotificationTestResult =
  | { status: 'shown'; message: string }
  | { status: 'unsupported'; message: string }
  | { status: 'failed'; message: string }

/**
 * macOS notification authorization, queried on demand. On non-macOS platforms the
 * permission concept does not apply, so `platform` is `'other'`.
 */
export type SystemNotificationPermissionStatus =
  { platform: 'darwin'; status: 'granted' | 'denied' | 'prompt' } | { platform: 'other' }
