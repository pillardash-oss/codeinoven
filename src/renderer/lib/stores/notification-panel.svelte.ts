import { APP_SLUG } from '$shared/brand'
import type { AgentNotificationPayload } from '$shared/ipc-contract'
import { isOrchestrationChildThread, type Thread } from '$shared/types'

export type NotificationFilter = 'all' | 'completed' | 'attention' | 'error' | 'app-errors'

export interface InAppNotification {
  id: string
  kind: 'completed' | 'attention' | 'error'
  title: string
  body: string
  projectId: string
  threadId: string
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

  get completedCount(): number {
    return this._notifications.filter((n) => n.kind === 'completed').length
  }

  get attentionCount(): number {
    return this._notifications.filter((n) => n.kind === 'attention').length
  }

  get errorCount(): number {
    return this._notifications.filter((n) => n.kind === 'error').length
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
  hydrateFromThreads(threads: Thread[]): void {
    for (const thread of threads) {
      if (
        thread.status === 'awaiting_approval' &&
        !thread.read &&
        !isOrchestrationChildThread(thread)
      ) {
        this.add({
          id: `${APP_SLUG}-${thread.projectId}-${thread.id}-${thread.status}-${thread.updatedAt}`,
          kind: 'attention',
          title: 'Agent needs your attention',
          body: `${thread.title} is waiting for your input.`,
          projectId: thread.projectId,
          threadId: thread.id
        })
      }
    }
  }
}

export const notificationPanelState = new NotificationPanelState()
