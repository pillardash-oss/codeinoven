<script lang="ts">
  import { Bell, Bug, Check, Copy, X } from '@lucide/svelte'
  import {
    notificationPanelState,
    type NotificationFilter,
    type InAppNotification
  } from '$lib/stores/notification-panel.svelte'
  import { appErrorState, type AppErrorEntry } from '$lib/stores/app-errors.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { copyText } from '$lib/copy-text'

  const filters: { key: NotificationFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'attention', label: 'Attention' },
    { key: 'spec', label: 'Spec' },
    { key: 'error', label: 'Errors' },
    { key: 'completed', label: 'Done' },
    { key: 'chat-completed', label: 'Chats' },
    { key: 'app-errors', label: 'App errors' }
  ]

  let busyId = $state<string | null>(null)
  let copiedId = $state<string | null>(null)

  let showingAppErrors = $derived(notificationPanelState.filter === 'app-errors')
  let hasVisibleItems = $derived(
    showingAppErrors ? appErrorState.count > 0 : notificationPanelState.notifications.length > 0
  )

  async function navigateToNotification(n: InAppNotification): Promise<void> {
    busyId = n.id
    try {
      const [project, thread] = await Promise.all([
        invoke('project:get', n.projectId),
        invoke('thread:get', n.projectId, n.threadId)
      ])
      if (!project || !thread) return
      await workspaceState.openThreadFromNotification?.(thread, project)
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

  function dismissAll(): void {
    if (showingAppErrors) {
      appErrorState.dismissAll()
    } else {
      notificationPanelState.dismissAll()
      contextSidebarState.hide()
    }
  }

  async function copyError(e: AppErrorEntry): Promise<void> {
    try {
      await copyText(e.message)
      copiedId = e.id
      window.setTimeout(() => {
        if (copiedId === e.id) copiedId = null
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

<div class="flex h-full flex-col">
  <!-- Filter bar -->
  <div class="flex shrink-0 items-center gap-0.5 border-b border-border px-2 py-1.5">
    {#each filters as f (f.key)}
      <button
        class="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium transition-colors {notificationPanelState.filter ===
        f.key
          ? 'bg-foreground text-app'
          : 'text-muted hover:bg-elevated hover:text-foreground'}"
        aria-label={`Show ${f.label} notifications`}
        title={`Show ${f.label} notifications`}
        onclick={() => notificationPanelState.setFilter(f.key)}
      >
        {f.label}
        {#if f.key === 'all'}
          {#if notificationPanelState.totalCount > 0}
            <span class="tabular-nums text-dimmed">{notificationPanelState.totalCount}</span>
          {/if}
        {:else if f.key === 'completed' && notificationPanelState.completedCount > 0}
          <span class="tabular-nums text-dimmed">{notificationPanelState.completedCount}</span>
        {:else if f.key === 'chat-completed' && notificationPanelState.chatCompletedCount > 0}
          <span class="tabular-nums text-dimmed">{notificationPanelState.chatCompletedCount}</span>
        {:else if f.key === 'attention' && notificationPanelState.attentionCount > 0}
          <span class="tabular-nums text-dimmed">{notificationPanelState.attentionCount}</span>
        {:else if f.key === 'spec' && notificationPanelState.specCount > 0}
          <span class="tabular-nums text-dimmed">{notificationPanelState.specCount}</span>
        {:else if f.key === 'error' && notificationPanelState.errorCount > 0}
          <span class="tabular-nums text-dimmed">{notificationPanelState.errorCount}</span>
        {:else if f.key === 'app-errors' && appErrorState.count > 0}
          <span class="tabular-nums text-dimmed">{appErrorState.count}</span>
        {/if}
      </button>
    {/each}
    <div class="ml-auto">
      {#if hasVisibleItems}
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
                    class="shrink-0 text-[10px] font-semibold uppercase tracking-wide {e.kind ===
                    'error'
                      ? 'text-danger'
                      : 'text-warning'}"
                  >
                    {appErrorLabel(e.kind)}
                  </span>
                  <span class="shrink-0 text-[10px] text-dimmed">
                    {formatTime(e.timestamp)}
                    {#if e.count > 1}
                      <span class="text-dimmed">· ×{e.count}</span>
                    {/if}
                  </span>
                </div>
                <p
                  class="mt-0.5 select-text break-all font-mono text-[11px] leading-relaxed text-muted"
                >
                  {e.message}
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-0.5">
                <button
                  class="flex h-6 w-6 items-center justify-center rounded text-dimmed opacity-0 transition-opacity hover:bg-raised hover:text-foreground group-hover:opacity-100"
                  aria-label={`Copy app error: ${e.message}`}
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
    {:else if notificationPanelState.notifications.length === 0}
      <div class="flex h-full flex-col items-center justify-center gap-2 px-6">
        <Bell size={20} class="text-dimmed" />
        <p class="text-xs text-muted">No notifications</p>
      </div>
    {:else}
      <div class="space-y-px p-1.5">
        {#each notificationPanelState.notifications as n (n.id)}
          {@const active = busyId === n.id}
          <div
            class="group flex cursor-pointer items-start gap-2 border-l-2 bg-surface px-3 py-2.5 transition-colors hover:bg-elevated {kindAccent(
              n.kind
            )} {active ? 'opacity-60 pointer-events-none' : ''}"
            role="button"
            tabindex="0"
            aria-label={`${kindLabel(n.kind)}: ${n.title}. Click to navigate to thread`}
            title={`${n.title}${n.body ? ` — ${n.body}` : ''}`}
            onclick={() => void navigateToNotification(n)}
            onkeydown={(e: KeyboardEvent) => {
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
                <span class="truncate text-[11px] font-medium text-foreground">{n.title}</span>
                <span class="shrink-0 text-[10px] text-dimmed">{formatTime(n.timestamp)}</span>
              </div>
              {#if n.body}
                <p class="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted">
                  {n.body}
                </p>
              {/if}
            </div>
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
