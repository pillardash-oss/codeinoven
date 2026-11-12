<script lang="ts">
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import CioDebugger from '@pdslng/cio-icon/CioDebugger.svelte'
  import CioMessage from '@pdslng/cio-icon/CioMessage.svelte'
  import CioNotifications from '@pdslng/cio-icon/CioNotifications.svelte'
  import CioSubagent from '@pdslng/cio-icon/CioSubagent.svelte'
  import CioTemporaryChat from '@pdslng/cio-icon/CioTemporaryChat.svelte'
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  import { formatCompactAge } from '$shared/date-time-format'
  import {
    notificationPanelState,
    type NotificationAssistantSubject,
    type NotificationSubFilter,
    type NotificationTopTab,
    type InAppNotification
  } from '$lib/stores/notification-panel.svelte'
  import NotificationFilterMenu from './NotificationFilterMenu.svelte'
  import { appErrorState, errorHeadline, type AppErrorEntry } from '$lib/stores/app-errors.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { scopeState, STATUS_TONE_COLORS } from '$lib/stores/scope.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { assistants } from '$lib/stores/assistants.svelte'
  import {
    assistantSubjectName,
    backgroundRunOutcomeLabel,
    backgroundRunReasonText,
    backgroundRunTone,
    groupActivityByAssistant,
    missedRunReasonText,
    UNGROUPED_MISSED_RUNS
  } from '$lib/components/assistant/assistant-view'
  import { SvelteSet } from 'svelte/reactivity'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { copyText } from '$lib/copy-text'
  import {
    ASSISTANT_SPACE_ID,
    INBOX_PROJECT_ID,
    type BackgroundRun,
    type MissedRun,
    type Thread
  } from '$shared/types'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { preloadThreadById } from '$lib/stores/thread-preload'

  interface Props {
    onOpenThread?: (
      projectId: string,
      threadId: string,
      temporaryChatId?: string
    ) => void | Promise<void>
  }

  /**
   * One row the Assistants tab can show under an assistant: a notice, a missed
   * fire, or an unattended run, each tagged with the moment it reports and the
   * assistant it belongs to, so all three fold together per assistant.
   */
  type AssistantActivity =
    | {
        kind: 'notice'
        id: string
        at: number
        assistantId: string | undefined
        notification: InAppNotification
      }
    | {
        kind: 'missed'
        id: string
        at: number
        assistantId: string | undefined
        run: MissedRun
      }
    | {
        kind: 'background'
        id: string
        at: number
        assistantId: string | undefined
        run: BackgroundRun
      }

  /**
   * One row of the merged list, tagged with the moment it reports so the four
   * sources (a notice, a missed fire, an unattended run, and an app error) read
   * as one newest-first list instead of separate sections.
   */
  type FeedRow =
    | { kind: 'notice'; id: string; at: number; notification: InAppNotification }
    | { kind: 'missed'; id: string; at: number; run: MissedRun }
    | { kind: 'background'; id: string; at: number; run: BackgroundRun }
    | { kind: 'error'; id: string; at: number; entry: AppErrorEntry }

  let { onOpenThread }: Props = $props()

  /**
   * Debounce for the hover warmup.
   *
   * A notice row is one row: the pointer crossing the list would otherwise fire
   * a read for every card it passes, so the warmup waits as long as a thread row
   * does. It is the same 200 ms the sidebar uses, so the two surfaces feel alike.
   */
  const PRELOAD_DEBOUNCE_MS = 200
  let preloadTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Warm the thread a row opens, before the click reads it.
   *
   * The panel is handed ids, never rows, so this resolves the row and hands it to
   * the same warmup the sidebar runs on hover: the transcript and, for a thread
   * whose turn is still open, its durable trace. Clicking afterwards opens a warm
   * conversation instead of paying that read on the click.
   */
  function schedulePreload(projectId: string, threadId: string | undefined): void {
    clearTimeout(preloadTimer)
    if (!threadId) return
    preloadTimer = setTimeout(() => preloadThreadById(projectId, threadId), PRELOAD_DEBOUNCE_MS)
  }

  function cancelPreload(): void {
    clearTimeout(preloadTimer)
  }

  const sources: Array<{ id: NotificationTopTab; label: string; hint: string }> = [
    { id: 'all', label: 'All sources', hint: 'Projects, chats, assistants and app errors' },
    { id: 'projects', label: 'Projects', hint: 'Threads in your projects' },
    { id: 'chats', label: 'Chats', hint: 'Chats outside any project' },
    { id: 'assistants', label: 'Assistants', hint: 'Assistant runs and scheduled fires' },
    { id: 'app-errors', label: 'App errors', hint: 'Errors the app itself raised' }
  ]

  const subFilterLabels: Record<NotificationSubFilter, string> = {
    all: 'All',
    done: 'Done',
    attention: 'Attention',
    spec: 'Spec',
    issues: 'Issues'
  }

  function subFiltersFor(source: NotificationTopTab): NotificationSubFilter[] {
    switch (source) {
      case 'all':
      case 'projects':
        return ['all', 'attention', 'done', 'spec', 'issues']
      // Chats and assistants never raise a spec.
      case 'chats':
      case 'assistants':
        return ['all', 'attention', 'done', 'issues']
      // App errors are one kind, so there is nothing to narrow.
      case 'app-errors':
        return []
    }
  }

  /** App errors are issues, so they join the merged list under All and Issues. */
  function errorsShownFor(sub: NotificationSubFilter): boolean {
    return sub === 'all' || sub === 'issues'
  }

  function subCount(source: NotificationTopTab, sub: NotificationSubFilter): number {
    switch (source) {
      case 'all':
        return (
          notificationPanelState.projectCount(sub) +
          notificationPanelState.chatCount(sub) +
          notificationPanelState.assistantCount(sub) +
          (errorsShownFor(sub) ? appErrorState.count : 0)
        )
      case 'projects':
        return notificationPanelState.projectCount(sub)
      case 'chats':
        return notificationPanelState.chatCount(sub)
      case 'assistants':
        return notificationPanelState.assistantCount(sub)
      case 'app-errors':
        return 0
    }
  }

  let busyId = $state<string | null>(null)
  let copiedId = $state<string | null>(null)

  // Diagnostic detail (stack trace) blocks start expanded   the stack is the
  // reason the entry exists   and collapse per entry when the user wants density.
  const collapsedDetails = new SvelteSet<string>()

  function toggleDetails(key: string): void {
    if (collapsedDetails.has(key)) collapsedDetails.delete(key)
    else collapsedDetails.add(key)
  }

  /** True when the diagnostic text carries real stack frames. */
  function hasStackFrames(details: string): boolean {
    return /^\s+at\s/m.test(details)
  }

  /** Detail worth showing: it adds something beyond the entry's headline. */
  function hasUsefulDetails(headline: string, details: string | undefined): boolean {
    const trimmed = details?.trim()
    return trimmed !== undefined && trimmed.length > 0 && trimmed !== headline.trim()
  }

  let showingAppErrors = $derived(notificationPanelState.topTab === 'app-errors')
  let showingAssistants = $derived(notificationPanelState.topTab === 'assistants')

  /**
   * The merged list: every notice the active kind filter admits, plus, for the
   * all-sources view, the assistant store's missed fires and unattended runs and
   * the app's own errors, newest first. Projects and Chats are the same list
   * narrowed to their own notices.
   */
  const feedRows = $derived.by<FeedRow[]>(() => {
    const source = notificationPanelState.topTab
    if (source !== 'all' && source !== 'projects' && source !== 'chats') return []
    const rows: FeedRow[] = []
    for (const n of notificationPanelState.visible) {
      rows.push({ kind: 'notice', id: `notice:${n.id}`, at: n.timestamp, notification: n })
    }
    if (source === 'all') {
      for (const run of notificationPanelState.assistantVisibleMissedRuns) {
        rows.push({ kind: 'missed', id: `missed:${run.id}`, at: run.dueAt, run })
      }
      for (const run of notificationPanelState.assistantVisibleBackgroundRuns) {
        rows.push({
          kind: 'background',
          id: `background:${run.runThreadId}`,
          at: run.settledAt ?? run.startedAt,
          run
        })
      }
      if (errorsShownFor(notificationPanelState.subFilter)) {
        for (const entry of appErrorState.entries) {
          rows.push({ kind: 'error', id: `error:${entry.id}`, at: entry.timestamp, entry })
        }
      }
    }
    return rows.sort((x, y) => y.at - x.at)
  })

  let hasVisibleItems = $derived(
    showingAppErrors
      ? appErrorState.count > 0
      : showingAssistants
        ? notificationPanelState.assistantCount(notificationPanelState.subFilter) > 0
        : feedRows.length > 0
  )

  const sourceLabel = $derived(
    sources.find((entry) => entry.id === notificationPanelState.topTab)?.label ?? 'All sources'
  )

  // Missed runs are surfaced per assistant: one group per owning assistant, plus a
  // single group for assistant-less tasks. Both the groups and the panel's tab
  // chrome exist only once at least one run has actually been missed.
  const assistantNameById = $derived(
    new Map(assistants.assistants.map((assistant) => [assistant.id, assistant.name]))
  )

  /**
   * The missed fires and unattended runs the panel shows both come straight
   * from the store (`assistantVisibleMissedRuns` / `assistantVisibleBackgroundRuns`),
   * which applies the same sub-filter, assistants/tasks filter, and run/notice
   * de-duplication to them as it does to the notices it owns. Keeping the rule in
   * one place is what makes the tab badge match the rows on screen.
   */

  /**
   * One entry per row an assistant section can show: a notice, a missed fire, or
   * an unattended run, each carrying the moment it reports and the assistant it
   * belongs to.
   */
  const assistantActivity = $derived.by<AssistantActivity[]>(() => {
    const entries: AssistantActivity[] = []
    for (const n of notificationPanelState.assistantVisibleNotifications) {
      entries.push({
        kind: 'notice',
        id: `notice:${n.id}`,
        at: n.timestamp,
        assistantId: n.assistantId,
        notification: n
      })
    }
    for (const run of notificationPanelState.assistantVisibleMissedRuns) {
      entries.push({
        kind: 'missed',
        id: `missed:${run.id}`,
        at: run.dueAt,
        assistantId: run.assistantId,
        run
      })
    }
    for (const run of notificationPanelState.assistantVisibleBackgroundRuns) {
      entries.push({
        kind: 'background',
        id: `background:${run.runThreadId}`,
        at: run.settledAt ?? run.startedAt,
        assistantId: run.assistantId,
        run
      })
    }
    return entries
  })

  /**
   * The Assistants tab folds per assistant: one section per assistant (plus one for
   * activity owned by no assistant), newest update first inside each section and
   * across them, so an assistant that just updated rises to the top of the list.
   */
  const assistantSections = $derived(
    groupActivityByAssistant(assistantActivity, assistantNameById, { key: UNGROUPED_MISSED_RUNS })
  )

  // Sections the user folded shut, keyed by assistant (or the assistant-less
  // bucket). Open is the default, so a fresh assistant stays visible until folded.
  const collapsedAssistantSections = new SvelteSet<string>()

  function toggleAssistantSection(key: string): void {
    if (collapsedAssistantSections.has(key)) collapsedAssistantSections.delete(key)
    else collapsedAssistantSections.add(key)
  }

  // The assistants tab's assistants/tasks narrowing, behind the filter button at
  // the end of the sub-filter row.
  const assistantSubjectOptions: Array<{
    id: NotificationAssistantSubject
    label: string
    hint: string
  }> = [
    { id: 'all', label: 'Assistants and tasks', hint: 'Everything the assistant ran' },
    { id: 'assistant', label: 'Assistants only', hint: 'Runs owned by a scheduled assistant' },
    { id: 'task', label: 'Tasks only', hint: 'Runs of tasks that belong to no assistant yet' }
  ]

  const assistantSubjectLabel = $derived(
    assistantSubjectOptions.find((option) => option.id === notificationPanelState.assistantSubject)
      ?.label ?? 'Assistants and tasks'
  )

  /** Whether any assistant activity exists before either filter narrows it. */
  const assistantHasActivity = $derived(
    notificationPanelState.assistantNotifications.length > 0 ||
      assistants.missedRuns.length > 0 ||
      assistants.recentBackgroundRuns.length > 0
  )

  /** Whether the active filters hide everything there is to show. */
  const assistantFilteredEmpty = $derived(assistantHasActivity && assistantSections.length === 0)

  function resetAssistantFilters(): void {
    notificationPanelState.setSubFilter('all')
    notificationPanelState.setAssistantSubject('all')
  }

  /**
   * The task a run row reports for, resolved from the loaded thread list. A
   * assistant's Getting started host is not a job, and a deleted task has no row
   * at all, so both resolve through the assistant name instead (see
   * `assistantSubjectName`).
   */
  function runTask(threadId: string): Thread | undefined {
    return scopeState.allScopeThreads.find((thread) => thread.id === threadId)
  }

  function assistantNameFor(assistantId: string | undefined): string | null {
    return assistantId ? (assistantNameById.get(assistantId) ?? null) : null
  }

  function missedRunTitle(run: MissedRun): string {
    return assistantSubjectName(
      runTask(run.threadId),
      assistantNameFor(run.assistantId),
      'Assistant task'
    )
  }

  /**
   * A run's own row names the task it ran, never the assistant's "Getting started"
   * authoring host, resolved from the thread list. A task whose thread was
   * deleted still has ledger evidence, so it falls back to the assistant name and
   * then the neutral label rather than disappearing.
   */
  function backgroundRunTitle(run: BackgroundRun): string {
    return assistantSubjectName(
      runTask(run.taskId),
      assistantNameFor(run.assistantId),
      'Assistant run'
    )
  }

  /**
   * Acknowledge one notice: retire it, and retire the unattended run it stands
   * for when a failure left both a notice and a ledger entry for one run. The
   * panel draws those two as a single row, so both leave together.
   */
  function acknowledgeNotification(n: InAppNotification): void {
    notificationPanelState.dismiss(n.id)
    const run = notificationPanelState.assistantRunPairedWithNotice(n)
    if (run) void dismissBackgroundRun(run.runThreadId)
  }

  async function navigateToNotification(n: InAppNotification): Promise<void> {
    busyId = n.id
    try {
      if (onOpenThread) {
        await onOpenThread(n.projectId, n.threadId, n.temporaryChatId)
        acknowledgeNotification(n)
        return
      }
      const [project, thread] = await Promise.all([
        invoke('project:get', n.projectId),
        invoke('thread:get', n.projectId, n.threadId)
      ])
      if (!project || !thread) return
      const openDesktopThread = workspaceState.openThreadFromNotification
      if (!openDesktopThread) return
      await openDesktopThread(thread, project, n.temporaryChatId)
      acknowledgeNotification(n)
    } catch {
      // Thread or project may have been deleted
    } finally {
      busyId = null
    }
  }

  function dismiss(n: InAppNotification): void {
    notificationPanelState.dismiss(n.id)
  }

  /** Open an assistant thread by id: a task, or one of its run threads. */
  async function openMissedRun(threadId: string): Promise<void> {
    busyId = threadId
    try {
      if (onOpenThread) {
        await onOpenThread(ASSISTANT_SPACE_ID, threadId)
        return
      }
      const [project, thread] = await Promise.all([
        invoke('project:get', ASSISTANT_SPACE_ID),
        invoke('thread:get', ASSISTANT_SPACE_ID, threadId)
      ])
      if (!project || !thread) return
      const openDesktopThread = workspaceState.openThreadFromNotification
      if (!openDesktopThread) return
      await openDesktopThread(thread, project)
    } catch {
      // The task may have been deleted
    } finally {
      busyId = null
    }
  }

  async function dismissMissedRun(id: string): Promise<void> {
    try {
      await assistants.dismissMissedRun(id)
    } catch {
      // Surfaced as a missed run returning on the next refresh; nothing to do here.
    }
  }

  /** Acknowledge one unattended run so it leaves the "While you were away" list. */
  async function dismissBackgroundRun(id: string): Promise<void> {
    try {
      await assistants.dismissBackgroundRun(id)
    } catch {
      // Main pushes the fresh ledger list; a failure simply leaves the row.
    }
  }

  /**
   * Open an unattended run and acknowledge it: the row leaves the panel the
   * moment its thread opens, exactly as any other thread's notice does.
   */
  async function openBackgroundRun(run: BackgroundRun): Promise<void> {
    await openMissedRun(run.runThreadId)
    await dismissBackgroundRun(run.runThreadId)
  }

  async function runMissedRunNow(id: string): Promise<void> {
    busyId = id
    try {
      const run = await assistants.runMissedRunNow(id)
      // Every run executes on its own fresh thread, so open that thread.
      if (run) await openMissedRun(run.id)
    } finally {
      busyId = null
    }
  }

  function dismissAll(): void {
    const { topTab: source, subFilter: sub } = notificationPanelState
    if (source === 'app-errors') {
      appErrorState.dismissAll()
      return
    }
    // The Assistants list is two stores: the notices the notification panel owns,
    // and the missed fires and unattended runs the assistant store owns. Clearing
    // only the notices left the run rows behind with no button left to clear
    // them, so it is retired through both in one action.
    if (source === 'assistants') {
      notificationPanelState.dismissTab(source)
      void dismissAssistantRuns()
      return
    }
    if (source === 'all' && sub === 'attention') {
      notificationPanelState.dismissAttention()
      void dismissAttentionRuns()
      return
    }
    if (source !== 'all' && sub === 'all') {
      notificationPanelState.dismissTab(source)
      contextSidebarState.hide()
      return
    }
    // Any other narrowing clears exactly the rows on screen, nothing hidden.
    for (const row of feedRows) {
      if (row.kind === 'notice') acknowledgeNotification(row.notification)
      else if (row.kind === 'missed') void dismissMissedRun(row.run.id)
      else if (row.kind === 'background') void dismissBackgroundRun(row.run.runThreadId)
      else appErrorState.dismiss(row.entry.id)
    }
  }

  /** Retire the Attention filter's run rows: missed fires and parked runs. A run
   *  that already settled is not on this list, so it is left in the ledger. */
  async function dismissAttentionRuns(): Promise<void> {
    const missed = notificationPanelState.attentionMissedRuns
    const runs = notificationPanelState.attentionBackgroundRuns
    await Promise.all([
      ...missed.map((run) => dismissMissedRun(run.id)),
      ...runs.map((run) => dismissBackgroundRun(run.runThreadId))
    ])
  }

  /** Retire the Assistants tab's run rows: missed fires and unattended runs. */
  async function dismissAssistantRuns(): Promise<void> {
    try {
      await assistants.dismissRunActivity()
    } catch {
      // The scheduler pushes its fresh lists on the next change; a failure here
      // simply leaves the rows on the tab instead of clearing a list that is
      // still there.
    }
  }

  async function copyError(e: AppErrorEntry): Promise<void> {
    try {
      await copyText(e.details ? `${e.message}\n\n${e.details}` : e.message, null)
      copiedId = e.id
      window.setTimeout(() => {
        if (copiedId === e.id) copiedId = null
      }, 1500)
    } catch {
      // Clipboard unavailable; nothing to surface here
    }
  }

  /** Full clipboard text for a thread-error notification: title, headline and
   *  the complete diagnostic detail (raw error/stack) when available. */
  function notificationErrorText(n: InAppNotification): string {
    const headline = errorHeadline(n.body)
    const parts = [n.title, headline]
    if (n.errorDetail && n.errorDetail.trim() !== headline) parts.push(n.errorDetail.trim())
    return parts.join('\n\n')
  }

  async function copyNotificationError(n: InAppNotification): Promise<void> {
    try {
      await copyText(notificationErrorText(n), null)
      copiedId = n.id
      window.setTimeout(() => {
        if (copiedId === n.id) copiedId = null
      }, 1500)
    } catch {
      // Clipboard unavailable; nothing to surface here
    }
  }

  /** The card's left border: the entry's canonical accent at a light wash, so
   *  the border and the leading dot always agree on what the notification is. */
  function accentBorder(n: InAppNotification): string {
    return `color-mix(in srgb, ${notificationPanelState.accentColor(n)} 40%, transparent)`
  }

  /**
   * The line under an entry's title.
   *
   * An assistant completion states its outcome: the reader is on the Assistants
   * tab, the title is already the assistant or task name, and the payload's body
   * repeated that name ("Shower News finished."). Entries the durable inbox
   * restored from an older session still carry that repetition, so the outcome
   * is derived here rather than trusted from the stored body.
   */
  function displayBody(n: InAppNotification): string {
    if (notificationPanelState.isAssistant(n) && n.kind === 'completed') return 'Run completed'
    return n.body
  }

  function kindLabel(kind: InAppNotification['kind']): string {
    switch (kind) {
      case 'completed':
        return 'Project complete'
      case 'chat-completed':
        return 'Temporary chat response'
      case 'attention':
        return 'Needs attention'
      case 'spec':
        return 'Spec ready'
      case 'error':
        return 'Error'
    }
  }

  function appErrorAccent(kind: AppErrorEntry['kind']): string {
    return kind === 'error' ? 'border-l-danger/40' : 'border-l-warning/40'
  }

  function appErrorLabel(kind: AppErrorEntry['kind']): string {
    return kind === 'error' ? 'Error' : 'Warning'
  }
</script>

{#snippet detailsBlock(key: string, details: string)}
  {@const expanded = !collapsedDetails.has(key)}
  {@const stackFrames = hasStackFrames(details)}
  {@const label = expanded
    ? `Hide ${stackFrames ? 'stack trace' : 'details'}`
    : `Show ${stackFrames ? 'stack trace' : 'details'}`}
  <button
    class="mt-1.5 flex items-center gap-1 px-1 py-0.5 text-[0.625rem] font-medium text-dimmed transition-colors hover:bg-raised hover:text-foreground"
    aria-expanded={expanded}
    aria-label={label}
    title={label}
    onclick={(event: MouseEvent) => {
      event.stopPropagation()
      toggleDetails(key)
    }}
  >
    <CioChevronDown
      size={10}
      class={expanded ? 'rotate-180 transition-transform' : 'transition-transform'}
    />
    {stackFrames ? 'Stack trace' : 'Details'}
  </button>
  {#if expanded}
    <pre
      class="mt-1 max-h-40 select-text overflow-auto border border-border bg-overlay p-2 font-mono text-[0.6875rem] leading-relaxed break-all whitespace-pre-wrap text-muted">{details}</pre>
  {/if}
{/snippet}

{#snippet notificationCard(n: InAppNotification, showSource = false)}
  {@const active = busyId === n.id}
  <div
    class="group flex cursor-pointer items-start gap-2 border-l-2 bg-surface px-3 py-2.5 transition-colors hover:bg-elevated {active
      ? 'opacity-60 pointer-events-none'
      : ''}"
    style="border-left-color: {accentBorder(n)}"
    role="button"
    tabindex="0"
    aria-label={`${kindLabel(n.kind)}: ${n.title}. Click to navigate to thread`}
    title={`${n.title}${displayBody(n) ? `   ${displayBody(n)}` : ''}`}
    onclick={() => void navigateToNotification(n)}
    onmouseenter={() => schedulePreload(n.projectId, n.threadId)}
    onmouseleave={cancelPreload}
    onkeydown={(e: KeyboardEvent) => {
      // Ignore keys that belong to a nested control (the stack-trace
      // toggle), which would otherwise navigate away on Enter.
      if (e.target !== e.currentTarget) return
      if (keymapState.matches('chat-notification-open', e)) {
        e.preventDefault()
        void navigateToNotification(n)
      }
    }}
  >
    <div class="flex w-2 shrink-0 pt-1">
      <StatusBadge color={notificationPanelState.accentColor(n)} title={kindLabel(n.kind)} />
    </div>
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <span class="truncate text-[0.6875rem] font-medium text-foreground">{n.title}</span>
        <span class="shrink-0 text-[0.625rem] text-dimmed">{formatCompactAge(n.timestamp)}</span>
      </div>
      <!--
        An assistant notice drops the source line on the Assistants tab, where
        the reader is already inside that assistant's section. The Attention tab
        mixes every family into one list, so there it names the source it came
        from instead of leaving the row unattributed.
      -->
      {#if showSource || !notificationPanelState.isAssistant(n)}
        <div class="mt-1 flex items-center gap-1 text-[0.625rem] text-dimmed">
          {#if n.source === 'chat'}
            <CioMessage size={10} class="shrink-0" />
            <span>Chat</span>
          {:else if notificationPanelState.isAssistant(n)}
            <CioSubagent size={10} class="shrink-0" />
            <span class="truncate">{assistantNameFor(n.assistantId) ?? 'Assistant'}</span>
          {:else}
            <span
              class="h-1.5 w-1.5 shrink-0"
              style="background: {n.projectColor ?? 'var(--color-border)'}"
              role="presentation"
            ></span>
            <span class="truncate">{n.projectId === INBOX_PROJECT_ID ? 'Chat' : n.projectName}</span
            >
            {#if n.source === 'temporary-chat'}
              <span class="shrink-0">·</span>
              <!-- The dashed circle marks the side chat; it wears the row's own
                   neutral icon colour, never an identity hue. -->
              <CioTemporaryChat
                size={10}
                class="shrink-0"
                title="Temporary chat"
                aria-hidden="true"
              />
            {/if}
          {/if}
        </div>
      {/if}
      {#if displayBody(n)}
        <p class="mt-0.5 line-clamp-2 text-[0.6875rem] leading-relaxed text-muted">
          {displayBody(n)}
        </p>
      {/if}
      {#if n.kind === 'error' && n.errorDetail && hasUsefulDetails(errorHeadline(n.body), n.errorDetail)}
        {@render detailsBlock(`notification:${n.id}`, n.errorDetail)}
      {/if}
    </div>
    {#if n.kind === 'error'}
      <button
        class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed opacity-0 transition-opacity hover:bg-raised hover:text-foreground group-hover:opacity-100"
        aria-label="Copy error details and stack trace"
        title="Copy error details"
        onclick={(e: MouseEvent) => {
          e.stopPropagation()
          void copyNotificationError(n)
        }}
      >
        {#if copiedId === n.id}
          <CioCheck size={11} />
        {:else}
          <CioCopy size={11} />
        {/if}
      </button>
    {/if}
    <button
      class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed opacity-0 transition-opacity hover:bg-raised hover:text-foreground group-hover:opacity-100"
      aria-label="Dismiss notification"
      title="Dismiss"
      onclick={(e: MouseEvent) => {
        e.stopPropagation()
        dismiss(n)
      }}
    >
      <CioClose size={11} />
    </button>
  </div>
{/snippet}

{#snippet missedRunRow(run: MissedRun)}
  {@const active = busyId === run.id}
  <div
    class="group flex items-start gap-2 border-l-2 bg-surface px-3 py-2.5 {active
      ? 'opacity-60 pointer-events-none'
      : ''}"
    style="border-color: var(--color-missed)"
    role="group"
    onmouseenter={() => schedulePreload(ASSISTANT_SPACE_ID, run.threadId)}
    onmouseleave={cancelPreload}
  >
    <div class="flex w-2 shrink-0 pt-1">
      <StatusBadge tone="missed" title="Missed run" />
    </div>
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <span class="truncate text-[0.6875rem] font-medium text-foreground"
          >{missedRunTitle(run)}</span
        >
        <span class="shrink-0 text-[0.625rem] text-dimmed">{formatCompactAge(run.dueAt)}</span>
      </div>
      <p class="mt-0.5 line-clamp-2 text-[0.625rem] text-muted">
        {missedRunReasonText(run.reason)}
      </p>
    </div>
    <div class="flex shrink-0 items-center gap-1">
      <button
        class="px-1.5 py-1 text-[0.625rem] text-muted transition-colors hover:bg-raised hover:text-foreground"
        aria-label="Dismiss missed run"
        title="Dismiss"
        onclick={() => void dismissMissedRun(run.id)}
      >
        Dismiss
      </button>
      <button
        class="flex items-center gap-1 bg-primary px-1.5 py-1 text-[0.625rem] text-on-primary transition-colors hover:bg-primary-hover"
        aria-label="Run missed task now"
        title="Run now"
        onclick={() => void runMissedRunNow(run.id)}
      >
        <CioUndo size={11} strokeWidth={1.8} />
        Run now
      </button>
      <button
        class="flex h-6 w-6 items-center justify-center text-dimmed opacity-0 transition-opacity hover:bg-raised hover:text-foreground group-hover:opacity-100"
        aria-label="Open task"
        title="Open task"
        onclick={() => void openMissedRun(run.threadId)}
      >
        <CioSubagent size={11} />
      </button>
    </div>
  </div>
{/snippet}

{#snippet backgroundRunRow(run: BackgroundRun)}
  {@const active = busyId === run.runThreadId}
  <div
    class="group flex items-stretch border-l-2 bg-surface transition-colors hover:bg-elevated {active
      ? 'pointer-events-none opacity-60'
      : ''}"
    style="border-left-color: {STATUS_TONE_COLORS[backgroundRunTone(run.outcome)]}"
    role="group"
    onmouseenter={() => schedulePreload(ASSISTANT_SPACE_ID, run.runThreadId)}
    onmouseleave={cancelPreload}
  >
    <button
      type="button"
      class="flex min-w-0 flex-1 cursor-pointer items-start gap-2 px-3 py-2.5 text-left"
      title="Open this run"
      aria-label="Open unattended run for {backgroundRunTitle(run)}"
      onclick={() => void openBackgroundRun(run)}
    >
      <div class="flex w-2 shrink-0 pt-1">
        <StatusBadge
          tone={backgroundRunTone(run.outcome)}
          title={backgroundRunOutcomeLabel(run.outcome)}
        />
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="truncate text-[0.6875rem] font-medium text-foreground"
            >{backgroundRunTitle(run)}</span
          >
          <span class="shrink-0 text-[0.625rem] text-dimmed"
            >{formatCompactAge(run.settledAt ?? run.startedAt)}</span
          >
        </div>
        <p class="mt-0.5 text-[0.625rem] text-muted">
          {backgroundRunOutcomeLabel(run.outcome)} · {backgroundRunReasonText(run.reason)}
        </p>
        {#if run.outcome === 'failed' && run.errorSummary}
          <p class="mt-0.5 line-clamp-2 text-[0.625rem] text-danger">{run.errorSummary}</p>
        {/if}
        {#if run.autoAnswered > 0}
          <p class="mt-0.5 text-[0.625rem] text-dimmed">
            {run.autoAnswered} decision{run.autoAnswered === 1 ? '' : 's'} answered automatically
          </p>
        {/if}
      </div>
    </button>
    <div class="flex shrink-0 items-start px-1.5 pt-2">
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center text-dimmed opacity-0 transition-opacity hover:bg-raised hover:text-foreground group-hover:opacity-100"
        aria-label="Dismiss unattended run for {backgroundRunTitle(run)}"
        title="Dismiss"
        onclick={() => void dismissBackgroundRun(run.runThreadId)}
      >
        <CioClose size={11} />
      </button>
    </div>
  </div>
{/snippet}

{#snippet appErrorRow(e: AppErrorEntry)}
  <div
    class="group flex items-start gap-2 border-l-2 bg-surface px-3 py-2.5 transition-colors hover:bg-elevated {appErrorAccent(
      e.kind
    )}"
  >
    <span
      class="mt-1.5 h-1.5 w-1.5 shrink-0"
      style="background: {e.kind === 'error' ? 'var(--color-danger)' : 'var(--color-warning)'}"
      role="status"
      aria-label={appErrorLabel(e.kind)}
      title={appErrorLabel(e.kind)}
    ></span>
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <span
          class="shrink-0 text-[0.625rem] font-semibold uppercase tracking-wide {e.kind === 'error'
            ? 'text-danger'
            : 'text-warning'}"
        >
          {appErrorLabel(e.kind)}
        </span>
        <span class="shrink-0 text-[0.625rem] text-dimmed">
          {formatCompactAge(e.timestamp)}
          {#if e.count > 1}
            <span class="text-dimmed">· ×{e.count}</span>
          {/if}
        </span>
      </div>
      <p class="mt-0.5 select-text break-all font-mono text-[0.6875rem] leading-relaxed text-muted">
        {e.message}
      </p>
      {#if hasUsefulDetails(e.message, e.details) && e.details}
        {@render detailsBlock(`app:${e.id}`, e.details)}
      {/if}
    </div>
    <div class="flex shrink-0 items-center gap-0.5">
      <button
        class="flex h-6 w-6 items-center justify-center text-dimmed opacity-0 transition-opacity hover:bg-raised hover:text-foreground group-hover:opacity-100"
        aria-label={hasUsefulDetails(e.message, e.details)
          ? `Copy app error and stack trace: ${e.message}`
          : `Copy app error: ${e.message}`}
        title="Copy"
        onclick={(ev: MouseEvent) => {
          ev.stopPropagation()
          void copyError(e)
        }}
      >
        {#if copiedId === e.id}
          <CioCheck size={11} />
        {:else}
          <CioCopy size={11} />
        {/if}
      </button>
      <button
        class="flex h-6 w-6 items-center justify-center text-dimmed opacity-0 transition-opacity hover:bg-raised hover:text-foreground group-hover:opacity-100"
        aria-label="Dismiss app error"
        title="Dismiss"
        onclick={(ev: MouseEvent) => {
          ev.stopPropagation()
          appErrorState.dismiss(e.id)
        }}
      >
        <CioClose size={11} />
      </button>
    </div>
  </div>
{/snippet}

<div class="flex h-full flex-col">
  <!-- One list, narrowed by kind (chips) and by source (menu) -->
  <div class="flex shrink-0 items-center gap-0.5 border-b border-border px-2 py-1.5">
    {#each subFiltersFor(notificationPanelState.topTab) as sub (sub)}
      {@const count = subCount(notificationPanelState.topTab, sub)}
      {@const active = notificationPanelState.subFilter === sub}
      <button
        class="flex items-center gap-1.5 px-2 py-0.5 text-[0.6875rem] font-medium transition-colors {active
          ? 'bg-elevated text-foreground'
          : 'text-muted hover:bg-raised hover:text-foreground'}"
        aria-pressed={active}
        aria-label={`Show ${subFilterLabels[sub]} notifications`}
        title={`Show ${subFilterLabels[sub]} notifications`}
        onclick={() => notificationPanelState.setSubFilter(sub)}
      >
        {subFilterLabels[sub]}
        {#if count > 0}
          <span class="tabular-nums text-dimmed">{count}</span>
        {/if}
      </button>
    {/each}
    <div class="ml-auto flex items-center gap-0.5">
      {#if showingAssistants}
        <NotificationFilterMenu
          value={notificationPanelState.assistantSubject}
          options={assistantSubjectOptions}
          onValueChange={(next) => notificationPanelState.setAssistantSubject(next)}
          label="Filter assistant notifications by assistants or tasks"
          current={assistantSubjectLabel}
          narrowed={notificationPanelState.assistantSubject !== 'all'}
        />
      {/if}
      <NotificationFilterMenu
        value={notificationPanelState.topTab}
        options={sources}
        onValueChange={(next) => notificationPanelState.setSource(next)}
        label="Filter notifications by source"
        current={sourceLabel}
        narrowed={notificationPanelState.topTab !== 'all'}
      />
      {#if hasVisibleItems}
        <button
          class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          aria-label={showingAppErrors ? 'Dismiss all app errors' : 'Dismiss all notifications'}
          title={showingAppErrors ? 'Dismiss all errors' : 'Dismiss all'}
          onclick={dismissAll}
        >
          <CioClose size={12} />
        </button>
      {/if}
    </div>
  </div>

  <!-- Content -->
  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if !showingAppErrors && !showingAssistants}
      {#if feedRows.length === 0}
        <div class="flex h-full flex-col items-center justify-center gap-2 px-6">
          {#if notificationPanelState.subFilter === 'attention'}
            <CioAttention size={20} class="text-dimmed" />
            <p class="text-xs text-muted">Nothing needs attention</p>
          {:else}
            <CioNotifications size={20} class="text-dimmed" />
            <p class="text-xs text-muted">No notifications</p>
          {/if}
          {#if notificationPanelState.subFilter !== 'all' && subCount(notificationPanelState.topTab, 'all') > 0}
            <button
              class="px-2 py-0.5 text-[0.6875rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
              title="Show every kind of notification"
              aria-label="Show every kind of notification"
              onclick={() => notificationPanelState.setSubFilter('all')}
            >
              Show all
            </button>
          {/if}
        </div>
      {:else}
        <div class="space-y-1 p-1.5">
          {#each feedRows as row (row.id)}
            {#if row.kind === 'notice'}
              {@render notificationCard(row.notification, notificationPanelState.topTab === 'all')}
            {:else if row.kind === 'missed'}
              {@render missedRunRow(row.run)}
            {:else if row.kind === 'background'}
              {@render backgroundRunRow(row.run)}
            {:else}
              {@render appErrorRow(row.entry)}
            {/if}
          {/each}
        </div>
      {/if}
    {:else if showingAppErrors}
      {#if appErrorState.count === 0}
        <div class="flex h-full flex-col items-center justify-center gap-2 px-6">
          <CioDebugger size={20} class="text-dimmed" />
          <p class="text-xs text-muted">No app errors</p>
        </div>
      {:else}
        <div class="space-y-px p-1.5">
          {#each appErrorState.entries as e (e.id)}
            {@render appErrorRow(e)}
          {/each}
        </div>
      {/if}
    {:else if showingAssistants}
      {#if !assistantHasActivity}
        <div class="flex h-full flex-col items-center justify-center gap-2 px-6">
          <CioSubagent size={20} class="text-dimmed" />
          <p class="text-xs text-muted">No assistant activity</p>
        </div>
      {:else if assistantFilteredEmpty}
        <div class="flex h-full flex-col items-center justify-center gap-2 px-6">
          <CioNotifications size={20} class="text-dimmed" />
          <p class="text-xs text-muted">Nothing matches this filter</p>
          <button
            class="px-2 py-0.5 text-[0.6875rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
            title="Clear the assistant filters"
            aria-label="Clear the assistant filters"
            onclick={resetAssistantFilters}
          >
            Show all
          </button>
        </div>
      {:else}
        <div class="space-y-1 p-1.5">
          {#each assistantSections as section (section.key)}
            {@const collapsed = collapsedAssistantSections.has(section.key)}
            <div class="overflow-hidden border border-border bg-surface">
              <button
                type="button"
                class="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-elevated"
                aria-expanded={!collapsed}
                aria-label="{collapsed ? 'Expand' : 'Collapse'} {section.label}"
                title="{collapsed ? 'Expand' : 'Collapse'} {section.label}"
                onclick={() => toggleAssistantSection(section.key)}
              >
                <CioChevronDown
                  size={12}
                  class="shrink-0 text-dimmed transition-transform {collapsed ? '-rotate-90' : ''}"
                />
                <span
                  class="truncate text-[0.6875rem] font-semibold uppercase tracking-wide text-dimmed"
                  >{section.label}</span
                >
                <span class="ml-auto shrink-0 tabular-nums text-[0.625rem] text-dimmed"
                  >{section.items.length}</span
                >
                <span class="shrink-0 text-[0.625rem] text-dimmed"
                  >{formatCompactAge(section.latestAt)}</span
                >
              </button>
              {#if !collapsed}
                <div class="space-y-px border-t border-border pt-px">
                  {#each section.items as item (item.id)}
                    {#if item.kind === 'notice'}
                      {@render notificationCard(item.notification)}
                    {:else if item.kind === 'missed'}
                      {@render missedRunRow(item.run)}
                    {:else}
                      {@render backgroundRunRow(item.run)}
                    {/if}
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>
