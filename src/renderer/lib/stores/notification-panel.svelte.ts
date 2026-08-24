import { APP_SLUG } from '$shared/brand'
import type { AgentNotificationPayload, NotificationSource } from '$shared/ipc-contract'
import {
  INBOX_PROJECT_ID,
  isOrchestrationChildThread,
  type Project,
  type Thread
} from '$shared/types'

export type NotificationFilter =
  'all' | 'completed' | 'chat-completed' | 'attention' | 'spec' | 'error' | 'app-errors'

export interface InAppNotification {
  id: string
  kind: 'completed' | 'chat-completed' | 'attention' | 'spec' | 'error'
  title: string
  body: string
  projectId: string
  threadId: string
  source: NotificationSource
  projectName: string
  projectColor?: string
  timestamp: number
}

class NotificationPanelState {
  private _notifications: InAppNotification[] = $state([])
  filter: NotificationFilter = $state('all')

  get notifications(): InAppNotification[] {
    if (this.filter === 'all') return this._notifications
    return this._notifications.filter((n) => n.kind === this.filter)
  }

  get hasCompleted(): boolean {
    return this._notifications.some((n) => n.kind === 'completed')
  }

  get hasAttention(): boolean {
    return this._notifications.some((n) => n.kind === 'attention')
  }

  get hasError(): boolean {
    return this._notifications.some((n) => n.kind === 'error')
  }

  get hasSpec(): boolean {
    return this._notifications.some((n) => n.kind === 'spec')
  }

  get completedCount(): number {
    return this._notifications.filter((n) => n.kind === 'completed').length
  }

  get chatCompletedCount(): number {
    return this._notifications.filter((n) => n.kind === 'chat-completed').length
  }

  get attentionCount(): number {
    return this._notifications.filter((n) => n.kind === 'attention').length
  }

  get errorCount(): number {
    return this._notifications.filter((n) => n.kind === 'error').length
  }

  get specCount(): number {
    return this._notifications.filter((n) => n.kind === 'spec').length
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

  dismissAll(): void {
    this._notifications = []
  }

  dismissForThread(projectId: string, threadId: string): void {
    this._notifications = this._notifications.filter(
      (n) => n.projectId !== projectId || n.threadId !== threadId
    )
  }

  setFilter(filter: NotificationFilter): void {
    this.filter = filter
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
