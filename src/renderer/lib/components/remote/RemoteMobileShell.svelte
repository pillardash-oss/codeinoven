<script lang="ts">
  import { onMount } from 'svelte'
  import { AlertDialog, Dialog } from 'bits-ui'
  import {
    Bell,
    BrainCircuit,
    ChevronDown,
    Download,
    FolderKanban,
    GitBranch,
    History,
    Info,
    Loader2,
    MessageSquare,
    MessageSquareDashed,
    MoreVertical,
    StickyNote,
    PanelLeft,
    Pencil,
    Pin,
    PinOff,
    Plus,
    Search,
    GitFork,
    Power,
    Share,
    Timeline,
    Trash2,
    X
  } from '@lucide/svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import BottomSheet from '$lib/components/ui/BottomSheet.svelte'
  import ActionSheet from '$lib/components/ui/ActionSheet.svelte'
  import type { MenuItem } from '$lib/components/shared/ThreadDropdown.svelte'
  import MessageHistoryPanel from '$lib/components/shared/MessageHistoryPanel.svelte'
  import { mobileNotifications } from '$lib/remote/mobile-notifications.svelte'
  import { pwaInstall } from '$lib/remote/pwa-install.svelte'
  import { resetPwaCacheAndReload } from '$lib/remote/reset-pwa-cache'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { getProjectIcon } from '$lib/project-icons'
  import { mobileState } from '$lib/remote/mobile-state.svelte'
  import { threadMessages } from '$lib/stores/thread-messages.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import { toast } from 'svelte-sonner'
  import { INBOX_PROJECT_ID, type Thread, type ThreadSearchResult } from '$shared/types'

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

  let shellHeight = $derived(
    viewportHeight !== null && viewportHeight > 150 ? `${viewportHeight}px` : '100dvh'
  )

  /**
   * Retry token for lazy feature chunks. Passing this value into each retryable
   * import keeps the `{#await}` reactive, so bumping it re-runs the load. A
   * rejected import most often means the installed PWA holds a cached shell
   * referencing chunk hashes a rebuilt desktop no longer serves; re-importing
   * the same hash cannot succeed, so the panel's recovery path resets the PWA
   * cache and reloads instead.
   */
  let chunkRetry = $state(0)

  /** Re-run the loader whenever the caller is re-evaluated with a new attempt. */
  function retryableChunk<T>(attempt: number, load: () => Promise<T>): Promise<T> {
    return load()
  }

  // ─── Rename / delete dialogs ────────────────────────────────────────────
  let renameTarget = $state<Thread | null>(null)
  let renameValue = $state('')
  let renameBusy = $state(false)
  let renameError = $state('')
  let deleteTarget = $state<Thread | null>(null)
  let deleteBusy = $state(false)
  let deleteError = $state('')
  // Which thread's action menu is open — drives the shared bottom-sheet action menu.
  let actionMenuThread = $state<Thread | null>(null)
  // Sidebar Projects/Threads/Chats mode picker.
  let modeMenuOpen = $state(false)
  // Header overflow menu (history/memory/git/sources/notes/notifications).
  let headerMenuOpen = $state(false)
  let searchQuery = $state('')
  let searchResults = $state<ThreadSearchResult[]>([])
  let searching = $state(false)
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let searchRequest = 0

  let mobileNoteTab = $derived.by(() => {
    const thread = mobileState.selectedThread
    if (!thread) return null
    const id = `note:${thread.projectId}:${thread.id}`
    const tab = contextSidebarState.tabs.find((candidate) => candidate.id === id)
    return tab?.kind === 'thread-note' ? tab : null
  })

  function openNotes(): void {
    const thread = mobileState.selectedThread
    if (!thread) return
    contextSidebarState.activateThread(thread.projectId, thread.id, thread.title)
    contextSidebarState.openThreadNote(thread.projectId, thread.id, thread.title, {
      edit: true,
      focusEditor: true
    })
    mobileState.notesOpen = true
  }

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

  function searchThreads(query: string): void {
    searchQuery = query
    clearTimeout(searchTimer)
    const request = ++searchRequest
    const normalized = query.trim()
    if (normalized.length < 2) {
      searchResults = []
      searching = false
      return
    }
    searching = true
    searchTimer = setTimeout(() => {
      void invoke('threads:search', normalized, { limit: 50 })
        .then((results) => {
          if (request !== searchRequest) return
          searchResults = results
          searching = false
        })
        .catch(() => {
          if (request !== searchRequest) return
          searchResults = []
          searching = false
        })
    }, 140)
  }

  let visibleSearchResults = $derived(
    searchResults.filter(({ thread }) =>
      mobileState.sidebarMode === 'chats'
        ? thread.projectId === INBOX_PROJECT_ID
        : thread.projectId !== INBOX_PROJECT_ID
    )
  )

  async function createProjectThread(projectId: string): Promise<void> {
    const project = mobileState.projects.find((candidate) => candidate.id === projectId)
    if (!project) return
    try {
      await mobileState.createProjectThread(project)
      mobileState.sidebarOpen = false
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The thread could not be created.')
    }
  }

  async function createChat(): Promise<void> {
    try {
      await mobileState.createChat()
      mobileState.sidebarOpen = false
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The chat could not be created.')
    }
  }

  /** Open the sidebar, defaulting to the view that matches the open thread
   *  (chats for a chat, threads for a project thread) so the last state we
   *  left the switcher in never gets lost across opens. */
  function openSidebar(): void {
    const thread = mobileState.selectedThread
    if (thread) {
      mobileState.sidebarMode = thread.projectId === INBOX_PROJECT_ID ? 'chats' : 'threads'
    }
    mobileState.sidebarOpen = true
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

  function headerMenuItems(): MenuItem[] {
    const thread = mobileState.selectedThread
    return [
      {
        label: 'Git',
        icon: GitBranch,
        disabled: !thread || mobileState.chatMode,
        onClick: () => (mobileState.gitOpen = true)
      },
      {
        label: 'Notifications',
        icon: Bell,
        onClick: () => (mobileState.notificationsOpen = true)
      },
      {
        label: 'Message history',
        icon: History,
        onClick: () => (mobileState.historyOpen = true)
      },
      {
        label: 'Sources',
        icon: Info,
        disabled: !thread,
        onClick: () => (mobileState.sourcesOpen = true)
      },
      {
        label: 'Memory',
        icon: BrainCircuit,
        onClick: () => (mobileState.memoryOpen = true)
      },
      ...(mobileState.temporaryChatTabId
        ? [
            {
              label: 'Temporary chat',
              icon: MessageSquareDashed,
              onClick: () => (mobileState.temporaryChatOpen = true)
            }
          ]
        : []),
      {
        label: 'Notes',
        icon: StickyNote,
        disabled: !thread,
        onClick: openNotes
      }
    ]
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

  async function openNotificationThread(projectId: string, threadId: string): Promise<void> {
    await mobileState.openThreadById(projectId, threadId)
    mobileState.notificationsOpen = false
  }

  onMount(() => {
    onConnected()
    const initialDataLoad = mobileState.loadData()
    const unsubscribeThreadUpdates = subscribe('thread:updated', (...args: unknown[]) => {
      const updated = args[0] as Thread
      if (updated) mobileState.applyThreadUpdate(updated)
    })
    const unsubscribeThreadDeleted = subscribe('thread:deleted', (_projectId, threadId) => {
      mobileState.applyThreadDeletion(threadId)
    })
    mobileNotifications.init()
    mobileNotifications.setOpenHandler((projectId, threadId) => {
      void initialDataLoad.then(() => openNotificationThread(projectId, threadId))
    })
    void mobileNotifications.maybePrompt()
    return () => {
      unsubscribeThreadUpdates()
      unsubscribeThreadDeleted()
      mobileNotifications.setOpenHandler(null)
      clearTimeout(searchTimer)
    }
  })

  let activeSidebarMode = $derived(SIDEBAR_MODES.find((m) => m.id === mobileState.sidebarMode))
  let selectedThreadWorking = $derived(
    mobileState.selectedThread ? mobileState.isWorking(mobileState.selectedThread) : false
  )
  /** The real project whose thread is currently open — used to scope a new thread. */
  let activeThreadProject = $derived(
    mobileState.selectedProject && mobileState.selectedProject.id !== INBOX_PROJECT_ID
      ? mobileState.selectedProject
      : null
  )
  const modeMenuItems = $derived(
    SIDEBAR_MODES.map((entry) => ({
      label: entry.label,
      icon: entry.icon,
      selected: mobileState.sidebarMode === entry.id,
      onClick: () => {
        mobileState.sidebarMode = entry.id
      }
    }))
  )

  // Keep the git branch indicator current for whichever project is open.
  $effect(() => {
    gitState.notifyThreadOpened(mobileState.selectedProject)
  })

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
  <!-- Working indicator for a thread row in the sidebar: a spinner while the
       thread is actively running, otherwise its status dot. -->
  {#snippet threadStatusDot(item: Thread)}
    {#if mobileState.isWorking(item)}
      <Loader2 size={13} class="shrink-0 animate-spin text-thread-working" />
    {:else}
      <span class={`h-2 w-2 shrink-0 rounded-full ${threadDot(item)}`}></span>
    {/if}
  {/snippet}

  <!-- Shared lazy-chunk failure state: any rejected dynamic import below
       renders this instead of staying silently blank. The phone most often
       hits this when the desktop rebuilt while the installed PWA still cached
       the previous shell, so "Try again" resets the stale cache and reloads a
       fresh shell rather than re-importing a chunk hash that no longer exists. -->
  {#snippet chunkFailure()}
    <div class="flex min-h-40 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      <p class="max-w-[16rem] text-[13px] leading-relaxed text-muted">
        This panel could not load. If it keeps failing, the desktop may have been updated.
      </p>
      <button
        type="button"
        class="h-9 cursor-pointer rounded-lg bg-primary px-4 text-[13px] font-medium text-on-primary transition-colors active:bg-primary-hover"
        title="Reload this panel"
        aria-label="Reload this panel"
        onclick={() => void resetPwaCacheAndReload()}
      >
        Try again
      </button>
    </div>
  {/snippet}
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
    <header class="grid h-14 grid-cols-[2.75rem_1fr_auto] items-center gap-1 px-2">
      <button
        type="button"
        class="flex h-11 w-11 cursor-pointer items-center justify-center rounded-xl text-muted transition-colors active:bg-elevated"
        aria-label="Open the sidebar"
        title="Open the sidebar"
        onclick={openSidebar}
      >
        <PanelLeft size={19} />
      </button>

      <div class="min-w-0 px-1 text-center">
        <p class="truncate text-[14px] font-semibold tracking-tight">
          {mobileState.selectedThread?.title ?? 'CodeInOven'}
        </p>
        {#if mobileState.selectedThread && ((mobileState.selectedProject && !mobileState.chatMode) || selectedThreadWorking)}
          <p class="flex items-center justify-center gap-1 truncate text-[11px] text-dimmed">
            {#if mobileState.selectedProject && !mobileState.chatMode}
              <span class="truncate">{mobileState.selectedProject.name}</span>
              {#if gitState.branch}
                <span class="shrink-0">·</span>
                <span class="flex shrink-0 items-center gap-0.5">
                  <GitBranch size={10} />
                  <span class="max-w-24 truncate">{gitState.branch}</span>
                </span>
              {/if}
            {/if}
            {#if selectedThreadWorking}
              {#if mobileState.selectedProject && !mobileState.chatMode}
                <span class="shrink-0">·</span>
              {/if}
              <span
                class="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 {mobileState
                  .selectedThread.status === 'working-paused'
                  ? 'bg-warning/10 text-warning'
                  : 'bg-info/10 text-info'}"
              >
                <Loader2 size={9} class="animate-spin" />
                {mobileState.selectedThread.status === 'working-paused'
                  ? 'Waiting to retry'
                  : 'Working'}
              </span>
            {/if}
          </p>
        {/if}
      </div>

      <div class="flex items-center">
        {#if mobileState.selectedThread}
          {@const usagePercent = mobileState.selectedThread.contextUsage?.contextPercent}
          <button
            type="button"
            class="flex h-11 w-9 cursor-pointer items-center justify-center rounded-xl text-muted transition-colors active:bg-elevated"
            aria-label={usagePercent === undefined
              ? 'Context usage unavailable'
              : `Context usage — ${Math.round(usagePercent)}% used`}
            title="Context usage"
            onclick={() => (mobileState.usageOpen = true)}
          >
            <span
              class="relative h-3 w-6 rounded-sm border border-current p-0.5"
              aria-hidden="true"
            >
              <span
                class="block h-full rounded-[1px] {usagePercent === undefined
                  ? 'bg-overlay'
                  : usagePercent >= 90
                    ? 'bg-danger'
                    : usagePercent >= 70
                      ? 'bg-warning'
                      : 'bg-success'}"
                style="width: {usagePercent ?? 0}%"
              ></span>
              <span class="absolute -right-1 top-[3px] h-1.5 w-0.5 rounded-r bg-current"></span>
            </span>
          </button>
        {/if}

        <button
          type="button"
          class="relative flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-muted transition-colors active:bg-elevated"
          aria-label="More options"
          title="More options"
          onclick={() => (headerMenuOpen = true)}
        >
          <MoreVertical size={19} />
          {#if mobileState.hasOverflowAttention}
            <span class="absolute top-1.5 right-1.5 flex items-start">
              <span class="h-2 w-2 rounded-full bg-thread-pinned"></span>
            </span>
          {/if}
        </button>
      </div>
    </header>
  </div>

  <!-- Conversation — the mobile transcript, lazy-loaded. -->
  <main class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    {#if mobileState.selectedThread}
      {#key mobileState.selectedThread.id}
        {#await retryableChunk(chunkRetry, () => import('./RemoteConversation.svelte')) then { default: RemoteConversation }}
          <RemoteConversation
            thread={mobileState.selectedThread}
            chatMode={mobileState.chatMode}
            jumpTarget={mobileState.jumpTarget}
          />
        {:catch}
          {@render chunkFailure()}
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
          onclick={openSidebar}
        >
          <PanelLeft size={15} />
          Open sidebar
        </button>
      </div>
    {/if}
  </main>

  <!-- History jump sheet. -->
  <BottomSheet
    open={mobileState.historyOpen}
    title="Your messages"
    onClose={() => (mobileState.historyOpen = false)}
  >
    <MessageHistoryPanel messages={mobileState.userMessages} onSelect={historyJump} />
  </BottomSheet>

  <!-- Notifications sheet — the panel lazy-loads at open time. -->
  <BottomSheet
    open={mobileState.notificationsOpen}
    title="Notifications"
    onClose={() => (mobileState.notificationsOpen = false)}
  >
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
    {#await retryableChunk(chunkRetry, () => import('$lib/components/notifications/NotificationPanel.svelte'))}
      <div
        class="flex min-h-40 items-center justify-center gap-2 text-sm text-dimmed"
        role="status"
      >
        <Loader2 size={16} class="animate-spin" />
        Loading notifications…
      </div>
    {:then { default: NotificationPanel }}
      <NotificationPanel onOpenThread={openNotificationThread} />
    {:catch}
      {@render chunkFailure()}
    {/await}
  </BottomSheet>

  <!-- Memory sheet — the desktop panel lazy-loads at open time. -->
  <BottomSheet
    open={mobileState.memoryOpen}
    title="Memory"
    onClose={() => (mobileState.memoryOpen = false)}
  >
    <div class="p-3">
      {#await retryableChunk(chunkRetry, () => import('$lib/components/memory/MemoryPanel.svelte'))}
        <div
          class="flex min-h-40 items-center justify-center gap-2 text-sm text-dimmed"
          role="status"
        >
          <Loader2 size={16} class="animate-spin" />
          Loading memory…
        </div>
      {:then { default: MemoryPanel }}
        <MemoryPanel
          variant="sidebar"
          projectId={mobileState.selectedThread?.projectId ?? mobileState.selectedProject?.id}
          threadId={mobileState.selectedThread?.id}
          allowTransfer={false}
        />
      {:catch}
        {@render chunkFailure()}
      {/await}
    </div>
  </BottomSheet>

  <!-- Temporary (explain / quick) chat sheet — opened from the conversation's
       selection popover or the header overflow menu. -->
  {#if mobileState.temporaryChatTabId && contextSidebarState.temporaryChatTab(mobileState.temporaryChatTabId)}
    <BottomSheet
      open={mobileState.temporaryChatOpen}
      title="Temporary chat"
      onClose={() => (mobileState.temporaryChatOpen = false)}
      fixedHeight
    >
      {#await retryableChunk(chunkRetry, () => import('$lib/components/chats/TemporaryChatView.svelte'))}
        <div
          class="flex h-full items-center justify-center gap-2 text-sm text-dimmed"
          role="status"
        >
          <Loader2 size={16} class="animate-spin" />
          Loading chat…
        </div>
      {:then { default: TemporaryChatView }}
        <TemporaryChatView tabId={mobileState.temporaryChatTabId} />
      {:catch}
        {@render chunkFailure()}
      {/await}
    </BottomSheet>
  {/if}

  <!-- Git sheet — the desktop panel lazy-loads at open time. -->
  {#if mobileState.selectedThread && !mobileState.chatMode}
    <BottomSheet
      open={mobileState.gitOpen}
      title="Git"
      onClose={() => (mobileState.gitOpen = false)}
      fixedHeight
    >
      {#await retryableChunk(chunkRetry, () => import('$lib/components/git/GitStatusPanel.svelte'))}
        <div
          class="flex h-full items-center justify-center gap-2 text-sm text-dimmed"
          role="status"
        >
          <Loader2 size={16} class="animate-spin" />
          Loading Git…
        </div>
      {:then { default: GitStatusPanel }}
        <GitStatusPanel
          projectId={mobileState.selectedThread?.projectId ?? ''}
          threadId={mobileState.selectedThread?.id ?? ''}
          scopeBucketId={mobileState.selectedThread?.scopeBucketId}
        />
      {:catch}
        {@render chunkFailure()}
      {/await}
    </BottomSheet>
  {/if}

  <!-- Sources sheet — files, processes, artifacts, and context this thread has touched. -->
  {#if mobileState.selectedThread}
    <BottomSheet
      open={mobileState.sourcesOpen}
      title="Sources"
      onClose={() => (mobileState.sourcesOpen = false)}
      fixedHeight
    >
      {#await retryableChunk(chunkRetry, () => import('$lib/components/threads/SourcesPanel.svelte'))}
        <div
          class="flex h-full items-center justify-center gap-2 text-sm text-dimmed"
          role="status"
        >
          <Loader2 size={16} class="animate-spin" />
          Loading sources…
        </div>
      {:then { default: SourcesPanel }}
        {#await retryableChunk(chunkRetry, () => import('$lib/agent-sources'))}
          <div
            class="flex h-full items-center justify-center gap-2 text-sm text-dimmed"
            role="status"
          >
            <Loader2 size={16} class="animate-spin" />
            Loading sources…
          </div>
        {:then { collectAgentSources }}
          <SourcesPanel
            sources={collectAgentSources(
              threadMessages.messages(
                mobileState.selectedThread?.projectId ?? '',
                mobileState.selectedThread?.id ?? ''
              )
            )}
            projectId={mobileState.selectedThread?.projectId}
            threadId={mobileState.selectedThread?.id}
          />
        {:catch}
          {@render chunkFailure()}
        {/await}
      {:catch}
        {@render chunkFailure()}
      {/await}
    </BottomSheet>
  {/if}

  <!-- Notes drawer — shares the same editor panel as the desktop sidebar. -->
  {#if mobileState.selectedThread}
    <BottomSheet
      open={mobileState.notesOpen}
      title="Notes"
      onClose={() => (mobileState.notesOpen = false)}
      fixedHeight
    >
      {#if mobileNoteTab}
        {#await retryableChunk(chunkRetry, () => import('$lib/components/threads/ThreadNotePanel.svelte'))}
          <div
            class="flex h-full items-center justify-center gap-2 text-sm text-dimmed"
            role="status"
          >
            <Loader2 size={16} class="animate-spin" />
            Loading note…
          </div>
        {:then { default: ThreadNotePanel }}
          <ThreadNotePanel tab={mobileNoteTab} />
        {:catch}
          {@render chunkFailure()}
        {/await}
      {:else}
        <p class="py-10 text-center text-sm text-dimmed">Loading note…</p>
      {/if}
    </BottomSheet>
  {/if}

  <!-- Context usage sheet — same detail the desktop composer's battery icon shows. -->
  {#if mobileState.selectedThread}
    <BottomSheet
      open={mobileState.usageOpen}
      title="Context usage"
      onClose={() => (mobileState.usageOpen = false)}
    >
      <div class="p-3">
        {#await retryableChunk(chunkRetry, () => import('$lib/components/chats/ContextUsageIndicator.svelte')) then { default: ContextUsageIndicator }}
          <ContextUsageIndicator layout="panel" usage={mobileState.selectedThread?.contextUsage} />
        {:catch}
          {@render chunkFailure()}
        {/await}
      </div>
    </BottomSheet>
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
      <div class="flex h-14 shrink-0 items-center gap-1 border-b border-border px-2">
        {#if showInstall}
          <button
            type="button"
            class="flex h-10 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-primary text-[13px] font-medium text-on-primary transition-colors active:bg-primary-hover"
            title="Install CodeInOven on this device"
            onclick={() => void handleInstall()}
          >
            <Download size={14} />
            Install
          </button>
        {/if}
        <button
          type="button"
          class="flex h-10 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-elevated text-[13px] font-medium text-muted transition-colors active:bg-elevated active:text-foreground"
          title="Close the sidebar"
          aria-label="Close the sidebar"
          onclick={() => (mobileState.sidebarOpen = false)}
        >
          <X size={16} />
          Close
        </button>

        <button
          type="button"
          class="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-xl text-muted transition-colors active:bg-danger/10 active:text-danger"
          aria-label="Disconnect from the desktop"
          title="Disconnect from the desktop"
          onclick={onDisconnect}
        >
          <Power size={17} />
        </button>
      </div>

      <div class="shrink-0 border-b border-border px-3 py-2">
        <label
          class="flex h-10 items-center gap-2 rounded-xl bg-elevated px-3 text-muted focus-within:ring-1 focus-within:ring-primary"
        >
          <Search size={15} class="shrink-0 text-dimmed" />
          <input
            type="search"
            value={searchQuery}
            class="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-dimmed"
            placeholder={mobileState.sidebarMode === 'chats'
              ? 'Search chats…'
              : 'Search project threads…'}
            aria-label={mobileState.sidebarMode === 'chats'
              ? 'Search chat threads'
              : 'Search project threads'}
            oninput={(event) => searchThreads(event.currentTarget.value)}
          />
          {#if searching}
            <Loader2 size={14} class="shrink-0 animate-spin text-dimmed" />
          {/if}
        </label>
      </div>

      <!-- Sidebar content -->
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
        {#if searchQuery.trim().length >= 2}
          {#if !searching && visibleSearchResults.length === 0}
            <p class="px-3 py-12 text-center text-[13px] text-dimmed">No matching threads</p>
          {:else}
            <div class="space-y-px">
              {#each visibleSearchResults as result (result.thread.id)}
                <button
                  type="button"
                  class="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2.5 text-left transition-colors active:bg-elevated"
                  title={result.thread.title}
                  onclick={() => void mobileState.openThread(result.thread)}
                >
                  <span class="flex min-w-0 items-center gap-2">
                    {@render threadStatusDot(result.thread)}
                    <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">
                      {result.thread.title}
                    </span>
                  </span>
                  {#if result.kind === 'message' && result.snippet}
                    <span class="line-clamp-2 pl-4 text-[11px] leading-snug text-dimmed">
                      {result.role === 'assistant' ? 'Agent' : 'You'} · {result.snippet}
                    </span>
                  {/if}
                </button>
              {/each}
            </div>
          {/if}
        {:else if mobileState.loading}
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
                      : ''} {mobileState.isWorking(thread)
                      ? 'animate-pulse bg-thread-working/5'
                      : ''}"
                    title={thread.title}
                    onclick={() => void mobileState.openThread(thread)}
                  >
                    {@render threadStatusDot(thread)}
                    <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">
                      {thread.title}
                    </span>
                    <span class="shrink-0 text-[10px] text-dimmed"
                      >{relativeTime(thread.createdAt)}</span
                    >
                  </button>
                  <button
                    type="button"
                    class="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-muted transition-colors active:bg-elevated active:text-foreground"
                    title={`Actions for ${thread.title}`}
                    aria-label={`Actions for ${thread.title}`}
                    onclick={() => (actionMenuThread = thread)}
                  >
                    <MoreVertical size={20} />
                  </button>
                </div>
              {/each}
            </div>
          {/if}

          {#each mobileState.visibleProjects as project (project.id)}
            {@const iconUrl = getProjectIcon(project, mobileState.projectIcons.get(project.id))}
            {@const expanded = mobileState.expandedFolders.has(project.id)}
            {@const working = folderWorking(project.id)}
            <div class="mb-0.5">
              <div class="flex items-center gap-0.5">
                <button
                  type="button"
                  class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors active:bg-elevated"
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
                    <Loader2 size={13} class="shrink-0 animate-spin text-thread-working" />
                  {/if}
                  <ChevronDown
                    size={14}
                    class={`shrink-0 text-dimmed transition-transform ${expanded ? 'rotate-180' : ''}`}
                  />
                </button>
                <button
                  type="button"
                  class="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors active:bg-elevated active:text-foreground"
                  title={`New thread in ${project.name}`}
                  aria-label={`New thread in ${project.name}`}
                  onclick={() => void createProjectThread(project.id)}
                >
                  <Plus size={16} />
                </button>
              </div>
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
                        {@render threadStatusDot(thread)}
                        <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">
                          {thread.title}
                        </span>
                        <span class="shrink-0 text-[10px] text-dimmed"
                          >{relativeTime(thread.createdAt)}</span
                        >
                      </button>
                      <button
                        type="button"
                        class="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-muted transition-colors active:bg-elevated active:text-foreground"
                        title={`Actions for ${thread.title}`}
                        aria-label={`Actions for ${thread.title}`}
                        onclick={() => (actionMenuThread = thread)}
                      >
                        <MoreVertical size={20} />
                      </button>
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
          {#if activeThreadProject}
            {@const scopedIconUrl = getProjectIcon(
              activeThreadProject,
              mobileState.projectIcons.get(activeThreadProject.id)
            )}
            <div
              class="sticky top-0 z-10 mb-1 flex min-h-10 items-center justify-between gap-2 border-b border-border bg-surface px-1.5"
            >
              <span class="flex min-w-0 items-center gap-1.5 px-1">
                {#if scopedIconUrl}
                  <img src={scopedIconUrl} alt="" class="h-4 w-4 shrink-0 rounded object-contain" />
                {:else}
                  <span class="h-4 w-4 shrink-0 rounded bg-elevated"></span>
                {/if}
                <span class="truncate text-[12px] font-medium text-muted">
                  {activeThreadProject.name}
                </span>
              </span>
              <button
                type="button"
                class="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors active:bg-elevated active:text-foreground"
                title={`New thread in ${activeThreadProject.name}`}
                aria-label={`New thread in ${activeThreadProject.name}`}
                onclick={() => void createProjectThread(activeThreadProject.id)}
              >
                <Plus size={17} />
              </button>
            </div>
          {/if}
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
                    : ''} {mobileState.isWorking(thread)
                    ? 'animate-pulse bg-thread-working/5'
                    : ''}"
                  title={thread.title}
                  onclick={() => void mobileState.openThread(thread)}
                >
                  {#if iconUrl}
                    <img src={iconUrl} alt="" class="h-3.5 w-3.5 shrink-0 rounded object-contain" />
                  {/if}
                  {@render threadStatusDot(thread)}
                  <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">
                    {thread.title}
                  </span>
                  <span class="shrink-0 text-[10px] text-dimmed"
                    >{relativeTime(thread.createdAt)}</span
                  >
                </button>
                <button
                  type="button"
                  class="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-muted transition-colors active:bg-elevated active:text-foreground"
                  title={`Actions for ${thread.title}`}
                  aria-label={`Actions for ${thread.title}`}
                  onclick={() => (actionMenuThread = thread)}
                >
                  <MoreVertical size={20} />
                </button>
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
                    : ''} {mobileState.isWorking(thread)
                    ? 'animate-pulse bg-thread-working/5'
                    : ''}"
                  title={thread.title}
                  onclick={() => void mobileState.openThread(thread)}
                >
                  {@render threadStatusDot(thread)}
                  <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">
                    {thread.title}
                  </span>
                  <span class="shrink-0 text-[10px] text-dimmed"
                    >{relativeTime(thread.createdAt)}</span
                  >
                </button>
                <button
                  type="button"
                  class="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-muted transition-colors active:bg-elevated active:text-foreground"
                  title={`Actions for ${thread.title}`}
                  aria-label={`Actions for ${thread.title}`}
                  onclick={() => (actionMenuThread = thread)}
                >
                  <MoreVertical size={20} />
                </button>
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

      <!-- Sidebar footer: view switcher + new thread/chat — share the same row. -->
      <div class="shrink-0 border-t border-border p-2 flex items-center gap-2">
        <button
          type="button"
          class="flex h-11 min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-xl bg-elevated px-3 text-left transition-colors active:bg-elevated"
          title="Switch sidebar view"
          aria-label="Switch sidebar view"
          onclick={() => (modeMenuOpen = true)}
        >
          <span class="flex min-w-0 items-center gap-2">
            {#if activeSidebarMode}
              {@const ActiveIcon = activeSidebarMode.icon}
              <ActiveIcon size={15} class="shrink-0 text-muted" />
            {/if}
            <span class="truncate text-[13px] font-medium text-foreground">
              {activeSidebarMode?.label ?? 'Projects'}
            </span>
          </span>
          <ChevronDown size={15} class="shrink-0 text-dimmed" />
        </button>
        {#if mobileState.sidebarMode === 'chats'}
          <button
            type="button"
            class="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-primary text-on-primary transition-colors active:bg-primary-hover"
            aria-label="New chat"
            title="New chat"
            onclick={() => void createChat()}
          >
            <Plus size={18} />
          </button>
        {:else if mobileState.sidebarMode === 'threads'}
          <button
            type="button"
            class="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-primary text-on-primary transition-colors active:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={activeThreadProject
              ? `New thread in ${activeThreadProject.name}`
              : 'New thread'}
            title={activeThreadProject ? `New thread in ${activeThreadProject.name}` : 'New thread'}
            disabled={!activeThreadProject}
            onclick={() => {
              if (activeThreadProject) void createProjectThread(activeThreadProject.id)
            }}
          >
            <Plus size={18} />
          </button>
        {/if}
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

  <!-- Touch-friendly thread actions — bottom-sheet menu backed by the same
       MenuItem shape the rest of the app uses. -->
  <ActionSheet
    open={actionMenuThread !== null}
    title={actionMenuThread?.title ?? 'Thread actions'}
    items={actionMenuThread ? threadMenuItems(actionMenuThread) : []}
    onClose={() => (actionMenuThread = null)}
  />

  <!-- Sidebar view switcher — Projects / Threads / Chats. -->
  <ActionSheet
    open={modeMenuOpen}
    title="View"
    items={modeMenuItems}
    onClose={() => (modeMenuOpen = false)}
  />

  <!-- App header overflow menu — history/memory/git/sources/notes/notifications. -->
  <ActionSheet
    open={headerMenuOpen}
    title="Options"
    items={headerMenuItems()}
    onClose={() => (headerMenuOpen = false)}
  />
</div>
