<script lang="ts">
  import {
    Bell,
    Bot,
    Bug,
    Check,
    ChevronDown,
    Copy,
    MessageCircleDashed,
    MessageSquare,
    RotateCcw,
    X
  } from '@lucide/svelte'
  import {
    notificationPanelState,
    type NotificationSubFilter,
    type NotificationTopTab,
    type InAppNotification
  } from '$lib/stores/notification-panel.svelte'
  import { appErrorState, errorHeadline, type AppErrorEntry } from '$lib/stores/app-errors.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { assistantRoutines } from '$lib/stores/assistant-routines.svelte'
  import { groupMissedRunsByRoutine, missedRunReasonText } from '$lib/components/assistant/assistant-view'
  import { SvelteSet } from 'svelte/reactivity'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { copyText } from '$lib/copy-text'
  import { ASSISTANT_SPACE_ID, INBOX_PROJECT_ID } from '$shared/types'

  interface Props {
    onOpenThread?: (
      projectId: string,
      threadId: string,
      temporaryChatId?: string
    ) => void | Promise<void>
  }

  let { onOpenThread }: Props = $props()

  const topTabs: { key: NotificationTopTab; label: string }[] = [
    { key: 'projects', label: 'Projects' },
    { key: 'chats', label: 'Chats' },
    { key: 'assistants', label: 'Assistants' },
    { key: 'app-errors', label: 'App Errors' }
  ]

  const subFilterLabels: Record<NotificationSubFilter, string> = {
    all: 'All',
    done: 'Done',
    attention: 'Attention',
    spec: 'Spec',
    issues: 'Issues'
  }

  function subFiltersFor(tab: NotificationTopTab): NotificationSubFilter[] {
    switch (tab) {
      case 'projects':
        return ['all', 'done', 'attention', 'spec', 'issues']
      case 'chats':
        return ['all', 'done', 'attention', 'issues']
      // Assistants carry only missed runs, rendered straight from the assistant
      // store: no sub-filter tabs, and nothing at all until a run is missed.
      case 'assistants':
        return []
      case 'app-errors':
        return []
    }
  }

  function topTabCount(tab: NotificationTopTab): number {
    switch (tab) {
      case 'projects':
        return notificationPanelState.projectCount('all')
      case 'chats':
        return notificationPanelState.chatCount('all')
      case 'assistants':
        return notificationPanelState.assistantCount('all')
      case 'app-errors':
        return appErrorState.count
    }
  }

  function subCount(tab: NotificationTopTab, sub: NotificationSubFilter): number {
    switch (tab) {
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
  let hasVisibleItems = $derived(
    showingAppErrors
      ? appErrorState.count > 0
      : showingAssistants
        ? assistantRoutines.missedRuns.length > 0
        : notificationPanelState.visible.length > 0
  )

  // Missed runs are surfaced per routine: one group per owning routine, plus a
  // single group for routine-less tasks. Both the groups and the panel's tab
  // chrome exist only once at least one run has actually been missed.
  let missedGroups = $derived(
    groupMissedRunsByRoutine(
      assistantRoutines.missedRuns,
      new Map(assistantRoutines.routines.map((routine) => [routine.id, routine.name]))
    )
  )

  async function navigateToNotification(n: InAppNotification): Promise<void> {
    busyId = n.id
    try {
      if (onOpenThread) {
        await onOpenThread(n.projectId, n.threadId, n.temporaryChatId)
        notificationPanelState.dismiss(n.id)
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
      notificationPanelState.dismiss(n.id)
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
      await assistantRoutines.dismissMissedRun(id)
    } catch {
      // Surfaced as a missed run returning on the next refresh; nothing to do here.
    }
  }

  async function runMissedRunNow(id: string): Promise<void> {
    busyId = id
    try {
      const run = await assistantRoutines.runMissedRunNow(id)
      // Every run executes on its own fresh thread, so open that thread.
      if (run) await openMissedRun(run.id)
    } finally {
      busyId = null
    }
  }

  function dismissAll(): void {
    const tab = notificationPanelState.topTab
    if (tab === 'app-errors') {
      appErrorState.dismissAll()
      return
    }
    if (tab === 'assistants') return
    notificationPanelState.dismissTab(tab)
    contextSidebarState.hide()
  }

  async function copyError(e: AppErrorEntry): Promise<void> {
    try {
      await copyText(e.details ? `${e.message}\n\n${e.details}` : e.message)
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
      await copyText(notificationErrorText(n))
      copiedId = n.id
      window.setTimeout(() => {
        if (copiedId === n.id) copiedId = null
      }, 1500)
    } catch {
      // Clipboard unavailable; nothing to surface here
    }
  }

  function kindAccent(kind: InAppNotification['kind']): string {
    switch (kind) {
      case 'completed':
        return 'border-l-success/40'
      case 'chat-completed':
        return 'border-l-chat-success/50'
      case 'attention':
        return 'border-l-warning/40'
      case 'spec':
        return 'border-l-thread-spec/40'
      case 'error':
        return 'border-l-danger/40'
    }
  }

  function kindLabel(kind: InAppNotification['kind']): string {
    switch (kind) {
      case 'completed':
        return 'Project complete'
      case 'chat-completed':
        return 'Chat response available'
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

  function formatTime(ts: number): string {
    const diff = Date.now() - ts
    const seconds = Math.floor(diff / 1000)
    if (seconds < 60) return 'just now'
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
  }
</script>

{#snippet detailsBlock(key: string, details: string)}
  {@const expanded = !collapsedDetails.has(key)}
  {@const stackFrames = hasStackFrames(details)}
  {@const label = expanded
    ? `Hide ${stackFrames ? 'stack trace' : 'details'}`
    : `Show ${stackFrames ? 'stack trace' : 'details'}`}
  <button
    class="mt-1.5 flex items-center gap-1 rounded px-1 py-0.5 text-[0.625rem] font-medium text-dimmed transition-colors hover:bg-raised hover:text-foreground"
    aria-expanded={expanded}
    aria-label={label}
    title={label}
    onclick={(event: MouseEvent) => {
      event.stopPropagation()
      toggleDetails(key)
    }}
  >
    <ChevronDown
      size={10}
      class={expanded ? 'rotate-180 transition-transform' : 'transition-transform'}
    />
    {stackFrames ? 'Stack trace' : 'Details'}
  </button>
  {#if expanded}
    <pre
      class="mt-1 max-h-40 select-text overflow-auto rounded border border-border bg-overlay p-2 font-mono text-[0.6875rem] leading-relaxed break-all whitespace-pre-wrap text-muted">{details}</pre>
  {/if}
{/snippet}

<div class="flex h-full flex-col">
  <!-- Top-level tabs -->
  <div
    class="flex shrink-0 items-center gap-1 border-b border-border px-2 pt-1.5"
    role="tablist"
    aria-label="Notification sections"
  >
    {#each topTabs as tab (tab.key)}
      {@const count = topTabCount(tab.key)}
      {@const active = notificationPanelState.topTab === tab.key}
      <button
        class="-mb-px flex items-center gap-1.5 border-b-2 px-2 py-1.5 text-xs font-medium transition-colors {active
          ? 'border-foreground text-foreground'
          : 'border-transparent text-muted hover:text-foreground'}"
        role="tab"
        aria-selected={active}
        aria-label={`Show ${tab.label} notifications`}
        title={`Show ${tab.label} notifications`}
        onclick={() => notificationPanelState.setTab(tab.key)}
      >
        {tab.label}
        {#if count > 0}
          <span class="tabular-nums text-dimmed">{count}</span>
        {/if}
      </button>
    {/each}
    <div class="ml-auto pb-1.5">
      {#if hasVisibleItems && !showingAssistants}
        <button
          class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          aria-label={showingAppErrors ? 'Dismiss all app errors' : 'Dismiss all notifications'}
          title={showingAppErrors ? 'Dismiss all errors' : 'Dismiss all'}
          onclick={dismissAll}
        >
          <X size={12} />
        </button>
      {/if}
    </div>
  </div>

  <!-- Sub filters -->
  {#if subFiltersFor(notificationPanelState.topTab).length > 0}
    <div class="flex shrink-0 items-center gap-0.5 border-b border-border px-2 py-1">
      {#each subFiltersFor(notificationPanelState.topTab) as sub (sub)}
        {@const count = subCount(notificationPanelState.topTab, sub)}
        {@const active = notificationPanelState.subFilter === sub}
        <button
          class="flex items-center gap-1.5 rounded px-2 py-0.5 text-[0.6875rem] font-medium transition-colors {active
            ? 'bg-elevated text-foreground'
            : 'text-muted hover:bg-raised hover:text-foreground'}"
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
    </div>
  {/if}

  <!-- Content -->
  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if showingAppErrors}
      {#if appErrorState.count === 0}
        <div class="flex h-full flex-col items-center justify-center gap-2 px-6">
          <Bug size={20} class="text-dimmed" />
          <p class="text-xs text-muted">No app errors</p>
        </div>
      {:else}
        <div class="space-y-px p-1.5">
          {#each appErrorState.entries as e (e.id)}
            <div
              class="group flex items-start gap-2 border-l-2 bg-surface px-3 py-2.5 transition-colors hover:bg-elevated {appErrorAccent(
                e.kind
              )}"
            >
              <span
                class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                style="background: {e.kind === 'error'
                  ? 'var(--color-danger)'
                  : 'var(--color-warning)'}"
                role="status"
                aria-label={appErrorLabel(e.kind)}
                title={appErrorLabel(e.kind)}
              ></span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span
                    class="shrink-0 text-[0.625rem] font-semibold uppercase tracking-wide {e.kind ===
                    'error'
                      ? 'text-danger'
                      : 'text-warning'}"
                  >
                    {appErrorLabel(e.kind)}
                  </span>
                  <span class="shrink-0 text-[0.625rem] text-dimmed">
                    {formatTime(e.timestamp)}
                    {#if e.count > 1}
                      <span class="text-dimmed">· ×{e.count}</span>
                    {/if}
                  </span>
                </div>
                <p
                  class="mt-0.5 select-text break-all font-mono text-[0.6875rem] leading-relaxed text-muted"
                >
                  {e.message}
                </p>
                {#if hasUsefulDetails(e.message, e.details) && e.details}
                  {@render detailsBlock(`app:${e.id}`, e.details)}
                {/if}
              </div>
              <div class="flex shrink-0 items-center gap-0.5">
                <button
                  class="flex h-6 w-6 items-center justify-center rounded text-dimmed opacity-0 transition-opacity hover:bg-raised hover:text-foreground group-hover:opacity-100"
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
                    <Check size={11} />
                  {:else}
                    <Copy size={11} />
                  {/if}
                </button>
                <button
                  class="flex h-6 w-6 items-center justify-center rounded text-dimmed opacity-0 transition-opacity hover:bg-raised hover:text-foreground group-hover:opacity-100"
                  aria-label="Dismiss app error"
                  title="Dismiss"
                  onclick={(ev: MouseEvent) => {
                    ev.stopPropagation()
                    appErrorState.dismiss(e.id)
                  }}
                >
                  <X size={11} />
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {:else if showingAssistants}
      {#if assistantRoutines.missedRuns.length === 0}
        <div class="flex h-full flex-col items-center justify-center gap-2 px-6">
          <Bot size={20} class="text-dimmed" />
          <p class="text-xs text-muted">No missed runs</p>
        </div>
      {:else}
        {#each missedGroups as group (group.key)}
          <div class="pb-1.5">
            <div
              class="px-3 pt-2 pb-1 text-[0.5625rem] font-medium tracking-wide text-dimmed uppercase"
            >
              {group.label}
            </div>
            <div class="space-y-px" aria-label={`${group.label} missed runs`}>
              {#each group.runs as run (run.id)}
                {@const active = busyId === run.id}
                <div
                  class="group flex items-start gap-2 border-l-2 bg-surface px-3 py-2.5 {active
                    ? 'opacity-60 pointer-events-none'
                    : ''}"
                  style="border-color: var(--color-missed)"
                >
                  <div class="flex w-2 shrink-0 pt-1">
                    <StatusBadge tone="missed" title="Missed run" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="truncate text-[0.6875rem] font-medium text-foreground"
                        >{run.title}</span
                      >
                      <span class="shrink-0 text-[0.625rem] text-dimmed"
                        >{formatTime(run.dueAt)}</span
                      >
                    </div>
                    <p class="mt-0.5 line-clamp-2 text-[0.625rem] text-muted">
                      {missedRunReasonText(run.reason)}
                    </p>
                  </div>
                  <div class="flex shrink-0 items-center gap-1">
                    <button
                      class="rounded px-1.5 py-1 text-[0.625rem] text-muted transition-colors hover:bg-raised hover:text-foreground"
                      aria-label="Dismiss missed run"
                      title="Dismiss"
                      onclick={() => void dismissMissedRun(run.id)}
                    >
                      Dismiss
                    </button>
                    <button
                      class="flex items-center gap-1 rounded bg-primary px-1.5 py-1 text-[0.625rem] text-on-primary transition-colors hover:bg-primary-hover"
                      aria-label="Run missed task now"
                      title="Run now"
                      onclick={() => void runMissedRunNow(run.id)}
                    >
                      <RotateCcw size={11} strokeWidth={1.8} />
                      Run now
                    </button>
                    <button
                      class="flex h-6 w-6 items-center justify-center rounded text-dimmed opacity-0 transition-opacity hover:bg-raised hover:text-foreground group-hover:opacity-100"
                      aria-label="Open task"
                      title="Open task"
                      onclick={() => void openMissedRun(run.threadId)}
                    >
                      <Bot size={11} />
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/each}
      {/if}
    {:else if notificationPanelState.visible.length === 0}
      <div class="flex h-full flex-col items-center justify-center gap-2 px-6">
        <Bell size={20} class="text-dimmed" />
        <p class="text-xs text-muted">No notifications</p>
      </div>
    {:else}
      <div class="space-y-px p-1.5">
        {#each notificationPanelState.visible as n (n.id)}
          {@const active = busyId === n.id}
          <div
            class="group flex cursor-pointer items-start gap-2 border-l-2 bg-surface px-3 py-2.5 transition-colors hover:bg-elevated {kindAccent(
              n.kind
            )} {active ? 'opacity-60 pointer-events-none' : ''}"
            role="button"
            tabindex="0"
            aria-label={`${kindLabel(n.kind)}: ${n.title}. Click to navigate to thread`}
            title={`${n.title}${n.body ? `   ${n.body}` : ''}`}
            onclick={() => void navigateToNotification(n)}
            onkeydown={(e: KeyboardEvent) => {
              // Ignore keys that belong to a nested control (the stack-trace
              // toggle), which would otherwise navigate away on Enter.
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                void navigateToNotification(n)
              }
            }}
          >
            <div class="flex w-2 shrink-0 pt-1">
              <StatusBadge kind={n.kind} title={kindLabel(n.kind)} />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate text-[0.6875rem] font-medium text-foreground">{n.title}</span>
                <span class="shrink-0 text-[0.625rem] text-dimmed">{formatTime(n.timestamp)}</span>
              </div>
              <div class="mt-1 flex items-center gap-1 text-[0.625rem] text-dimmed">
                {#if n.source === 'chat'}
                  <MessageSquare size={10} class="shrink-0" />
                  <span>Chat</span>
                {:else}
                  <span
                    class="h-1.5 w-1.5 shrink-0 rounded-full"
                    style="background: {n.projectColor ?? 'var(--color-border)'}"
                    role="presentation"
                  ></span>
                  <span class="truncate"
                    >{n.projectId === INBOX_PROJECT_ID ? 'Chat' : n.projectName}</span
                  >
                  {#if n.source === 'temporary-chat'}
                    <span class="shrink-0">·</span>
                    <MessageCircleDashed
                      size={10}
                      class="shrink-0 text-info"
                      title="Temporary chat"
                      aria-hidden="true"
                    />
                  {/if}
                {/if}
              </div>
              {#if n.body}
                <p class="mt-0.5 line-clamp-2 text-[0.6875rem] leading-relaxed text-muted">
                  {n.body}
                </p>
              {/if}
              {#if n.kind === 'error' && n.errorDetail && hasUsefulDetails(errorHeadline(n.body), n.errorDetail)}
                {@render detailsBlock(`notification:${n.id}`, n.errorDetail)}
              {/if}
            </div>
            {#if n.kind === 'error'}
              <button
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed opacity-0 transition-opacity hover:bg-raised hover:text-foreground group-hover:opacity-100"
                aria-label="Copy error details and stack trace"
                title="Copy error details"
                onclick={(e: MouseEvent) => {
                  e.stopPropagation()
                  void copyNotificationError(n)
                }}
              >
                {#if copiedId === n.id}
                  <Check size={11} />
                {:else}
                  <Copy size={11} />
                {/if}
              </button>
            {/if}
            <button
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed opacity-0 transition-opacity hover:bg-raised hover:text-foreground group-hover:opacity-100"
              aria-label="Dismiss notification"
              title="Dismiss"
              onclick={(e: MouseEvent) => {
                e.stopPropagation()
                dismiss(n)
              }}
            >
              <X size={11} />
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
