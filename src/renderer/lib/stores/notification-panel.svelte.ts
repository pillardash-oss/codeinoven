import type { ArchiveKind } from '$shared/archives'
import { APP_SLUG } from '$shared/brand'
import { SvelteSet } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'
import type {
  AgentNotificationPayload,
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

/**
 * The filters on the panel's single list.
 *
 * `all` is every notice, run and fire the app raised. `exceptions` is the app's
 * own error log: it is not a notification, so it is never part of the others.
 */
export type NotificationSubFilter = 'all' | 'attention' | 'done' | 'spec' | 'exceptions'

/**
 * Which family of notice the panel lists.
 *
 * Every family shares one list now, so `all` is the default and the three
 * narrowings exist only for when the user wants one family alone.
 */
export type NotificationSourceFilter = 'all' | 'projects' | 'chats' | 'assistants'

export interface InAppNotification {
  id: string
  /**
   * What the entry reports.
   *
   * `working` is the state of an unattended run that is still executing: it is on
   * the panel because the user asked to see background work, but nothing is
   * waiting on them, so it must never count as attention.
   */
  kind: 'completed' | 'chat-completed' | 'attention' | 'spec' | 'error' | 'working'
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
  /** Distinct threads behind the summary, never the number of notices. */
  count: number
  /**
   * Ids of the unread threads, newest first.
   *
   * The rail also counts the unread threads it holds in memory, and one thread
   * can be unread in both sources (its own completed run and a side chat's
   * response) or in neither. The ids are what let the rail count the union once
   * per thread instead of taking a maximum of two counts that measure different
   * things.
   */
  threadIds: string[]
  label: string
  /** All distinct unread accents, in the same order and colours as the bell. */
  colors: string[]
}

/**
 * What one thread family has waiting on the user, as the view rail reports it.
 *
 * The count is deliberately the union of the durable notices the bell holds and
 * the assistant rows the assistant store owns, never the renderer's bounded
 * thread slice: a thread parked on a card must light its rail item whatever page
 * the user is on, even after it has fallen out of the recent-thread window.
 */
export interface RailAttentionSummary {
  count: number
  label: string
}

const SUB_FILTER_KINDS: Record<
  Exclude<NotificationSubFilter, 'all' | 'exceptions'>,
  readonly InAppNotification['kind'][]
> = {
  done: ['completed', 'chat-completed'],
  // A failure is waiting on the user exactly as a parked request is, so the two
  // are one filter rather than two.
  attention: ['attention', 'error'],
  spec: ['spec']
}

/**
 * Whether a notification kind answers to a filter. `all` accepts every kind and
 * `exceptions` none, because the app's own errors are not notifications.
 */
export function notificationMatchesSubFilter(
  kind: InAppNotification['kind'],
  sub: NotificationSubFilter
): boolean {
  if (sub === 'all') return true
  if (sub === 'exceptions') return false
  return SUB_FILTER_KINDS[sub].includes(kind)
}

/**
 * Which sub-filter an unattended (background) run answers to: a finished run is
 * Done, a failure is an Attention entry, a run parked on a gate is Attention
 * too, and a run still executing is working.
 *
 * A running run is deliberately not attention: nothing is waiting on the user
 * while it executes, and classifying it as attention painted the rail amber for
 * an assistant that was simply working (the run thread itself is the one that
 * reports working). The panel row already labels that state "Running" with the
 * working tone, so the filter matches the row it renders.
 */
export function backgroundRunNotificationKind(
  outcome: BackgroundRunOutcome | undefined
): InAppNotification['kind'] {
  if (outcome === 'completed') return 'completed'
  if (outcome === 'failed') return 'error'
  if (outcome === 'parked') return 'attention'
  return 'working'
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
  error: 'var(--color-danger)',
  working: 'var(--color-thread-working)'
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
const STATUS_KINDS: ReadonlySet<InAppNotification['kind']> = new Set([
  'attention',
  'spec',
  'error',
  'working'
])

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
  /** Opens on everything, because one list holds every kind now. */
  subFilter: NotificationSubFilter = $state('all')

  /** The family the list is narrowed to; `all` until the user picks one. */
  sourceFilter: NotificationSourceFilter = $state('all')

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

  /** Whether one notice belongs to the family the list is narrowed to. */
  private matchesSource(n: InAppNotification, source: NotificationSourceFilter): boolean {
    switch (source) {
      case 'projects':
        return !this.isChat(n) && !this.isAssistant(n)
      case 'chats':
        return this.isChat(n)
      case 'assistants':
        return this.isAssistant(n)
      case 'all':
        return true
    }
  }

  /**
   * Whether the assistant ledger's own rows belong to the active family.
   *
   * A missed scheduled fire and an unattended run never arrive as a notice, so
   * they have no source to read: they belong to the assistant space.
   */
  private showsAssistantRuns(source: NotificationSourceFilter): boolean {
    return source === 'all' || source === 'assistants'
  }

  /** Notices the active source and sub-filter admit, newest first per caller. */
  private noticesFor(sub: NotificationSubFilter): InAppNotification[] {
    return this._notifications.filter(
      (n) => this.matchesSource(n, this.sourceFilter) && notificationMatchesSubFilter(n.kind, sub)
    )
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

  /**
   * Everything on the panel that is waiting on the user, whichever family it
   * came from: the gate notices a project, chat, or assistant run raised, plus
   * the assistant rows the assistant store owns (a scheduled fire that was
   * missed while the app was closed, and an unattended run still parked on a
   * decision). The Attention filter shows all of them in one list.
   */
  get attentionNotifications(): InAppNotification[] {
    return newestFirst(this._notifications.filter((n) => n.kind === 'attention'))
  }

  /** Missed scheduled fires, newest first. A missed fire is an attention state
   *  by definition, so it belongs under the Attention filter as well as under its
   *  assistant's section on the Assistants tab. */
  get attentionMissedRuns(): MissedRun[] {
    return [...assistants.missedRuns].sort((a, b) => b.dueAt - a.dueAt)
  }

  /** Unattended runs still waiting on the user (running, or parked on a gate),
   *  minus a run whose own notice already stands for it on the panel. */
  get attentionBackgroundRuns(): BackgroundRun[] {
    const noticed = new Set(this._notifications.map((n) => n.threadId))
    return assistants.recentBackgroundRuns.filter(
      (run) =>
        !noticed.has(run.runThreadId) && backgroundRunNotificationKind(run.outcome) === 'attention'
    )
  }

  /** Rows the Attention filter shows, and therefore its count. */
  get attentionCount(): number {
    return (
      this.attentionNotifications.length +
      this.attentionMissedRuns.length +
      this.attentionBackgroundRuns.length
    )
  }

  /** Pending missed fires the active filter admits. A missed fire is an Attention
   *  state, so it answers only to a filter that admits one. */
  get visibleMissedRuns(): MissedRun[] {
    return this.missedRunsFor(this.subFilter)
  }

  /** Unattended runs the active filter admits, minus the run whose own failure
   *  notice is already on the list. Runs read by their outcome. */
  get visibleBackgroundRuns(): BackgroundRun[] {
    return this.backgroundRunsFor(this.subFilter)
  }

  private missedRunsFor(sub: NotificationSubFilter): MissedRun[] {
    if (!this.showsAssistantRuns(this.sourceFilter)) return []
    return notificationMatchesSubFilter('attention', sub) ? assistants.missedRuns : []
  }

  /**
   * Unattended runs for one filter, dropping the run whose notice is already on
   * the list. A failed run is marked unread, so it raises an assistant error
   * notice *and* leaves a ledger entry; the two are one event, and counting or
   * rendering both would show the same failure twice.
   */
  private backgroundRunsFor(sub: NotificationSubFilter): BackgroundRun[] {
    if (!this.showsAssistantRuns(this.sourceFilter)) return []
    const noticedRunThreads = new Set(this.assistantNotifications.map((n) => n.threadId))
    return assistants.recentBackgroundRuns.filter(
      (run) =>
        !noticedRunThreads.has(run.runThreadId) &&
        notificationMatchesSubFilter(backgroundRunNotificationKind(run.outcome), sub)
    )
  }

  /**
   * The unattended run an assistant notice stands for, when one run left both a
   * notice and a ledger entry.
   *
   * A failed unattended run is recorded twice: the scheduler writes the ledger
   * entry and the failure raises the notice. The panel draws the two as one row
   * (`backgroundRunsFor`), so a reader acknowledging the notice has to
   * retire the ledger entry with it. Dismissing only the notice would un-hide the
   * hidden half and ask the same run to be dismissed a second time.
   */
  assistantRunPairedWithNotice(n: InAppNotification): BackgroundRun | null {
    if (!this.isAssistant(n)) return null
    return assistants.recentBackgroundRuns.find((run) => run.runThreadId === n.threadId) ?? null
  }

  /** Notices the active filter admits, newest first. The app's own errors are
   *  rendered by the panel straight from `appErrorState`, so `exceptions` is
   *  empty here. */
  get visible(): InAppNotification[] {
    return newestFirst(this.noticesFor(this.subFilter))
  }

  /**
   * Rows a filter shows: notices, missed fires and unattended runs. These are
   * the three lists the panel merges, so a chip's count always matches the rows
   * on screen once it is selected.
   */
  count(sub: NotificationSubFilter): number {
    return (
      this.noticesFor(sub).length +
      this.missedRunsFor(sub).length +
      this.backgroundRunsFor(sub).length
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
   *  indicators, not the unread-completion dot.
   *
   *  The count is the number of distinct threads, not the number of notices: a
   *  thread raises one notice for its own settled turn and one for a side chat
   *  that answered on it, and the rail must still read one unread thread. The
   *  accents are deduped by colour rather than by thread, because one thread can
   *  legitimately carry two of them. */
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
    const threadIds = [...new Set(entries.map((entry) => entry.threadId))]
    const count = threadIds.length
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
      threadIds,
      label: `${count} unread ${familyLabel}${count === 1 ? '' : 's'}`,
      colors
    }
  }

  /**
   * Everything waiting on the user inside one thread family, for its rail item.
   *
   * The rail used to read this from the in-memory thread list alone, and that
   * list is a bounded recent slice per project: a thread parked on a permission,
   * question or secret that fell outside the window wore no rail mark at all,
   * while the bell listed it under Attention. The rail is the one indicator that
   * is on screen on every page, so it reads the same durable notices the bell
   * reads, plus the assistant rows (a missed scheduled fire, an unattended run
   * still parked on a decision) that only the assistant store holds.
   *
   * A background run whose thread already raised a notice is excluded so one
   * waiting run is never counted twice.
   */
  attentionRailSummary(family: 'projects' | 'chats' | 'assistant'): RailAttentionSummary | null {
    let count = this._notifications.filter((notification) => {
      if (notification.kind !== 'attention') return false
      if (family === 'projects')
        return !this.isChat(notification) && !this.isAssistant(notification)
      if (family === 'chats') return this.isChat(notification)
      return this.isAssistant(notification)
    }).length
    if (family === 'assistant') {
      count += this.attentionMissedRuns.length + this.attentionBackgroundRuns.length
    }
    if (count === 0) return null
    const noun =
      family === 'projects' ? 'project thread' : family === 'chats' ? 'chat' : 'assistant run'
    return {
      count,
      label: `${count} ${noun}${count === 1 ? '' : 's'} ${count === 1 ? 'needs' : 'need'} attention`
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
   * Acknowledge everything the panel holds for a thread the user has opened.
   *
   * Opening a thread is reading it, and reading it is its acknowledgement:
   * whatever notice was waiting there (a settled run, a parked gate, a ready
   * spec, a failure) has done its job the moment its conversation is on screen.
   * Each entry is retired through `dismiss`, so the tombstone reaches the
   * durable inbox too and neither a restart nor thread-state hydration can put
   * a notification back on a thread that was already read. An unattended run
   * that executed on this very thread is acknowledged with it.
   *
   * Missed scheduled fires are deliberately not acknowledged here: their row
   * carries the Run now and Dismiss actions, and opening the task is not the
   * same decision as retiring the miss.
   */
  acknowledgeOpenThread(thread: Thread): void {
    const entries = this._notifications.filter(
      (entry) => entry.projectId === thread.projectId && entry.threadId === thread.id
    )
    for (const entry of entries) this.dismiss(entry.id)
    for (const run of assistants.recentBackgroundRuns) {
      if (run.runThreadId === thread.id) void assistants.dismissBackgroundRun(run.runThreadId)
    }
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

  setSubFilter(sub: NotificationSubFilter): void {
    this.subFilter = sub
  }

  setSourceFilter(source: NotificationSourceFilter): void {
    this.sourceFilter = source
  }

  /**
   * Return the panel to what it opens on: one list, every kind, every family.
   * Called when a panel left closed long enough no longer owes the user the tab
   * they were last on (see `NOTIFICATION_PANEL_TAB_GRACE_MS`).
   */
  resetFilters(): void {
    this.subFilter = 'all'
    this.sourceFilter = 'all'
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
      // Only an unread thread is rebuilt. Reading a thread acknowledges every
      // notice it carried, including a needs-attention one: the parked state is
      // still visible on the thread's own row, and re-raising it here would put
      // a notification the user already read back in front of them on the next
      // scope load or launch.
      if (isOrchestrationChildThread(thread)) continue
      if (thread.read) continue

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
