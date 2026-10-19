import type { ArchiveKind } from '$shared/archives'
import { APP_SLUG } from '$shared/brand'
import { SvelteSet } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'
import type {
  AgentNotificationPayload,
  NotificationFamily,
  NotificationInboxSnapshot,
  NotificationSource
} from '$shared/ipc-contract'
import type { BackgroundRun, BackgroundRunOutcome, MissedRun } from '$shared/types'
import {
  ASSISTANT_SPACE_ID,
  INBOX_PROJECT_ID,
  isAssistantSetupThread,
  isOrchestrationChildThread,
  type Project,
  type Thread
} from '$shared/types'
import { assistants } from './assistants.svelte'
import {
  threadAwaitsIndependentAuditReview,
  threadStatusPolicy
} from '$shared/thread-status-policy'

/** Top-level panel sections. */
export type NotificationTopTab = 'projects' | 'chats' | 'assistants' | 'app-errors'

/** Second-level filters shown under the active top tab. */
export type NotificationSubFilter = 'all' | 'done' | 'attention' | 'spec' | 'issues'

/**
 * The assistant-subject narrowing behind the Assistants tab's filter button:
 * everything, only runs owned by an assistant, or only standalone task runs.
 */
export type NotificationAssistantSubject = 'all' | 'assistant' | 'task'

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
  /** Owning assistant of an assistant run, when the task belongs to one. Absent
   *  for a standalone task run; drives the assistants/tasks filter. */
  assistantId?: string
  /** Full diagnostic text (message plus raw detail/stack) for `error`
   *  notifications; drives the panel's copy action. */
  errorDetail?: string
  timestamp: number
}

export interface UnreadRailSummary {
  count: number
  label: string
  /** All distinct unread accents, in the same order and colours as the bell. */
  colors: string[]
}

const SUB_FILTER_KINDS: Record<Exclude<NotificationSubFilter, 'all'>, InAppNotification['kind']> = {
  done: 'completed',
  attention: 'attention',
  spec: 'spec',
  issues: 'error'
}

/**
 * Whether a notification kind answers to a sub-filter. `all` accepts every
 * kind; the rest accept the one kind they name. Shared with the panel so the
 * assistant runs it renders straight from the assistant store filter on exactly
 * the same rule as the notifications the store owns.
 */
export function notificationMatchesSubFilter(
  kind: InAppNotification['kind'],
  sub: NotificationSubFilter
): boolean {
  return sub === 'all' || SUB_FILTER_KINDS[sub] === kind
}

/**
 * Which sub-filter an unattended (background) run answers to: a finished run is
 * Done, a failure is an Issue, and anything still running or parked on the user
 * is Attention.
 */
export function backgroundRunNotificationKind(
  outcome: BackgroundRunOutcome | undefined
): InAppNotification['kind'] {
  if (outcome === 'completed') return 'completed'
  if (outcome === 'failed') return 'error'
  return 'attention'
}

/**
 * Canonical accent colour for a notification kind, keyed to the very token the
 * app paints the same meaning with everywhere else: a spec is the spec purple,
 * a failure the danger red, a request for attention the warning amber, the chat
 * response a temporary (side) chat delivers the chat-completion teal,
 * and a completed thread the success green its entry already carries. The bell's
 * dots and an entry's leading dot both read from here, so the colour on the
 * notification badge is always the status colour the rest of the app uses for
 * the same thing   never a one-off hue.
 *
 * `chat-completed` is raised only by a temporary chat, and it wears the chat
 * completion tone: that colour names the outcome (a chat response landed), never
 * the fact that the conversation is a side one. A side chat carries no colour of
 * its own anywhere   its dashed glyph is the only thing that marks it.
 *
 * An assistant notice raised by the assistant space's own activity wears the
 * assistant colour instead (see `accentColor`), which is how the assistant is
 * identified across the app. A status kind never does: see `STATUS_KINDS`.
 */
export const NOTIFICATION_KIND_COLORS: Record<InAppNotification['kind'], string> = {
  completed: 'var(--color-success)',
  'chat-completed': 'var(--color-chat-success)',
  attention: 'var(--color-warning)',
  spec: 'var(--color-thread-spec)',
  error: 'var(--color-danger)'
}

/**
 * Kinds that report a status rather than a source's own activity.
 *
 * Their colour is the app's canonical colour for that status whoever raised
 * them, because a status has to read before its words do: an assistant run that
 * failed is an error first and an assistant run second, so it must never hide
 * behind the assistant space colour   that was exactly the failure the eye
 * could not see. Only activity a source owns (a completion) is branded by the
 * space it came from.
 */
const STATUS_KINDS: ReadonlySet<InAppNotification['kind']> = new Set(['attention', 'spec', 'error'])

/** Newest first: a fresh notification leads its tab and older ones follow it. */
function newestFirst(items: readonly InAppNotification[]): InAppNotification[] {
  return [...items].sort((a, b) => b.timestamp - a.timestamp)
}

class NotificationPanelState {
  /** Archive visibility never creates dismissal tombstones; restoring can show the notice again. */
  hideArchived(kind: ArchiveKind, id: string): void {
    this._notifications = this._notifications.filter((entry) =>
      kind === 'project'
        ? entry.projectId !== id
        : kind === 'assistant'
          ? entry.assistantId !== id
          : entry.threadId !== id
    )
  }

  private _notifications: InAppNotification[] = $state([])
  /**
   * Ids the user retired, kept so nothing can rebuild them behind their back.
   *
   * Thread-state hydration builds entries from a thread row that still reports
   * the same status, so a dismissed failure or a still-parked request would
   * otherwise reappear on the next scope load and the next launch. The durable
   * store in the main process holds the same tombstones and drops them too;
   * this set is what keeps the live panel honest between a dismissal and the
   * next restore, and what seeds that restore.
   */
  private _dismissed = new SvelteSet<string>()
  topTab: NotificationTopTab = $state('projects')
  subFilter: NotificationSubFilter = $state('all')
  /** The Assistants tab's assistants/tasks narrowing. Ignored by every other tab. */
  assistantSubject: NotificationAssistantSubject = $state('all')

  /**
   * Chats live in the Inbox project or arrive through a chat source.
   *
   * A temporary chat is deliberately not a chat here: it belongs to the entity
   * that spawned it (its parent thread's project or the assistant space), so it
   * is grouped by that project rather than forced onto the Chats tab and rail.
   */
  private isChat(n: InAppNotification): boolean {
    return n.source === 'chat' || n.projectId === INBOX_PROJECT_ID
  }

  /** Assistant notices come from the hidden assistant space (assistant runs).
   *  The source tag is authoritative; the project id covers any payload that
   *  predates the dedicated source. */
  isAssistant(n: InAppNotification): boolean {
    return n.source === 'assistant' || n.projectId === ASSISTANT_SPACE_ID
  }

  /**
   * The colour a notification wears on its leading dot and its card border: a
   * status kind always takes its canonical status colour, an activity notice the
   * outcome colour it reports, and every other assistant notice the assistant space
   * colour. One rule shared by the bell, the panel and the view rails, so the
   * surfaces can never disagree about what colour a notification is   and a
   * failed run reads as an error on all of them, never as brand colour.
   */
  accentColor(n: InAppNotification): string {
    if (STATUS_KINDS.has(n.kind)) return NOTIFICATION_KIND_COLORS[n.kind]
    if (this.isAssistant(n)) return this.assistantColor ?? 'var(--color-dimmed)'
    return NOTIFICATION_KIND_COLORS[n.kind]
  }

  private byKind(items: InAppNotification[], sub: NotificationSubFilter): InAppNotification[] {
    if (sub === 'all') return items
    return items.filter((n) => notificationMatchesSubFilter(n.kind, sub))
  }

  /**
   * Whether an assistant entry (a notice, a missed fire, or an unattended run)
   * answers to the assistants/tasks filter. An assistant-owned entry has an assistant;
   * a standalone task run does not.
   */
  matchesAssistantSubject(hasAssistant: boolean): boolean {
    if (this.assistantSubject === 'all') return true
    return this.assistantSubject === 'assistant' ? hasAssistant : !hasAssistant
  }

  get projectNotifications(): InAppNotification[] {
    return this._notifications.filter((n) => !this.isChat(n) && !this.isAssistant(n))
  }

  get chatNotifications(): InAppNotification[] {
    return this._notifications.filter((n) => this.isChat(n))
  }

  /** Assistant-space notices (assistant runs). The panel renders them beside the
   *  scheduled missed runs, which live in the assistant store rather than here. */
  get assistantNotifications(): InAppNotification[] {
    return this._notifications.filter((n) => this.isAssistant(n))
  }

  /** Assistant notices that survive both the sub-filter and the subject filter. */
  get assistantVisibleNotifications(): InAppNotification[] {
    return this.assistantNotifications.filter(
      (n) =>
        notificationMatchesSubFilter(n.kind, this.subFilter) &&
        this.matchesAssistantSubject(Boolean(n.assistantId))
    )
  }

  /** Pending missed fires the Assistants tab shows under the active filters. A
   *  missed fire is an Attention state, so it answers only to a filter that
   *  admits one. */
  get assistantVisibleMissedRuns(): MissedRun[] {
    return this.assistantMissedRunsFor(this.subFilter)
  }

  /** Unattended runs the tab shows under the active filters, minus the run whose
   *  own failure notice is already on it. Runs read by their outcome. */
  get assistantVisibleBackgroundRuns(): BackgroundRun[] {
    return this.assistantBackgroundRunsFor(this.subFilter)
  }

  private assistantMissedRunsFor(sub: NotificationSubFilter): MissedRun[] {
    return assistants.missedRuns.filter(
      (run) =>
        notificationMatchesSubFilter('attention', sub) &&
        this.matchesAssistantSubject(Boolean(run.assistantId))
    )
  }

  /**
   * Unattended runs for one filter, dropping the run whose notice is already on
   * the tab. A failed run is marked unread, so it raises an assistant error
   * notice *and* leaves a ledger entry; the two are one event, and counting or
   * rendering both would show the same failure twice.
   */
  private assistantBackgroundRunsFor(sub: NotificationSubFilter): BackgroundRun[] {
    const noticedRunThreads = new Set(this.assistantNotifications.map((n) => n.threadId))
    return assistants.recentBackgroundRuns.filter(
      (run) =>
        !noticedRunThreads.has(run.runThreadId) &&
        notificationMatchesSubFilter(backgroundRunNotificationKind(run.outcome), sub) &&
        this.matchesAssistantSubject(Boolean(run.assistantId))
    )
  }

  /**
   * The unattended run an assistant notice stands for, when one run left both a
   * notice and a ledger entry.
   *
   * A failed unattended run is recorded twice: the scheduler writes the ledger
   * entry and the failure raises the notice. The panel draws the two as one row
   * (`assistantBackgroundRunsFor`), so a reader acknowledging the notice has to
   * retire the ledger entry with it. Dismissing only the notice would un-hide the
   * hidden half and ask the same run to be dismissed a second time.
   */
  assistantRunPairedWithNotice(n: InAppNotification): BackgroundRun | null {
    if (!this.isAssistant(n)) return null
    return assistants.recentBackgroundRuns.find((run) => run.runThreadId === n.threadId) ?? null
  }

  /** Items for the currently active top tab + sub filter. Project and chat
   *  listings lead with their newest entry; app errors are rendered by the panel
   *  straight from `appErrorState` (already newest first), so this returns an
   *  empty list for that tab. */
  get visible(): InAppNotification[] {
    switch (this.topTab) {
      case 'projects':
        return newestFirst(this.byKind(this.projectNotifications, this.subFilter))
      case 'chats':
        return newestFirst(this.byKind(this.chatNotifications, this.subFilter))
      case 'assistants':
        return this.assistantVisibleNotifications
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

  /**
   * Rows the Assistants tab shows for a sub-filter. The tab carries three lists
   * that the panel renders straight from the assistant store   notices here,
   * pending missed fires, and unattended runs   so its counts are the sum of
   * what survives the active sub-filter and subject filter in all three. A
   * missed fire is an Attention state; an unattended run reads by its outcome.
   */
  assistantCount(sub: NotificationSubFilter): number {
    const notices = this.assistantNotifications.filter(
      (n) =>
        notificationMatchesSubFilter(n.kind, sub) &&
        this.matchesAssistantSubject(Boolean(n.assistantId))
    ).length
    return (
      notices +
      this.assistantMissedRunsFor(sub).length +
      this.assistantBackgroundRunsFor(sub).length
    )
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
      assistants.spaceColor
    )
  }

  /** Completed-but-unread notifications grouped for the primary view rail.
   *  Attention, errors, specs, and missed runs belong to their activity/status
   *  indicators, not the unread-completion dot. */
  unreadRailSummary(family: 'projects' | 'chats' | 'assistant'): UnreadRailSummary | null {
    const entries = this._notifications.filter((notification) => {
      if (notification.kind !== 'completed' && notification.kind !== 'chat-completed') {
        return false
      }
      if (family === 'projects')
        return !this.isChat(notification) && !this.isAssistant(notification)
      if (family === 'chats') return this.isChat(notification)
      return this.isAssistant(notification)
    })
    const count = entries.length
    if (count === 0) return null

    // The dots list the accents actually waiting on the family, deduped and in
    // a stable order (a side-chat response first, then a settled turn). Reading
    // each entry's own outcome accent, rather than mapping its kind, is what
    // keeps it on the rail of the entity that spawned it.
    const priority: InAppNotification['kind'][] = ['chat-completed', 'completed']
    const ordered = [...entries].sort((a, b) => priority.indexOf(a.kind) - priority.indexOf(b.kind))
    const colors: string[] = []
    for (const entry of ordered) {
      const color = this.accentColor(entry)
      if (!colors.includes(color)) colors.push(color)
    }
    const familyLabel =
      family === 'projects' ? 'project' : family === 'chats' ? 'chat' : 'assistant'
    return {
      count,
      label: `${count} unread ${familyLabel}${count === 1 ? '' : 's'}`,
      colors
    }
  }

  /** True when the header bell must show its assistant dot: an assistant run
   *  that completed, or a scheduled run that was missed while the app was
   *  closed. An assistant run that failed lights the error dot instead, so a
   *  failure is never hidden behind the assistant colour. */
  get hasAssistant(): boolean {
    return (
      this.assistantNotifications.some((n) => n.kind === 'completed') ||
      assistants.missedRuns.length > 0
    )
  }

  // A completed project thread. An assistant completion wears the assistant
  // colour (see `hasAssistant`), so it never doubles up as a project dot.
  get hasCompleted(): boolean {
    return this._notifications.some((n) => n.kind === 'completed' && !this.isAssistant(n))
  }

  /** A completed temporary (side) chat turn, which the bell shows as a dot in
   *  the chat-completion tone its entry carries. A failed side chat lights the
   *  error dot instead, so a failure is never hidden behind a completion. */
  get hasTemporaryChat(): boolean {
    return this._notifications.some(
      (n) => n.source === 'temporary-chat' && n.kind === 'chat-completed'
    )
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

  /**
   * Record one notification the app just raised.
   *
   * Refuses an id the user already dismissed: see `_dismissed`. Notification ids
   * are derived from the thread, its status and its last update, so this is also
   * what keeps a re-delivered event from stacking a second copy of one entry.
   *
   * The durable copy is not written here. The main process records the
   * notification as it delivers it, which is the path that also covers a
   * delivery made while no window was open.
   */
  add(payload: AgentNotificationPayload): void {
    if (this._dismissed.has(payload.id)) return
    if (this._notifications.some((n) => n.id === payload.id)) return
    this._notifications = [...this._notifications, { ...payload, timestamp: Date.now() }]
  }

  /**
   * Adopt the durable inbox: what the last session left behind, plus the
   * tombstones for what the user retired there. Both the restore and the
   * thread-state hydration converge on `add`, so neither can double an entry.
   */
  restore(snapshot: NotificationInboxSnapshot): void {
    for (const id of snapshot.dismissed) this._dismissed.add(id)
    let next = this._notifications
    for (const entry of snapshot.notifications) {
      if (this._dismissed.has(entry.id)) continue
      if (next.some((n) => n.id === entry.id)) continue
      next = [...next, entry]
    }
    if (next !== this._notifications) this._notifications = next
  }

  /**
   * Read the durable inbox once per window, on boot.
   *
   * Called alongside thread-state hydration rather than instead of it: the two
   * cover different halves of the inbox (hydration rebuilds statuses from thread
   * rows, the store holds the moments that only a live delivery ever saw).
   */
  async restoreFromStore(): Promise<void> {
    try {
      this.restore(await invoke('notification:listInbox'))
    } catch {
      // The panel falls back to thread-state hydration on its own. A missing or
      // unreadable inbox must never take the notification surfaces down.
    }
  }

  /**
   * Retire one entry the user dismissed by hand.
   *
   * The main-process store is told too, because the durable record is what
   * survives the next restart: without the tombstone, a failure or a parked
   * request would be rebuilt from its thread row on the next launch.
   */
  dismiss(id: string): void {
    this._dismissed.add(id)
    this._notifications = this._notifications.filter((n) => n.id !== id)
    void invoke('notification:dismissInbox', id).catch(() => {})
  }

  /**
   * Clear every notification under the given top tab. Missed runs belong to
   * the assistant store and keep their own per-entry dismiss, so clearing the
   * assistants tab drops only its notifications.
   */
  dismissTab(tab: Exclude<NotificationTopTab, 'app-errors'>): void {
    this.retireBy((n) => this.survivesTabClear(n, tab))
    void invoke('notification:clearInbox', this.familyOf(tab)).catch(() => {})
  }

  dismissAll(): void {
    this.retireBy(() => false)
    void invoke('notification:clearInbox').catch(() => {})
  }

  /**
   * Drop a deleted thread's entries.
   *
   * The main process drops the same entries in its own delete handler, but that
   * is not the only way a thread can leave the database (a retention purge
   * reaches the repo directly), so the window that observed the deletion says so
   * too. Both sides are idempotent. A thread id is never reused, so unlike a
   * user dismissal this needs no tombstone.
   */
  dismissForThread(projectId: string, threadId: string): void {
    this._notifications = this._notifications.filter(
      (n) => n.projectId !== projectId || n.threadId !== threadId
    )
    void invoke('notification:dismissInboxForThread', projectId, threadId).catch(() => {})
  }

  /** The tab being cleared, as the store groups it. Clearing a tab removes the
   *  family it names, so this is the tab itself rather than its complement. */
  private familyOf(tab: Exclude<NotificationTopTab, 'app-errors'>): NotificationFamily {
    if (tab === 'chats') return 'chat'
    return tab === 'assistants' ? 'assistant' : 'project'
  }

  /**
   * Whether an entry survives clearing the given top tab.
   *
   * Clearing a tab removes that tab's own family, so the projects tab keeps the
   * chat and assistant families   its complement, not the family it names.
   */
  private survivesTabClear(
    n: InAppNotification,
    tab: Exclude<NotificationTopTab, 'app-errors'>
  ): boolean {
    if (tab === 'projects') return this.isChat(n) || this.isAssistant(n)
    if (tab === 'chats') return !this.isChat(n)
    return !this.isAssistant(n)
  }

  /**
   * Keep only the entries `keep` accepts, tombstoning every entry it rejects.
   *
   * A bulk clear has to leave the same tombstones a single dismissal does: it
   * runs the same one-line dismissal many times over, and without them the next
   * thread-state hydration would rebuild the whole cleared tab from thread rows
   * that still say the same thing. The main-process store records the same set.
   */
  private retireBy(keep: (n: InAppNotification) => boolean): void {
    const kept: InAppNotification[] = []
    for (const n of this._notifications) {
      if (keep(n)) kept.push(n)
      else this._dismissed.add(n.id)
    }
    this._notifications = kept
  }

  /**
   * Reconcile one thread's entries with the thread's own status.
   *
   * A notice is retired when it is acknowledged, and what acknowledging means
   * depends on what the notice reports. A needs-attention notice *is* the
   * thread's parked state: it survives being opened or read, because reading a
   * card answers nothing, and it leaves exactly when the thread stops waiting on
   * the user (the status changes, whether the user answered or the card settled
   * on its own). Every other notice reports a moment that has already passed, so
   * reading the thread retires it.
   */
  reconcileThread(thread: Thread): void {
    // Runs on every agent status tick, so leave immediately when no entry on the
    // panel belongs to this thread (the common case) instead of allocating a
    // filtered copy for it.
    const relevant = this._notifications.some(
      (entry) => entry.projectId === thread.projectId && entry.threadId === thread.id
    )
    if (!relevant) return
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
    this.assistantSubject = 'all'
  }

  setSubFilter(sub: NotificationSubFilter): void {
    this.subFilter = sub
  }

  setAssistantSubject(subject: NotificationAssistantSubject): void {
    this.assistantSubject = subject
  }

  /**
   * The name an assistant failure or parked card reports when its live payload
   * never arrived: the task it ran, else its assistant, else its own non-authoring
   * title. An assistant's fixed "Getting started" title is an authoring host, not a
   * job, so it is never returned as a name.
   */
  private assistantThreadSubject(thread: Thread, threads: readonly Thread[]): string {
    const assistantName = thread.assistantId
      ? assistants.assistants.find((assistant) => assistant.id === thread.assistantId)?.name.trim()
      : ''
    const task = thread.assistantTaskId
      ? threads.find((candidate) => candidate.id === thread.assistantTaskId)
      : undefined
    if (task && !isAssistantSetupThread(task) && task.title.trim()) return task.title.trim()
    if (assistantName) return assistantName
    return isAssistantSetupThread(thread) ? '' : thread.title.trim()
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
            ? this.assistantThreadSubject(thread, threads) || 'Assistant'
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
          ...(thread.assistantId ? { assistantId: thread.assistantId } : {}),
          source: isChat ? 'chat' : isAssistant ? 'assistant' : 'project',
          projectName: project?.name ?? '',
          projectColor: project?.color
        })
        continue
      }

      // A ready independent-audit report parks its thread on `spec` and is already
      // announced by its own card, which the durable inbox holds. Synthesizing a
      // second "spec is ready" entry would report that one moment twice.
      if (threadAwaitsIndependentAuditReview(thread)) continue
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
          ...(thread.assistantId ? { assistantId: thread.assistantId } : {}),
          source: isChat ? 'chat' : 'project',
          projectName: project?.name ?? '',
          projectColor: project?.color
        })
      }
    }
  }
}

export const notificationPanelState = new NotificationPanelState()
