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
  private isAssistant(n: InAppNotification): boolean {
    return n.source === 'assistant' || n.projectId === ASSISTANT_SPACE_ID
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
   * The most urgent status the assistant space carries right now, or `null`
   * when it has nothing to show. It drives the header bell's assistant badge:
   * one badge whose colour is the assistant's own status colour, so an
   * assistant run never reads as a project thread badge.
   */
  get assistantStatus(): 'error' | 'attention' | 'missed' | 'spec' | 'completed' | null {
    const notices = this.assistantNotifications
    if (notices.some((n) => n.kind === 'error')) return 'error'
    if (notices.some((n) => n.kind === 'attention')) return 'attention'
    if (assistantRoutines.missedRuns.length > 0) return 'missed'
    if (notices.some((n) => n.kind === 'spec')) return 'spec'
    if (notices.length > 0) return 'completed'
    return null
  }

  /** True when the header bell must show its assistant status badge. */
  get hasAssistant(): boolean {
    return this.assistantStatus !== null
  }

  // Assistant notices are represented by the single assistant badge (see
  // `assistantStatus`), so they never double up as a project/chat kind badge.
  get hasCompleted(): boolean {
    return this._notifications.some((n) => n.kind === 'completed' && !this.isAssistant(n))
  }

  get hasAttention(): boolean {
    return this._notifications.some((n) => n.kind === 'attention' && !this.isAssistant(n))
  }

  get hasError(): boolean {
    return this._notifications.some((n) => n.kind === 'error' && !this.isAssistant(n))
  }

  get hasSpec(): boolean {
    return this._notifications.some((n) => n.kind === 'spec' && !this.isAssistant(n))
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
      if (
        (thread.status === 'awaiting_approval' || thread.status === 'spec') &&
        !thread.read &&
        !isOrchestrationChildThread(thread)
      ) {
        const project = projectById.get(thread.projectId)
        const isChat = thread.projectId === INBOX_PROJECT_ID
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
