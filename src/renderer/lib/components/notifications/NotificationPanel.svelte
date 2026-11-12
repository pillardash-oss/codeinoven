<script lang="ts">
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import CioDebugger from '@pdslng/cio-icon/CioDebugger.svelte'
  import CioNotifications from '@pdslng/cio-icon/CioNotifications.svelte'
  import CioSubagent from '@pdslng/cio-icon/CioSubagent.svelte'
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  import { formatCompactAge } from '$shared/date-time-format'
  import {
    notificationPanelState,
    type NotificationSourceFilter,
    type NotificationSubFilter,
    type InAppNotification
  } from '$lib/stores/notification-panel.svelte'
  import NotificationFilterMenu from './NotificationFilterMenu.svelte'
  import { appErrorState, errorHeadline, type AppErrorEntry } from '$lib/stores/app-errors.svelte'
  import { scopeState, STATUS_TONE_COLORS } from '$lib/stores/scope.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { assistants } from '$lib/stores/assistants.svelte'
  import {
    assistantSubjectName,
    backgroundRunOutcomeLabel,
    backgroundRunReasonText,
    backgroundRunTone,
    missedRunReasonText
  } from '$lib/components/assistant/assistant-view'
  import { SvelteSet } from 'svelte/reactivity'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { copyText } from '$lib/copy-text'
  import {
    ASSISTANT_SPACE_ID,
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
   * One row of the merged list, tagged with the moment it reports so the three
   * sources (a notice, a missed fire and an unattended run) read as one
   * newest-first list instead of separate sections.
   */
  type FeedRow =
    | { kind: 'notice'; id: string; at: number; notification: InAppNotification }
    | { kind: 'missed'; id: string; at: number; run: MissedRun }
    | { kind: 'background'; id: string; at: number; run: BackgroundRun }

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

  const filters: NotificationSubFilter[] = ['all', 'attention', 'done', 'spec', 'exceptions']

  const filterLabels: Record<NotificationSubFilter, string> = {
    all: 'All',
    attention: 'Attention',
    done: 'Done',
    spec: 'Spec',
    exceptions: 'Exceptions'
  }

  /** Exceptions are the app's own error log, kept apart from the notifications
   *  every other filter counts. */
  function filterCount(sub: NotificationSubFilter): number {
    return sub === 'exceptions' ? appErrorState.count : notificationPanelState.count(sub)
  }

  /**
   * The family menu beside the close button.
   *
   * Every kind shares one list now, so the list itself is the "all" case and
   * this menu only narrows it to projects, chats or assistants.
   */
  const sourceOptions: Array<{ id: NotificationSourceFilter; label: string; hint?: string }> = [
    { id: 'all', label: 'All families', hint: 'Projects, chats and assistants' },
    { id: 'projects', label: 'Projects only', hint: 'Project threads' },
    { id: 'chats', label: 'Chats only', hint: 'Conversations from the Inbox' },
    { id: 'assistants', label: 'Assistants only', hint: 'Assistant runs and scheduled tasks' }
  ]

  const sourceLabel = $derived(
    sourceOptions.find((option) => option.id === notificationPanelState.sourceFilter)?.label ??
      'All families'
  )

  /** Both narrowings returned to their defaults, so a list that reads empty for
   *  a filter the reader forgot about can be brought back in one click. */
  function resetFilters(): void {
    notificationPanelState.resetFilters()
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

  let showingExceptions = $derived(notificationPanelState.subFilter === 'exceptions')

  /**
   * The merged list: every notice the active filter admits, plus the assistant
   * store's missed fires and unattended runs, newest first. Exceptions are not
   * part of it; they render from the app's error log.
   */
  const feedRows = $derived.by<FeedRow[]>(() => {
    if (showingExceptions) return []
    const rows: FeedRow[] = []
    for (const n of notificationPanelState.visible) {
      rows.push({ kind: 'notice', id: `notice:${n.id}`, at: n.timestamp, notification: n })
    }
    for (const run of notificationPanelState.visibleMissedRuns) {
      rows.push({ kind: 'missed', id: `missed:${run.id}`, at: run.dueAt, run })
    }
    for (const run of notificationPanelState.visibleBackgroundRuns) {
      rows.push({
        kind: 'background',
        id: `background:${run.runThreadId}`,
        at: run.settledAt ?? run.startedAt,
        run
      })
    }
    return rows.sort((x, y) => y.at - x.at)
  })

  let hasVisibleItems = $derived(showingExceptions ? appErrorState.count > 0 : feedRows.length > 0)

  // Missed runs are surfaced per assistant: one group per owning assistant, plus a
  // single group for assistant-less tasks. Both the groups and the panel's tab
  // chrome exist only once at least one run has actually been missed.
  const assistantNameById = $derived(
    new Map(assistants.assistants.map((assistant) => [assistant.id, assistant.name]))
  )

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
    const sub = notificationPanelState.subFilter
    if (sub === 'exceptions') {
      appErrorState.dismissAll()
      return
    }
    if (sub === 'all' && notificationPanelState.sourceFilter === 'all') {
      // Everything goes in one pass: the notices the notification panel owns,
      // then the missed fires and unattended runs the assistant store owns.
      notificationPanelState.dismissAll()
      void dismissRunActivity()
      return
    }
    // Any narrower filter clears exactly the rows on screen, nothing hidden.
    for (const row of feedRows) {
      if (row.kind === 'notice') acknowledgeNotification(row.notification)
      else if (row.kind === 'missed') void dismissMissedRun(row.run.id)
      else void dismissBackgroundRun(row.run.runThreadId)
    }
  }

  /** Retire every missed fire and unattended run in one call. */
  async function dismissRunActivity(): Promise<void> {
    try {
      await assistants.dismissRunActivity()
    } catch {
      // The scheduler pushes its fresh lists on the next change; a failure here
      // simply leaves the rows on the list instead of clearing one that is
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
    if (!notificationPanelState.isAssistant(n) || n.kind !== 'completed') return n.body
    // A finished assistant run names the thread it ran, not the outcome. Notices
    // stored before the title was carried still say "Run completed", which is no
    // information at all, so they show nothing until the thread resolves.
    return runTask(n.threadId)?.title.trim() || (n.body === 'Run completed' ? '' : n.body)
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

{#snippet notificationCard(n: InAppNotification)}
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
  <!-- One list, narrowed by kind (chips) and by family (menu beside the close) -->
  <div class="flex shrink-0 items-center gap-0.5 border-b border-border px-2 py-1.5">
    {#each filters as sub (sub)}
      {@const count = filterCount(sub)}
      {@const active = notificationPanelState.subFilter === sub}
      <button
        class="flex items-center gap-1.5 px-2 py-0.5 text-[0.6875rem] font-medium transition-colors {active
          ? 'bg-elevated text-foreground'
          : 'text-muted hover:bg-raised hover:text-foreground'}"
        aria-pressed={active}
        aria-label={`Show ${filterLabels[sub]}`}
        title={`Show ${filterLabels[sub]}`}
        onclick={() => notificationPanelState.setSubFilter(sub)}
      >
        {filterLabels[sub]}
        {#if count > 0}
          <span class="tabular-nums text-dimmed">{count}</span>
        {/if}
      </button>
    {/each}
    <div class="ml-auto flex items-center gap-0.5">
      <NotificationFilterMenu
        value={notificationPanelState.sourceFilter}
        options={sourceOptions}
        onValueChange={(next) => notificationPanelState.setSourceFilter(next)}
        label="Filter notifications by projects, chats or assistants"
        current={sourceLabel}
        narrowed={notificationPanelState.sourceFilter !== 'all'}
      />
      {#if hasVisibleItems}
        <button
          class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          aria-label={showingExceptions ? 'Dismiss all exceptions' : 'Dismiss all notifications'}
          title={showingExceptions ? 'Dismiss all exceptions' : 'Dismiss all'}
          onclick={dismissAll}
        >
          <CioClose size={12} />
        </button>
      {/if}
    </div>
  </div>

  <!-- Content -->
  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if showingExceptions}
      {#if appErrorState.count === 0}
        <div class="flex h-full flex-col items-center justify-center gap-2 px-6">
          <CioDebugger size={20} class="text-dimmed" />
          <p class="text-xs text-muted">No exceptions</p>
        </div>
      {:else}
        <div class="space-y-px p-1.5">
          {#each appErrorState.entries as e (e.id)}
            {@render appErrorRow(e)}
          {/each}
        </div>
      {/if}
    {:else if feedRows.length === 0}
      <div class="flex h-full flex-col items-center justify-center gap-2 px-6">
        {#if notificationPanelState.subFilter === 'attention'}
          <CioAttention size={20} class="text-dimmed" />
          <p class="text-xs text-muted">Nothing needs attention</p>
        {:else}
          <CioNotifications size={20} class="text-dimmed" />
          <p class="text-xs text-muted">No notifications</p>
        {/if}
        {#if notificationPanelState.subFilter !== 'all' || notificationPanelState.sourceFilter !== 'all'}
          <button
            class="px-2 py-0.5 text-[0.6875rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
            title="Show every notification"
            aria-label="Show every notification"
            onclick={resetFilters}
          >
            Show all
          </button>
        {/if}
      </div>
    {:else}
      <div class="space-y-1 p-1.5">
        {#each feedRows as row (row.id)}
          {#if row.kind === 'notice'}
            {@render notificationCard(row.notification)}
          {:else if row.kind === 'missed'}
            {@render missedRunRow(row.run)}
          {:else}
            {@render backgroundRunRow(row.run)}
          {/if}
        {/each}
      </div>
    {/if}
  </div>
</div>
