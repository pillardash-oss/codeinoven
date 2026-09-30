import { APP_SLUG } from '$shared/brand'
import type { AgentNotificationPayload, NotificationSource } from '$shared/ipc-contract'
import {
  ASSISTANT_SPACE_ID,
  INBOX_PROJECT_ID,
  isOrchestrationChildThread,
  type Project,
  type Thread
} from '$shared/types'
import { assistantRoutines } from './assistant-routines.svelte'
import { threadStatusPolicy } from '$shared/thread-status-policy'

/** Top-level panel sections. */
export type NotificationTopTab = 'projects' | 'chats' | 'assistants' | 'app-errors'

/** Second-level filters shown under the active top tab. The assistants tab
 *  carries only missed runs, which are rendered straight from the assistant
 *  store, so it exposes no sub-filters. */
export type NotificationSubFilter = 'all' | 'done' | 'attention' | 'spec' | 'issues'

export interface InAppNotification {
  id: string
  kind: 'completed' | 'chat-completed' | 'attention' | 'spec' | 'error'
  title: string
  body: string
  projectId: string
  threadId: string
  source: NotificationSource
  /** Set for temporary-chat notifications: the side chat to focus after the
   *  parent thread opens. */
  temporaryChatId?: string
  projectName: string
  projectColor?: string
  /** Full diagnostic text (message plus raw detail/stack) for `error`
   *  notifications; drives the panel's copy action. */
  errorDetail?: string
  timestamp: number
}

const SUB_FILTER_KINDS: Record<Exclude<NotificationSubFilter, 'all'>, InAppNotification['kind']> = {
  done: 'completed',
  attention: 'attention',
  spec: 'spec',
  issues: 'error'
}

/**
 * Canonical accent colour for a notification kind, keyed to the very token the
 * app paints the same meaning with everywhere else: a spec is the spec purple,
 * a failure the danger red, a request for attention the warning amber, a chat
 * message the chat teal, and a completed project message the success green its
 * entry already carries. The bell's dots and an entry's leading dot both read
 * from here, so the colour on the notification badge is always the status
 * colour the rest of the app uses for the same thing   never a one-off hue.
 *
 * An assistant notice wears the assistant space's own colour instead (see
 * `accentColor`), which is how the assistant is identified across the app.
 */
export const NOTIFICATION_KIND_COLORS: Record<InAppNotification['kind'], string> = {
  completed: 'var(--color-success)',
  'chat-completed': 'var(--color-chat-success)',
  attention: 'var(--color-warning)',
  spec: 'var(--color-thread-spec)',
  error: 'var(--color-danger)'
}

class NotificationPanelState {
  private _notifications: InAppNotification[] = $state([])
  topTab: NotificationTopTab = $state('projects')
  subFilter: NotificationSubFilter = $state('all')

  /** Chats live in the Inbox project or arrive through a chat source. */
  private isChat(n: InAppNotification): boolean {
    return n.source === 'chat' || n.source === 'temporary-chat' || n.projectId === INBOX_PROJECT_ID
  }

  /** Assistant notices come from the hidden assistant space (routine runs).
   *  The source tag is authoritative; the project id covers any payload that
   *  predates the dedicated source. */
  isAssistant(n: InAppNotification): boolean {
    return n.source === 'assistant' || n.projectId === ASSISTANT_SPACE_ID
  }

  /**
   * The colour a notification wears on its leading dot and its card border:
   * an assistant notice takes the assistant space colour, everything else the
   * canonical kind colour. One rule shared by the bell and the panel, so the
   * two surfaces can never disagree about what colour a notification is.
   */
  accentColor(n: InAppNotification): string {
    if (this.isAssistant(n)) return this.assistantColor ?? 'var(--color-dimmed)'
    return NOTIFICATION_KIND_COLORS[n.kind]
  }

  private byKind(items: InAppNotification[], sub: NotificationSubFilter): InAppNotification[] {
    if (sub === 'all') return items
    const kind = SUB_FILTER_KINDS[sub]
    return items.filter((n) => n.kind === kind)
  }

  get projectNotifications(): InAppNotification[] {
    return this._notifications.filter((n) => !this.isChat(n) && !this.isAssistant(n))
  }

  get chatNotifications(): InAppNotification[] {
    return this._notifications.filter((n) => this.isChat(n))
  }

  /** Assistant-space notices (routine runs). The panel renders them beside the
   *  scheduled missed runs, which live in the assistant store rather than here. */
  get assistantNotifications(): InAppNotification[] {
    return this._notifications.filter((n) => this.isAssistant(n))
  }

  /** Items for the currently active top tab + sub filter. App errors are
   *  rendered by the panel straight from `appErrorState`, so this returns an
   *  empty list for that tab. */
  get visible(): InAppNotification[] {
    switch (this.topTab) {
      case 'projects':
        return this.byKind(this.projectNotifications, this.subFilter)
      case 'chats':
        return this.byKind(this.chatNotifications, this.subFilter)
      case 'assistants':
        return this.byKind(this.assistantNotifications, this.subFilter)
      case 'app-errors':
        return []
    }
  }

  private count(items: InAppNotification[], sub: NotificationSubFilter): number {
    return this.byKind(items, sub).length
  }

  projectCount(sub: NotificationSubFilter): number {
    return this.count(this.projectNotifications, sub)
  }

  chatCount(sub: NotificationSubFilter): number {
    return this.count(this.chatNotifications, sub)
  }

  assistantCount(sub: NotificationSubFilter): number {
    // The assistants tab carries assistant notices plus the pending missed
    // runs the panel renders straight from the assistant store. Missed runs
    // surface under the tab's "All" view, which is its only view.
    const notices = this.count(this.assistantNotifications, sub)
    return sub === 'all' ? notices + assistantRoutines.missedRuns.length : notices
  }

  /**
   * The assistant space's own accent colour, carried on every assistant
   * notification (the payload's `projectColor`), so the bell badge, the panel
   * entry and the toast brand themselves as assistant instead of reading as a
   * project or chat. Falls back to the space's stored colour when only a missed
   * run is pending and no notification payload carries it.
   */
  get assistantColor(): string | null {
    return (
      this.assistantNotifications.findLast((n) => n.projectColor)?.projectColor ??
      assistantRoutines.spaceColor
    )
  }

  /** True when the header bell must show its assistant dot: an assistant run
   *  that completed, or a scheduled run that was missed while the app was
   *  closed. An assistant run that failed lights the error dot instead, so a
   *  failure is never hidden behind the assistant colour. */
  get hasAssistant(): boolean {
    return (
      this.assistantNotifications.some((n) => n.kind === 'completed') ||
      assistantRoutines.missedRuns.length > 0
    )
  }

  // A completed project thread. An assistant completion wears the assistant
  // colour (see `hasAssistant`), so it never doubles up as a project dot.
  get hasCompleted(): boolean {
    return this._notifications.some((n) => n.kind === 'completed' && !this.isAssistant(n))
  }

  /** A completed chat (inbox) turn, which the bell shows as its own chat dot. */
  get hasChatCompleted(): boolean {
    return this._notifications.some((n) => n.kind === 'chat-completed')
  }

  // Status kinds light their canonical status colour for every source,
  // including the assistant space: a failed run must read as an error.
  get hasAttention(): boolean {
    return this._notifications.some((n) => n.kind === 'attention')
  }

  get hasError(): boolean {
    return this._notifications.some((n) => n.kind === 'error')
  }

  get hasSpec(): boolean {
    return this._notifications.some((n) => n.kind === 'spec')
  }

  get totalCount(): number {
    return this._notifications.length
  }

  add(payload: AgentNotificationPayload): void {
    if (this._notifications.some((n) => n.id === payload.id)) return
    this._notifications = [...this._notifications, { ...payload, timestamp: Date.now() }]
  }

  dismiss(id: string): void {
    this._notifications = this._notifications.filter((n) => n.id !== id)
  }

  /** Clear every notification under the given top tab. Missed runs belong to
   *  the assistant store and keep their own per-entry dismiss, so clearing the
   *  assistants tab drops only its notifications. */
  dismissTab(tab: Exclude<NotificationTopTab, 'app-errors'>): void {
    if (tab === 'projects') {
      this._notifications = this._notifications.filter((n) => this.isChat(n) || this.isAssistant(n))
    } else if (tab === 'chats') {
      this._notifications = this._notifications.filter((n) => !this.isChat(n))
    } else {
      this._notifications = this._notifications.filter((n) => !this.isAssistant(n))
    }
  }

  dismissAll(): void {
    this._notifications = []
  }

  dismissForThread(projectId: string, threadId: string): void {
    this._notifications = this._notifications.filter(
      (n) => n.projectId !== projectId || n.threadId !== threadId
    )
  }

  /**
   * Reconcile one thread's entries with the thread's own status.
   *
   * A notice is retired when it is acknowledged, and what acknowledging means
   * depends on what the notice reports. A needs-attention notice *is* the
   * thread's parked state: it survives being opened or read, because reading a
   * card answers nothing, and it leaves exactly when the thread stops waiting on
   * the user (the status changes). Every other notice reports a moment that has
   * already passed, so reading the thread retires it.
   */
  reconcileThread(thread: Thread): void {
    const parked = threadStatusPolicy(thread.status).awaitingUser
    const next = this._notifications.filter((entry) => {
      if (entry.projectId !== thread.projectId || entry.threadId !== thread.id) return true
      return entry.kind === 'attention' ? parked : !thread.read
    })
    if (next.length !== this._notifications.length) this._notifications = next
  }

  setTab(tab: NotificationTopTab): void {
    this.topTab = tab
    this.subFilter = 'all'
  }

  setSubFilter(sub: NotificationSubFilter): void {
    this.subFilter = sub
  }

  /** Populate attention notifications from persisted threads on startup. */
  hydrateFromThreads(threads: Thread[], projects: Project[] = []): void {
    const projectById = new Map(projects.map((project) => [project.id, project]))
    for (const thread of threads) {
      // A parked thread is live state, so it keeps its needs-attention entry
      // whether or not the user has read it, exactly like the menu bar icon:
      // reading the thread answers nothing, and only the status change that
      // answers the card ends the state. Every other notice is rehydrated only
      // while unread, because reading the thread is its acknowledgement.
      if (isOrchestrationChildThread(thread)) continue
      if (thread.read && !threadStatusPolicy(thread.status).awaitingUser) continue

      const project = projectById.get(thread.projectId)
      const isChat = thread.projectId === INBOX_PROJECT_ID

      // A run that settled `failed` while no window was open keeps its
      // persisted diagnostic on the thread row. Rehydrate it as an error entry
      // so the panel explains the failure instead of showing a bare status.
      if (thread.status === 'failed') {
        const isAssistant = thread.projectId === ASSISTANT_SPACE_ID
        const sourceName = isChat
          ? 'Chat'
          : isAssistant
            ? 'Assistant'
            : (project?.name ?? thread.title)
        const errorDetail = thread.lastError?.trim() || undefined
        const errorHeadline = errorDetail?.split('\n', 1)[0]?.trim() || undefined
        this.add({
          id: `${APP_SLUG}-${thread.projectId}-${thread.id}-${thread.status}-${thread.updatedAt}`,
          kind: 'error',
          title: `${sourceName} hit an error`,
          body: errorHeadline ?? `${thread.title} stopped with an error.`,
          ...(errorDetail ? { errorDetail } : {}),
          projectId: thread.projectId,
          threadId: thread.id,
          source: isChat ? 'chat' : isAssistant ? 'assistant' : 'project',
          projectName: project?.name ?? '',
          projectColor: project?.color
        })
        continue
      }

      if (thread.status === 'awaiting_approval' || thread.status === 'spec') {
        const sourceName = isChat ? 'Chat' : (project?.name ?? thread.title)
        this.add({
          id: `${APP_SLUG}-${thread.projectId}-${thread.id}-${thread.status}-${thread.updatedAt}`,
          kind: thread.status === 'spec' ? 'spec' : 'attention',
          title:
            thread.status === 'spec'
              ? `${sourceName} spec is ready`
              : `${sourceName} needs attention`,
          body:
            thread.status === 'spec'
              ? `${thread.title} has a reviewable engineering artifact ready in ${
                  project?.name ?? ''
                }.`
              : `${thread.title} is waiting for your input in ${project?.name ?? ''}.`,
          projectId: thread.projectId,
          threadId: thread.id,
          source: isChat ? 'chat' : 'project',
          projectName: project?.name ?? '',
          projectColor: project?.color
        })
      }
    }
  }
}

export const notificationPanelState = new NotificationPanelState()
