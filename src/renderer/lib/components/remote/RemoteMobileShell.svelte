<script lang="ts">
  import { onMount } from 'svelte'
  import { DropdownMenu, AlertDialog, Dialog } from 'bits-ui'
  import {
    Bell,
    BrainCircuit,
    Check,
    ChevronDown,
    Download,
    FolderKanban,
    GitBranch,
    History,
    Loader2,
    MessageSquare,
    MoreVertical,
    PanelLeft,
    Pencil,
    Pin,
    PinOff,
    GitFork,
    Power,
    Share,
    Timeline,
    Trash2,
    X
  } from '@lucide/svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import ThreadDropdown, { type MenuItem } from '$lib/components/shared/ThreadDropdown.svelte'
  import { mobileNotifications } from '$lib/remote/mobile-notifications.svelte'
  import { pwaInstall } from '$lib/remote/pwa-install.svelte'
  import { subscribe } from '$lib/ipc.svelte'
  import { getProjectIcon } from '$lib/project-icons'
  import { mobileState } from '$lib/remote/mobile-state.svelte'
  import type { Thread } from '$shared/types'

  const SIDEBAR_MODES = [
    { id: 'projects', label: 'Projects', icon: FolderKanban },
    { id: 'threads', label: 'Threads', icon: Timeline },
    { id: 'chats', label: 'Chats', icon: MessageSquare }
  ] as const

  interface Props {
    onDisconnect?: () => void
    /** Called once the shell is connected and mounted — the app root uses it
     *  to sync the desktop theme through the bridge. */
    onConnected?: () => void
  }

  let { onDisconnect = () => undefined, onConnected = () => undefined }: Props = $props()

  // ─── Viewport height (visual viewport accounts for the phone keyboard) ──
  let viewportHeight = $state<number | null>(null)

  onMount(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const sync = (): void => {
      viewportHeight = viewport.height
    }
    sync()
    viewport.addEventListener('resize', sync)
    viewport.addEventListener('scroll', sync)
    return () => {
      viewport.removeEventListener('resize', sync)
      viewport.removeEventListener('scroll', sync)
    }
  })

  let shellHeight = $derived(viewportHeight === null ? '100dvh' : `${viewportHeight}px`)

  // ─── Rename / delete dialogs ────────────────────────────────────────────
  let renameTarget = $state<Thread | null>(null)
  let renameValue = $state('')
  let renameBusy = $state(false)
  let renameError = $state('')
  let deleteTarget = $state<Thread | null>(null)
  let deleteBusy = $state(false)
  let deleteError = $state('')

  async function confirmRename(): Promise<void> {
    const target = renameTarget
    const name = renameValue.trim()
    if (!target || !name || renameBusy) return
    renameBusy = true
    renameError = ''
    try {
      await mobileState.handleRename(target, name)
      renameTarget = null
    } catch (error) {
      renameError = error instanceof Error ? error.message : 'Could not rename the thread.'
    } finally {
      renameBusy = false
    }
  }

  async function confirmDelete(): Promise<void> {
    const target = deleteTarget
    if (!target || deleteBusy) return
    deleteBusy = true
    deleteError = ''
    try {
      await mobileState.handleDelete(target)
      deleteTarget = null
    } catch (error) {
      deleteError = error instanceof Error ? error.message : 'Could not delete the thread.'
    } finally {
      deleteBusy = false
    }
  }

  function openRename(thread: Thread): void {
    renameValue = thread.title
    renameTarget = thread
  }

  function openDelete(thread: Thread): void {
    deleteError = ''
    deleteTarget = thread
  }

  // ─── Row action menus ───────────────────────────────────────────────────
  function threadMenuItems(thread: Thread): MenuItem[] {
    return [
      {
        label: 'Rename',
        icon: Pencil,
        onClick: () => openRename(thread)
      },
      {
        label: thread.pinned ? 'Unpin' : 'Pin',
        icon: thread.pinned ? PinOff : Pin,
        onClick: () => void mobileState.togglePin(thread)
      },
      {
        label: 'Fork',
        icon: GitFork,
        onClick: () => void mobileState.forkThread(thread)
      },
      { label: '', divider: true },
      {
        label: 'Delete',
        icon: Trash2,
        danger: true,
        onClick: () => openDelete(thread)
      }
    ]
  }

  function folderThreads(projectId: string): Thread[] {
    return mobileState.threadsByProject.get(projectId) ?? []
  }

  function folderWorking(projectId: string): boolean {
    return folderThreads(projectId).some((thread) => mobileState.isWorking(thread))
  }

  function threadDot(thread: Thread): string {
    if (thread.status === 'failed') return 'bg-thread-error'
    if (thread.status === 'awaiting_approval') return 'bg-thread-pinned'
    if (thread.status === 'working-paused') return 'bg-warning'
    if (thread.status === 'spec') return 'bg-thread-spec'
    if (mobileState.isWorking(thread)) return 'bg-thread-working'
    if (!thread.read) return 'bg-thread-unread'
    if (thread.status === 'completed') return 'bg-thread-done'
    return 'bg-thread-done/40'
  }

  function relativeTime(ts: number): string {
    const diff = Date.now() - ts
    const minutes = Math.floor(diff / 60_000)
    if (minutes < 1) return 'now'
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h`
    const days = Math.floor(hours / 24)
    if (days < 7) return `${days}d`
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  function historyJump(messageId: string, content: string): void {
    mobileState.historyJump(messageId, content)
  }

  onMount(() => {
    onConnected()
    void mobileState.loadData()
    const unsubscribeThreadUpdates = subscribe('thread:updated', (...args: unknown[]) => {
      const updated = args[0] as Thread
      if (updated) mobileState.applyThreadUpdate(updated)
    })
    const unsubscribeThreadDeleted = subscribe('thread:deleted', (_projectId, threadId) => {
      mobileState.applyThreadDeletion(threadId)
    })
    mobileNotifications.init()
    mobileNotifications.setOpenHandler(
      (projectId, threadId) => void mobileState.openThreadById(projectId, threadId)
    )
    void mobileNotifications.maybePrompt()
    const onServiceWorkerMessage = (event: MessageEvent): void => {
      const record = event.data
      if (record?.type === 'notification:open' && record.projectId && record.threadId) {
        void mobileState.openThreadById(String(record.projectId), String(record.threadId))
      }
    }
    navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage)
    return () => {
      unsubscribeThreadUpdates()
      unsubscribeThreadDeleted()
      navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage)
      mobileNotifications.setOpenHandler(null)
    }
  })

  let activeSidebarMode = $derived(SIDEBAR_MODES.find((m) => m.id === mobileState.sidebarMode))

  let showInstall = $derived(!pwaInstall.installed)

  /** Touch/phone browsers install from the browser menu rather than the address bar. */
  let isTouchDevice = $derived(
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  )

  async function handleInstall(): Promise<void> {
    const outcome = await pwaInstall.install()
    if (outcome === 'unsupported') mobileState.installGuideOpen = true
  }
</script>

<div
  class="mobile-shell flex w-full flex-col overflow-hidden bg-app text-foreground"
  style="height: {shellHeight}"
>
  {#if deleteError}
    <div
      class="fixed left-1/2 top-[max(1rem,env(safe-area-inset-top))] z-60 flex w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 items-start gap-3 rounded-xl border border-danger/30 bg-surface px-4 py-3 text-sm text-danger shadow-xl"
      role="alert"
    >
      <p class="min-w-0 flex-1 leading-5">{deleteError}</p>
      <button
        type="button"
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-danger hover:bg-danger/10"
        title="Dismiss delete error"
        aria-label="Dismiss delete error"
        onclick={() => (deleteError = '')}
      >
        <X size={15} />
      </button>
    </div>
  {/if}

  <!-- Header: menu · centred thread title · overflow menu -->
  <div class="shrink-0 border-b border-border bg-surface pt-[env(safe-area-inset-top)]">
    <header class="grid h-14 grid-cols-[2.75rem_1fr_2.75rem] items-center gap-1 px-2">
      <button
        type="button"
        class="flex h-11 w-11 cursor-pointer items-center justify-center rounded-xl text-muted transition-colors active:bg-elevated"
        aria-label="Open the sidebar"
        title="Open the sidebar"
        onclick={() => (mobileState.sidebarOpen = true)}
      >
        <PanelLeft size={19} />
      </button>

      <div class="min-w-0 px-1 text-center">
        <p class="truncate text-[14px] font-semibold tracking-tight">
          {mobileState.selectedThread?.title ?? 'CodeInOven'}
        </p>
        {#if mobileState.selectedProject && mobileState.selectedThread && !mobileState.chatMode}
          <p class="truncate text-[11px] text-dimmed">{mobileState.selectedProject.name}</p>
        {/if}
      </div>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          class="relative flex h-11 w-11 cursor-pointer items-center justify-center rounded-xl text-muted transition-colors active:bg-elevated"
          aria-label="More options"
          title="More options"
        >
          <MoreVertical size={19} />
          {#if mobileState.hasOverflowAttention}
            <span class="absolute top-1.5 right-1.5 flex items-start">
              <span class="h-2 w-2 rounded-full bg-thread-pinned"></span>
            </span>
          {/if}
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="bottom"
            align="end"
            sideOffset={6}
            collisionPadding={8}
            class="z-50 w-56 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-xl"
          >
            <DropdownMenu.Item
              class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-[14px] text-muted outline-none transition-colors hover:bg-elevated focus:bg-elevated hover:text-foreground"
              disabled={mobileState.userMessages.length === 0}
              onSelect={() => (mobileState.historyOpen = true)}
            >
              <History size={16} />
              <span class="flex-1 text-left">Message history</span>
            </DropdownMenu.Item>

            <DropdownMenu.Item
              class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-[14px] text-muted outline-none transition-colors hover:bg-elevated focus:bg-elevated hover:text-foreground"
              onSelect={() => (mobileState.memoryOpen = true)}
            >
              <BrainCircuit size={16} />
              <span class="flex-1 text-left">Memory</span>
            </DropdownMenu.Item>

            {#if mobileState.selectedThread && !mobileState.chatMode}
              <DropdownMenu.Item
                class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-[14px] text-muted outline-none transition-colors hover:bg-elevated focus:bg-elevated hover:text-foreground"
                onSelect={() => (mobileState.gitOpen = true)}
              >
                <GitBranch size={16} />
                <span class="flex-1 text-left">Git</span>
              </DropdownMenu.Item>
            {/if}

            <DropdownMenu.Item
              class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-[14px] text-muted outline-none transition-colors hover:bg-elevated focus:bg-elevated hover:text-foreground"
              onSelect={() => (mobileState.notificationsOpen = true)}
            >
              <Bell size={16} />
              <span class="flex-1 text-left">Notifications</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </header>
  </div>

  <!-- Conversation — the mobile transcript, lazy-loaded. -->
  <main class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    {#if mobileState.selectedThread}
      {#key mobileState.selectedThread.id}
        {#await import('./RemoteConversation.svelte') then { default: RemoteConversation }}
          <RemoteConversation
            thread={mobileState.selectedThread}
            chatMode={mobileState.chatMode}
            jumpTarget={mobileState.jumpTarget}
          />
        {/await}
      {/key}
    {:else}
      <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div class="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface">
          <MessageSquare size={24} class="text-primary" />
        </div>
        <p class="text-[15px] font-medium">Select a thread</p>
        <p class="max-w-64 text-[13px] leading-relaxed text-dimmed">
          Open the sidebar to browse your projects and conversations.
        </p>
        <button
          type="button"
          class="mt-1 flex h-11 cursor-pointer items-center gap-2 rounded-xl bg-primary px-5 text-[14px] font-medium text-on-primary transition-colors active:bg-primary-hover"
          onclick={() => (mobileState.sidebarOpen = true)}
        >
          <PanelLeft size={15} />
          Open sidebar
        </button>
      </div>
    {/if}
  </main>

  <!-- History jump sheet. -->
  {#if mobileState.historyOpen}
    <div
      class="fixed inset-0 z-40 cursor-pointer bg-black/50"
      role="presentation"
      onclick={() => (mobileState.historyOpen = false)}
    ></div>
    <aside
      class="fixed right-0 bottom-0 left-0 z-50 flex max-h-[72dvh] flex-col overflow-hidden rounded-t-2xl border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-2xl"
      aria-label="Jump to message"
    >
      <div class="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-dimmed">
          Your messages
        </p>
        <button
          type="button"
          class="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors active:bg-elevated"
          aria-label="Close history"
          title="Close history"
          onclick={() => (mobileState.historyOpen = false)}
        >
          <X size={16} />
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
        {#each mobileState.userMessages as message, index (message.id)}
          <button
            type="button"
            class="block w-full cursor-pointer truncate rounded-lg px-3 py-3 text-left text-[14px] text-muted transition-colors active:bg-elevated"
            title={message.content}
            onclick={() => historyJump(message.id, message.content)}
          >
            <span class="mr-1.5 tabular-nums text-dimmed">{index + 1}.</span>
            {message.content}
          </button>
        {:else}
          <p class="px-3 py-8 text-center text-[13px] text-dimmed">No messages yet</p>
        {/each}
      </div>
    </aside>
  {/if}

  <!-- Notifications sheet — the panel lazy-loads at open time. -->
  {#if mobileState.notificationsOpen}
    <div
      class="fixed inset-0 z-40 cursor-pointer bg-black/50"
      role="presentation"
      onclick={() => (mobileState.notificationsOpen = false)}
    ></div>
    <aside
      class="fixed right-0 bottom-0 left-0 z-50 flex max-h-[82dvh] flex-col overflow-hidden rounded-t-2xl border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-2xl"
      aria-label="Notifications"
    >
      <div class="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-dimmed">
          Notifications
        </p>
        <button
          type="button"
          class="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors active:bg-elevated"
          aria-label="Close notifications"
          title="Close notifications"
          onclick={() => (mobileState.notificationsOpen = false)}
        >
          <X size={16} />
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div class="border-b border-border/60 px-4 py-3">
          <Switch
            checked={mobileNotifications.enabled}
            disabled={mobileNotifications.permission === 'unsupported'}
            onchange={(enabled) => {
              if (enabled) {
                void mobileNotifications.enable()
              } else {
                mobileNotifications.disable()
              }
            }}
            label="System notifications"
            aria-label="System notifications"
          />
          {#if mobileNotifications.permission === 'denied'}
            <p class="mt-1.5 text-[11px] leading-relaxed text-dimmed">
              Notifications are blocked for this site. Allow them in your browser's site settings.
            </p>
          {:else if mobileNotifications.permission === 'unsupported'}
            <p class="mt-1.5 text-[11px] leading-relaxed text-dimmed">
              System notifications are not supported on this browser.
            </p>
          {:else}
            <p class="mt-1.5 text-[11px] leading-relaxed text-dimmed">
              Get a system alert when a thread wants your attention, even when the app is in the
              background.
            </p>
          {/if}
        </div>
        {#await import('$lib/components/notifications/NotificationPanel.svelte') then { default: NotificationPanel }}
          <NotificationPanel />
        {/await}
      </div>
    </aside>
  {/if}

  <!-- Memory sheet — the desktop panel lazy-loads at open time. -->
  {#if mobileState.memoryOpen}
    <div
      class="fixed inset-0 z-40 cursor-pointer bg-black/50"
      role="presentation"
      onclick={() => (mobileState.memoryOpen = false)}
    ></div>
    <aside
      class="fixed right-0 bottom-0 left-0 z-50 flex max-h-[82dvh] flex-col overflow-hidden rounded-t-2xl border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-2xl"
      aria-label="Memory"
    >
      <div class="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-dimmed">Memory</p>
        <button
          type="button"
          class="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors active:bg-elevated"
          aria-label="Close memory"
          title="Close memory"
          onclick={() => (mobileState.memoryOpen = false)}
        >
          <X size={16} />
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        {#await import('$lib/components/memory/MemoryPanel.svelte') then { default: MemoryPanel }}
          <MemoryPanel
            variant="sidebar"
            projectId={mobileState.selectedThread?.projectId ?? mobileState.selectedProject?.id}
            threadId={mobileState.selectedThread?.id}
            allowTransfer={false}
          />
        {/await}
      </div>
    </aside>
  {/if}

  <!-- Git sheet — the desktop panel lazy-loads at open time. -->
  {#if mobileState.gitOpen && mobileState.selectedThread && !mobileState.chatMode}
    <div
      class="fixed inset-0 z-40 cursor-pointer bg-black/50"
      role="presentation"
      onclick={() => (mobileState.gitOpen = false)}
    ></div>
    <aside
      class="fixed right-0 bottom-0 left-0 z-50 flex h-[85dvh] flex-col overflow-hidden rounded-t-2xl border-t border-border bg-app pb-[env(safe-area-inset-bottom)] shadow-2xl"
      aria-label="Git"
    >
      <div
        class="flex h-12 shrink-0 items-center justify-between border-b border-border bg-surface px-4"
      >
        <p
          class="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-dimmed"
        >
          <GitBranch size={13} />
          Git
        </p>
        <button
          type="button"
          class="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors active:bg-elevated"
          aria-label="Close git"
          title="Close git"
          onclick={() => (mobileState.gitOpen = false)}
        >
          <X size={16} />
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-hidden">
        {#await import('$lib/components/git/GitStatusPanel.svelte') then { default: GitStatusPanel }}
          <GitStatusPanel
            projectId={mobileState.selectedThread.projectId}
            threadId={mobileState.selectedThread.id}
          />
        {/await}
      </div>
    </aside>
  {/if}

  <!-- Sidebar drawer. -->
  {#if mobileState.sidebarOpen}
    <div
      class="fixed inset-0 z-50 cursor-pointer bg-black/50"
      role="presentation"
      onclick={() => (mobileState.sidebarOpen = false)}
    ></div>
    <aside
      class="fixed top-0 bottom-0 left-0 z-50 flex w-[86vw] max-w-88 flex-col border-r border-border bg-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-2xl"
      aria-label="Sidebar"
    >
      <div class="flex h-14 shrink-0 items-center gap-0.5 border-b border-border px-2">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class="flex h-11 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-xl px-2.5 text-left transition-colors active:bg-elevated"
            aria-label="Switch sidebar view"
            title="Switch sidebar view"
          >
            {#if activeSidebarMode}
              {@const ActiveIcon = activeSidebarMode.icon}
              <ActiveIcon size={16} class="shrink-0 text-muted" />
            {/if}
            <span class="truncate text-[15px] font-semibold tracking-tight">
              {activeSidebarMode?.label ?? 'Projects'}
            </span>
            <ChevronDown size={15} class="shrink-0 text-dimmed" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="bottom"
              align="start"
              sideOffset={6}
              collisionPadding={8}
              class="z-50 w-48 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-xl"
            >
              {#each SIDEBAR_MODES as entry (entry.id)}
                {@const Icon = entry.icon}
                <DropdownMenu.Item
                  class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-[14px] outline-none transition-colors hover:bg-elevated focus:bg-elevated {mobileState.sidebarMode ===
                  entry.id
                    ? 'text-foreground'
                    : 'text-muted'}"
                  onSelect={() => (mobileState.sidebarMode = entry.id)}
                >
                  <Icon size={15} class="shrink-0 text-muted" />
                  <span class="flex-1 text-left">{entry.label}</span>
                  {#if mobileState.sidebarMode === entry.id}
                    <Check size={15} class="text-primary" />
                  {/if}
                </DropdownMenu.Item>
              {/each}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        <button
          type="button"
          class="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-muted transition-colors active:bg-elevated"
          aria-label="Close the sidebar"
          title="Close the sidebar"
          onclick={() => (mobileState.sidebarOpen = false)}
        >
          <X size={18} />
        </button>
      </div>

      <!-- Sidebar content -->
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
        {#if mobileState.loading}
          <div class="flex items-center gap-2 px-3 py-4 text-[14px] text-muted">
            <Loader2 size={15} class="animate-spin" />
            Loading…
          </div>
        {:else if mobileState.loadError}
          <div class="flex flex-col items-start gap-3 px-3 py-4">
            <div>
              <p class="text-[13px] font-medium text-foreground">Could not load the workspace</p>
              <p class="mt-1 text-[12px] leading-relaxed text-dimmed">
                The desktop connection dropped before projects were loaded.
              </p>
            </div>
            <button
              type="button"
              class="h-9 cursor-pointer rounded-lg bg-primary px-3 text-[12px] font-semibold text-on-primary transition-colors active:bg-primary-hover"
              onclick={() => void mobileState.loadData()}
            >
              Try again
            </button>
          </div>
        {:else if mobileState.sidebarMode === 'projects'}
          <!-- Pinned threads above everything. -->
          {#if mobileState.pinnedThreads.length > 0}
            <div class="mb-1 px-2">
              {#each mobileState.pinnedThreads as thread (thread.id)}
                <div class="flex items-center gap-0.5">
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors active:bg-elevated {mobileState
                      .selectedThread?.id === thread.id
                      ? 'bg-elevated'
                      : ''} {mobileState.isWorking(thread) ? 'animate-pulse bg-thread-working/5' : ''}"
                    title={thread.title}
                    onclick={() => void mobileState.openThread(thread)}
                  >
                    <span class={`h-2 w-2 shrink-0 rounded-full ${threadDot(thread)}`}></span>
                    <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">
                      {thread.title}
                    </span>
                    <span class="shrink-0 text-[10px] text-dimmed"
                      >{relativeTime(thread.createdAt)}</span
                    >
                  </button>
                  <ThreadDropdown
                    items={threadMenuItems(thread)}
                    ariaLabel={`Actions for ${thread.title}`}
                    vertical
                  />
                </div>
              {/each}
            </div>
          {/if}

          {#each mobileState.visibleProjects as project (project.id)}
            {@const iconUrl = getProjectIcon(project, mobileState.projectIcons.get(project.id))}
            {@const expanded = mobileState.expandedFolders.has(project.id)}
            {@const working = folderWorking(project.id)}
            <div class="mb-0.5">
              <button
                type="button"
                class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors active:bg-elevated"
                title={project.name}
                onclick={() => mobileState.toggleFolder(project.id)}
              >
                {#if iconUrl}
                  <img src={iconUrl} alt="" class="h-4 w-4 shrink-0 rounded object-contain" />
                {:else}
                  <span class="h-4 w-4 shrink-0 rounded bg-elevated"></span>
                {/if}
                <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">
                  {project.name}
                </span>
                {#if working}
                  <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-thread-working"></span>
                {/if}
                <ChevronDown
                  size={14}
                  class={`shrink-0 text-dimmed transition-transform ${expanded ? 'rotate-180' : ''}`}
                />
              </button>
              {#if expanded}
                <div class="ml-2 space-y-px py-0.5">
                  {#each folderThreads(project.id) as thread (thread.id)}
                    <div class="flex items-center gap-0.5">
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors active:bg-elevated {mobileState
                          .selectedThread?.id === thread.id
                          ? 'bg-elevated'
                          : ''} {mobileState.isWorking(thread)
                          ? 'animate-pulse bg-thread-working/5'
                          : ''}"
                        title={thread.title}
                        onclick={() => void mobileState.openThread(thread)}
                      >
                        <span class={`h-2 w-2 shrink-0 rounded-full ${threadDot(thread)}`}></span>
                        <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">
                          {thread.title}
                        </span>
                        <span class="shrink-0 text-[10px] text-dimmed"
                          >{relativeTime(thread.createdAt)}</span
                        >
                      </button>
                      <ThreadDropdown
                        items={threadMenuItems(thread)}
                        ariaLabel={`Actions for ${thread.title}`}
                        vertical
                      />
                    </div>
                  {:else}
                    <p class="px-2 py-1.5 text-[12px] text-dimmed">No threads yet</p>
                  {/each}
                </div>
              {/if}
            </div>
          {:else}
            <div class="flex flex-col items-center gap-2 px-2 py-12 text-center">
              <p class="text-[13px] text-muted">No projects yet</p>
              <p class="text-[13px] text-dimmed">Add a project on the desktop to get started</p>
            </div>
          {/each}
        {:else if mobileState.sidebarMode === 'threads'}
          <div class="space-y-px">
            {#each mobileState.flatThreads as thread (thread.id)}
              {@const project = mobileState.projects.find((p) => p.id === thread.projectId)}
              {@const iconUrl = project
                ? getProjectIcon(project, mobileState.projectIcons.get(project.id))
                : null}
              <div class="flex items-center gap-0.5">
                <button
                  type="button"
                  class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors active:bg-elevated {mobileState
                    .selectedThread?.id === thread.id
                    ? 'bg-elevated'
                    : ''} {mobileState.isWorking(thread) ? 'animate-pulse bg-thread-working/5' : ''}"
                  title={thread.title}
                  onclick={() => void mobileState.openThread(thread)}
                >
                  {#if iconUrl}
                    <img src={iconUrl} alt="" class="h-3.5 w-3.5 shrink-0 rounded object-contain" />
                  {/if}
                  <span class={`h-2 w-2 shrink-0 rounded-full ${threadDot(thread)}`}></span>
                  <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">
                    {thread.title}
                  </span>
                  <span class="shrink-0 text-[10px] text-dimmed"
                    >{relativeTime(thread.createdAt)}</span
                  >
                </button>
                <ThreadDropdown
                  items={threadMenuItems(thread)}
                  ariaLabel={`Actions for ${thread.title}`}
                  vertical
                />
              </div>
            {:else}
              <p class="px-2 py-12 text-center text-[13px] text-dimmed">No threads yet</p>
            {/each}
          </div>
        {:else}
          <!-- Chats — the standalone inbox conversations. -->
          <div class="space-y-px">
            {#each mobileState.chatThreads as thread (thread.id)}
              <div class="flex items-center gap-0.5">
                <button
                  type="button"
                  class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors active:bg-elevated {mobileState
                    .selectedThread?.id === thread.id
                    ? 'bg-elevated'
                    : ''} {mobileState.isWorking(thread) ? 'animate-pulse bg-thread-working/5' : ''}"
                  title={thread.title}
                  onclick={() => void mobileState.openThread(thread)}
                >
                  <span class={`h-2 w-2 shrink-0 rounded-full ${threadDot(thread)}`}></span>
                  <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">
                    {thread.title}
                  </span>
                  <span class="shrink-0 text-[10px] text-dimmed"
                    >{relativeTime(thread.createdAt)}</span
                  >
                </button>
                <ThreadDropdown
                  items={threadMenuItems(thread)}
                  ariaLabel={`Actions for ${thread.title}`}
                  vertical
                />
              </div>
            {:else}
              <div class="flex flex-col items-center gap-2 px-2 py-12 text-center">
                <MessageSquare size={20} class="text-dimmed" />
                <p class="text-[13px] text-muted">No chats yet</p>
                <p class="text-[13px] text-dimmed">Start a chat on the desktop to see it here</p>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Sidebar footer: install (until added to the home screen) + disconnect. -->
      <div class="shrink-0 border-t border-border p-2">
        <div class="flex gap-2">
          {#if showInstall}
            <button
              type="button"
              class="flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl bg-primary text-[14px] font-medium text-on-primary transition-colors active:bg-primary-hover"
              title="Install CodeInOven on this device"
              onclick={() => void handleInstall()}
            >
              <Download size={15} />
              Install
            </button>
          {/if}
          <button
            type="button"
            class="flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl bg-elevated text-[14px] font-medium text-muted transition-colors active:bg-danger/10 active:text-danger"
            title="Disconnect from the desktop"
            onclick={onDisconnect}
          >
            <Power size={15} />
            Disconnect
          </button>
        </div>
      </div>
    </aside>
  {/if}

  <!-- iOS "Add to Home Screen" guide sheet. -->
  {#if mobileState.installGuideOpen}
    <div
      class="fixed inset-0 z-40 cursor-pointer bg-black/50"
      role="presentation"
      onclick={() => (mobileState.installGuideOpen = false)}
    ></div>
    <aside
      class="fixed right-0 bottom-0 left-0 z-50 flex max-h-[82dvh] flex-col overflow-hidden rounded-t-2xl border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-2xl"
      aria-label="Install CodeInOven"
    >
      <div class="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-dimmed">
          Install CodeInOven
        </p>
        <button
          type="button"
          class="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors active:bg-elevated"
          aria-label="Close install guide"
          title="Close install guide"
          onclick={() => (mobileState.installGuideOpen = false)}
        >
          <X size={16} />
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">
        <p class="text-[14px] leading-relaxed text-foreground">
          Install CodeInOven for a full-screen app icon and notifications that work in the
          background.
        </p>
        {#if pwaInstall.isIos}
          <ol class="mt-4 space-y-4">
            <li class="flex items-start gap-3">
              <span
                class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-elevated text-[12px] font-semibold text-primary"
                >1</span
              >
              <span class="min-w-0 flex-1 text-[13px] leading-relaxed text-muted">
                Tap the <span class="text-foreground">Share</span> button in Safari's toolbar.
              </span>
            </li>
            <li class="flex items-start gap-3">
              <span
                class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-elevated text-[12px] font-semibold text-primary"
                >2</span
              >
              <span class="min-w-0 flex-1 text-[13px] leading-relaxed text-muted">
                Choose <span class="text-foreground">Add to Home Screen</span>.
              </span>
            </li>
            <li class="flex items-start gap-3">
              <span
                class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-elevated text-[12px] font-semibold text-primary"
                >3</span
              >
              <span class="min-w-0 flex-1 text-[13px] leading-relaxed text-muted">
                Tap <span class="text-foreground">Add</span>. CodeInOven opens like its own app.
              </span>
            </li>
          </ol>
        {:else if isTouchDevice}
          <ol class="mt-4 space-y-4">
            <li class="flex items-start gap-3">
              <span
                class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-elevated text-[12px] font-semibold text-primary"
                >1</span
              >
              <span class="min-w-0 flex-1 text-[13px] leading-relaxed text-muted">
                Open the browser menu — the <span class="text-foreground">⋮</span> (or ⋯) button.
              </span>
            </li>
            <li class="flex items-start gap-3">
              <span
                class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-elevated text-[12px] font-semibold text-primary"
                >2</span
              >
              <span class="min-w-0 flex-1 text-[13px] leading-relaxed text-muted">
                Choose <span class="text-foreground">Install app</span> or
                <span class="text-foreground">Add to Home screen</span>.
              </span>
            </li>
            <li class="flex items-start gap-3">
              <span
                class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-elevated text-[12px] font-semibold text-primary"
                >3</span
              >
              <span class="min-w-0 flex-1 text-[13px] leading-relaxed text-muted">
                Confirm <span class="text-foreground">Install</span>. CodeInOven opens like its own
                app.
              </span>
            </li>
          </ol>
        {:else}
          <ol class="mt-4 space-y-4">
            <li class="flex items-start gap-3">
              <span
                class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-elevated text-[12px] font-semibold text-primary"
                >1</span
              >
              <span class="min-w-0 flex-1 text-[13px] leading-relaxed text-muted">
                Click the <span class="text-foreground">install icon</span> in the browser's address bar.
              </span>
            </li>
            <li class="flex items-start gap-3">
              <span
                class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-elevated text-[12px] font-semibold text-primary"
                >2</span
              >
              <span class="min-w-0 flex-1 text-[13px] leading-relaxed text-muted">
                If there's no icon, open the browser menu and choose
                <span class="text-foreground">Install CodeInOven</span>.
              </span>
            </li>
            <li class="flex items-start gap-3">
              <span
                class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-elevated text-[12px] font-semibold text-primary"
                >3</span
              >
              <span class="min-w-0 flex-1 text-[13px] leading-relaxed text-muted">
                Confirm <span class="text-foreground">Install</span>. CodeInOven opens like its own
                app.
              </span>
            </li>
          </ol>
        {/if}
        <div class="mt-5 flex items-start gap-2.5 rounded-xl bg-elevated px-3.5 py-3">
          <Share size={14} class="mt-0.5 shrink-0 text-primary" />
          <p class="text-[12px] leading-relaxed text-muted">
            Open the installed icon going forward — the install button here disappears once it's
            added.
          </p>
        </div>
      </div>
    </aside>
  {/if}

  <!-- Rename thread dialog (bits-ui Dialog — no desktop modal graph). -->
  <Dialog.Root
    open={renameTarget !== null}
    onOpenChange={(open) => {
      if (!open) renameTarget = null
    }}
  >
    <Dialog.Portal>
      <Dialog.Overlay class="fixed inset-0 z-50 cursor-pointer bg-overlay/70" />
      <Dialog.Content
        class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl outline-none"
      >
        <Dialog.Title class="text-sm font-semibold text-foreground">Rename Thread</Dialog.Title>
        <Dialog.Description class="sr-only">Change the title of this thread.</Dialog.Description>
        <form
          class="mt-4 space-y-3"
          onsubmit={(event: SubmitEvent) => {
            event.preventDefault()
            void confirmRename()
          }}
        >
          <div>
            <label class="mb-1 block text-xs font-medium text-muted" for="mobile-rename-input"
              >Title</label
            >
            <input
              id="mobile-rename-input"
              type="text"
              class="w-full cursor-text rounded-lg border border-border bg-elevated px-3 py-2 text-sm text-foreground outline-none placeholder:text-dimmed focus:border-primary"
              bind:value={renameValue}
            />
          </div>
          {#if renameError}
            <p class="text-xs text-danger">{renameError}</p>
          {/if}
        </form>
        <div class="mt-5 flex justify-end gap-2">
          <button
            type="button"
            class="cursor-pointer rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
            onclick={() => (renameTarget = null)}
          >
            Cancel
          </button>
          <button
            type="button"
            class="cursor-pointer rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
            disabled={!renameValue.trim() || renameBusy}
            onclick={() => void confirmRename()}
          >
            {renameBusy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>

  <!-- Delete thread confirmation. -->
  <AlertDialog.Root
    open={deleteTarget !== null}
    onOpenChange={(open) => {
      if (!open && !deleteBusy) deleteTarget = null
    }}
  >
    <AlertDialog.Portal>
      <AlertDialog.Overlay class="fixed inset-0 z-50 bg-overlay/70" />
      <AlertDialog.Content
        class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
      >
        <AlertDialog.Title class="text-sm font-semibold text-foreground">
          Delete thread?
        </AlertDialog.Title>
        <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
          <span class="font-medium text-foreground">{deleteTarget?.title ?? 'This thread'}</span>
          and all of its history will be permanently deleted. This cannot be undone.
        </AlertDialog.Description>
        <div class="mt-5 flex justify-end gap-2">
          <AlertDialog.Cancel
            class="h-8 cursor-pointer rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
          >
            Cancel
          </AlertDialog.Cancel>
          <AlertDialog.Action
            class="h-8 cursor-pointer rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
            disabled={deleteBusy}
            onclick={() => void confirmDelete()}
          >
            {deleteBusy ? 'Deleting…' : 'Delete'}
          </AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>
</div>
