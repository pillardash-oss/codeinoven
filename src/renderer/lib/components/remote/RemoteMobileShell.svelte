<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import { DropdownMenu } from 'bits-ui'
  import {
    Bell,
    BrainCircuit,
    Check,
    ChevronDown,
    FileText,
    GitBranch,
    History,
    Loader2,
    MessageSquare,
    MoreVertical,
    PanelLeft,
    Power,
    X
  } from '@lucide/svelte'
  import ThreadView from '$lib/components/threads/ThreadView.svelte'
  import FolderRow from '$lib/components/workspace/FolderRow.svelte'
  import ThreadRow from '$lib/components/threads/ThreadRow.svelte'
  import PinnedSection from '$lib/components/threads/PinnedSection.svelte'
  import ThreadSearchControl from '$lib/components/shared/ThreadSearchControl.svelte'
  import NotificationPanel from '$lib/components/notifications/NotificationPanel.svelte'
  import MemoryPanel from '$lib/components/memory/MemoryPanel.svelte'
  import GitStatusPanel from '$lib/components/git/GitStatusPanel.svelte'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import { mobileNotifications } from '$lib/remote/mobile-notifications.svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { loadProjectIcons, getProjectIcon } from '$lib/project-icons'
  import { workspaceState, threadSort } from '$lib/stores/workspace.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { notificationPanelState } from '$lib/stores/notification-panel.svelte'
  import { memoryProposalState } from '$lib/stores/memory-proposals.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { hasProjectNameCollision } from '$lib/project-location'
  import { INBOX_PROJECT_ID, type Project, type Thread } from '$shared/types'

  interface Props {
    onDisconnect?: () => void
  }

  let { onDisconnect = () => undefined }: Props = $props()

  type SidebarMode = 'projects' | 'threads' | 'chats'

  const SIDEBAR_MODES: { id: SidebarMode; label: string }[] = [
    { id: 'projects', label: 'Projects' },
    { id: 'threads', label: 'Threads' },
    { id: 'chats', label: 'Chats' }
  ]

  /** The sidebar's view mode — the dropdown heading switches between them. */
  let sidebarMode = $state<SidebarMode>('projects')
  let sidebarOpen = $state(false)
  let modeMenuOpen = $state(false)

  let projects = $state<Project[]>([])
  let allThreads = $state<Thread[]>([])
  let loading = $state(true)

  const projectIcons = new SvelteMap<string, string>()
  const expandedFolders = new SvelteSet<string>()

  /** Sheets behind the header's overflow menu. */
  let notificationsOpen = $state(false)
  let memoryOpen = $state(false)
  let historyOpen = $state(false)
  let gitOpen = $state(false)
  let selectedThread = $derived(workspaceState.selectedThread)
  let selectedProject = $derived(workspaceState.activeProject)

  let modeLabel = $derived(
    SIDEBAR_MODES.find((entry) => entry.id === sidebarMode)?.label ?? 'Projects'
  )

  /** One dot on the overflow trigger so nothing important hides behind it. */
  let hasOverflowAttention = $derived(
    memoryProposalState.hasPending || notificationPanelState.totalCount > 0
  )

  // ─── Viewport height ───────────────────────────────────────────────────
  // `100dvh` accounts for the browser chrome but not the on-screen keyboard,
  // which would push the composer out of view. The visual viewport does.
  let viewportHeight = $state<number | null>(null)

  $effect(() => {
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

  // ─── Data loading (mirrors the desktop Workspace shell) ────────────────

  async function loadData(): Promise<void> {
    try {
      const [projectList, threadList] = await Promise.all([
        invoke('project:list'),
        invoke('thread:listAll')
      ])
      projects = projectList as Project[]
      allThreads = threadList as Thread[]
      notificationPanelState.hydrateFromThreads(allThreads)
      projectIcons.clear()
      for (const [projectId, iconUrl] of await loadProjectIcons(projects)) {
        projectIcons.set(projectId, iconUrl)
      }
      scopeState.setScopesFromProjects(projects, projectIcons)
      scopeState.setThreads(allThreads)
      // Seed every project's catalog so the composer's model picker is
      // populated before the first message.
      void providerCatalog.init([...projects.map((project) => project.id), INBOX_PROJECT_ID])
      const saved = rendererRecovery.selectedThread
      if (saved) {
        const restored = allThreads.find(
          (candidate) =>
            candidate.id === saved.threadId &&
            candidate.projectId === saved.projectId &&
            !candidate.archived
        )
        if (restored) {
          workspaceState.openThread(
            restored,
            projects.find((candidate) => candidate.id === restored.projectId) ?? null
          )
          void scopeState.ensureBoardLoaded(restored.projectId)
          void invoke('thread:markRead', restored.projectId, restored.id)
        }
      }
    } catch {
      projects = []
      allThreads = []
    } finally {
      loading = false
    }
  }

  $effect(() => {
    memoryProposalState.setContext(selectedThread?.projectId ?? null)
  })

  // Live thread updates pushed from the desktop — keeps the sidebar rows and
  // the selected thread's read/status state in sync on both surfaces.
  $effect(() => {
    return subscribe('thread:updated', (...args: unknown[]) => {
      const updated = args[0] as Thread
      if (!allThreads.some((t) => t.id === updated.id)) return
      allThreads = allThreads.map((t) => (t.id === updated.id ? updated : t))
      scopeState.updateThread(updated)
      if (workspaceState.selectedThread?.id === updated.id) {
        workspaceState.updateThread(updated)
        if (!updated.read) {
          void invoke('thread:markRead', updated.projectId, updated.id)
        }
      }
    })
  })

  // ─── Derived lists (same grouping as the desktop sidebar) ──────────────

  let visibleProjects = $derived(
    projects
      .filter((project) => !project.hidden)
      .sort((a, b) => (a.sortOrder ?? -1) - (b.sortOrder ?? -1))
  )

  let pinnedThreads = $derived(
    allThreads
      .filter((t) => t.pinned && !t.archived && t.projectId !== INBOX_PROJECT_ID)
      .sort((a, b) => threadSort(a, b, null))
  )

  let pinnedProjects = $derived(visibleProjects.filter((project) => project.pinned))
  let regularProjects = $derived(visibleProjects.filter((project) => !project.pinned))

  let threadsByProject = $derived.by(() => {
    const map = new SvelteMap<string, Thread[]>()
    for (const t of allThreads) {
      if (t.archived || t.pinned) continue
      const list = map.get(t.projectId) ?? []
      list.push(t)
      map.set(t.projectId, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) => threadSort(a, b, null))
    }
    return map
  })

  /** Threads mode: every project thread, flat. */
  let flatThreads = $derived(
    allThreads
      .filter((t) => !t.archived && t.projectId !== INBOX_PROJECT_ID)
      .sort((a, b) => threadSort(a, b, null))
  )

  /** Chats mode: the standalone inbox conversations, pinned first. */
  let chatThreads = $derived(
    allThreads
      .filter((t) => !t.archived && t.projectId === INBOX_PROJECT_ID)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return threadSort(a, b, null)
      })
  )

  /** The search popover follows whatever the sidebar is currently showing. */
  let searchThreads = $derived(
    sidebarMode === 'chats'
      ? allThreads.filter((t) => t.projectId === INBOX_PROJECT_ID)
      : sidebarMode === 'threads'
        ? allThreads.filter((t) => t.projectId !== INBOX_PROJECT_ID)
        : allThreads
  )

  let searchScope = $derived(
    sidebarMode === 'chats'
      ? { projectId: INBOX_PROJECT_ID }
      : sidebarMode === 'threads'
        ? { filter: (t: Thread) => t.projectId !== INBOX_PROJECT_ID && !t.archived }
        : {}
  )

  // ─── Thread + folder actions (same as the desktop shell) ───────────────

  async function openThread(thread: Thread): Promise<void> {
    const project = projects.find((p) => p.id === thread.projectId) ?? null
    workspaceState.openThread(thread, project)
    void scopeState.ensureBoardLoaded(thread.projectId)
    sidebarOpen = false
    const updated = await invoke('thread:markRead', thread.projectId, thread.id)
    allThreads = allThreads.map((t) => (t.id === updated.id ? updated : t))
    workspaceState.updateThread(updated)
    scopeState.updateThread(updated)
  }

  /** A tapped system notification opens the referenced thread. */
  async function openThreadById(projectId: string, threadId: string): Promise<void> {
    const thread = allThreads.find(
      (t) => t.id === threadId && t.projectId === projectId && !t.archived
    )
    if (!thread) {
      await loadData()
      const reloaded = allThreads.find((t) => t.id === threadId && t.projectId === projectId)
      if (reloaded) await openThread(reloaded)
      return
    }
    await openThread(thread)
  }

  async function handleRename(thread: Thread, newName: string): Promise<void> {
    const updated = await invoke('thread:update', thread.projectId, thread.id, {
      title: newName,
      titleSource: 'manual'
    })
    allThreads = allThreads.map((t) => (t.id === updated.id ? updated : t))
    workspaceState.updateThread(updated)
    scopeState.updateThread(updated)
  }

  async function togglePin(thread: Thread): Promise<void> {
    const updated = await invoke('thread:setPinned', thread.projectId, thread.id, !thread.pinned)
    allThreads = allThreads.map((t) => (t.id === updated.id ? updated : t))
    scopeState.updateThread(updated)
    workspaceState.updateThread(updated)
  }

  async function handleDelete(thread: Thread): Promise<void> {
    await invoke('thread:delete', thread.projectId, thread.id)
    allThreads = allThreads.filter((t) => t.id !== thread.id)
    scopeState.removeThread(thread.id)
    if (workspaceState.selectedThread?.id === thread.id) workspaceState.clearThread()
  }

  async function forkThread(thread: Thread): Promise<void> {
    const forked = await invoke(
      'thread:fork',
      thread.projectId,
      thread.id,
      `${thread.title} (fork)`
    )
    allThreads = [forked, ...allThreads]
    scopeState.updateThread(forked)
    const project = projects.find((candidate) => candidate.id === forked.projectId) ?? null
    workspaceState.openThread(forked, project)
  }

  function toggleFolder(projectId: string): void {
    if (expandedFolders.has(projectId)) expandedFolders.delete(projectId)
    else expandedFolders.add(projectId)
  }

  function historyJump(id: string): void {
    historyOpen = false
    workspaceState.jumpToMessage?.(id)
  }

  onMount(() => {
    void loadData()
    mobileNotifications.init()
    mobileNotifications.setOpenHandler(
      (projectId, threadId) => void openThreadById(projectId, threadId)
    )
    const onServiceWorkerMessage = (event: MessageEvent): void => {
      const record = event.data
      if (record?.type === 'notification:open' && record.projectId && record.threadId) {
        void openThreadById(String(record.projectId), String(record.threadId))
      }
    }
    navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage)
    return () => {
      navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage)
      mobileNotifications.setOpenHandler(null)
    }
  })
</script>

<div
  class="mobile-shell flex w-full flex-col overflow-hidden bg-app text-foreground"
  style="height: {shellHeight}"
>
  <!-- Header: menu · centred thread title · overflow menu. The side slots are
       the same width so the title sits on the true centre line. -->
  <div class="shrink-0 border-b border-border bg-surface pt-[env(safe-area-inset-top)]">
    <header class="grid h-14 grid-cols-[2.75rem_1fr_2.75rem] items-center gap-1 px-2">
      <button
        type="button"
        class="flex h-11 w-11 items-center justify-center rounded-xl text-muted transition-colors active:bg-elevated"
        aria-label="Open the sidebar"
        title="Open the sidebar"
        onclick={() => (sidebarOpen = true)}
      >
        <PanelLeft size={19} />
      </button>

      <div class="min-w-0 px-1 text-center">
        <p class="truncate text-[14px] font-semibold tracking-tight">
          {selectedThread?.title ?? 'CodeInOven'}
        </p>
        {#if selectedProject && selectedThread && selectedProject.id !== INBOX_PROJECT_ID}
          <p class="truncate text-[11px] text-dimmed">{selectedProject.name}</p>
        {/if}
      </div>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          class="relative flex h-11 w-11 items-center justify-center rounded-xl text-muted transition-colors active:bg-elevated"
          aria-label="More options"
          title="More options"
        >
          <MoreVertical size={19} />
          {#if hasOverflowAttention}
            <span class="absolute top-1.5 right-1.5 flex items-start">
              <StatusBadge kind="attention" title="Items need your attention" />
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
              class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-[14px] text-muted outline-none transition-colors hover:bg-elevated focus:bg-elevated hover:text-foreground data-[disabled]:opacity-40"
              disabled={workspaceState.messageCount === 0}
              onSelect={() => (historyOpen = true)}
            >
              <History size={16} />
              <span class="flex-1 text-left">Message history</span>
            </DropdownMenu.Item>

            <DropdownMenu.Item
              class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-[14px] text-muted outline-none transition-colors hover:bg-elevated focus:bg-elevated hover:text-foreground"
              onSelect={() => (memoryOpen = true)}
            >
              <BrainCircuit size={16} />
              <span class="flex-1 text-left">Memory</span>
              {#if memoryProposalState.hasPending}
                <StatusBadge kind="attention" title="Memory proposals needing attention" />
              {/if}
            </DropdownMenu.Item>

            {#if selectedThread}
              <DropdownMenu.Item
                class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-[14px] text-muted outline-none transition-colors hover:bg-elevated focus:bg-elevated hover:text-foreground"
                onSelect={() => (gitOpen = true)}
              >
                <GitBranch size={16} />
                <span class="flex-1 text-left">Git</span>
              </DropdownMenu.Item>
            {/if}

            {#if selectedThread && workspaceState.specStudioAvailable}
              <DropdownMenu.Item
                class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-[14px] text-muted outline-none transition-colors hover:bg-elevated focus:bg-elevated hover:text-foreground"
                onSelect={() => workspaceState.toggleSpecStudio?.()}
              >
                <FileText size={16} />
                <span class="flex-1 text-left">Specification</span>
                {#if workspaceState.specStudioOpen}
                  <Check size={15} class="text-primary" />
                {/if}
              </DropdownMenu.Item>
            {/if}

            <DropdownMenu.Item
              class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-[14px] text-muted outline-none transition-colors hover:bg-elevated focus:bg-elevated hover:text-foreground"
              onSelect={() => (notificationsOpen = true)}
            >
              <Bell size={16} />
              <span class="flex-1 text-left">Notifications</span>
              {#if notificationPanelState.totalCount > 0}
                <span class="flex items-start gap-px">
                  {#if notificationPanelState.hasCompleted}
                    <StatusBadge kind="completed" title="Completed notifications" />
                  {/if}
                  {#if notificationPanelState.hasAttention}
                    <StatusBadge kind="attention" title="Notifications needing attention" />
                  {/if}
                </span>
              {/if}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </header>
  </div>

  <!-- Conversation — the desktop ThreadView, reused as-is. It scrolls its own
       message list and keeps the ChatComposer pinned, which only works when
       the parent is a bounded flex column. -->
  <main class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    {#if selectedThread}
      {#key selectedThread.id}
        <ThreadView
          thread={selectedThread}
          chatMode={selectedThread.projectId === INBOX_PROJECT_ID}
        />
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
          class="mt-1 flex h-11 items-center gap-2 rounded-xl bg-primary px-5 text-[14px] font-medium text-on-primary transition-colors active:bg-primary-hover"
          onclick={() => (sidebarOpen = true)}
        >
          <PanelLeft size={15} />
          Open sidebar
        </button>
      </div>
    {/if}
  </main>

  <!-- History jump sheet. -->
  {#if historyOpen}
    <div
      class="fixed inset-0 z-40 bg-black/50"
      role="presentation"
      onclick={() => (historyOpen = false)}
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
          class="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors active:bg-elevated"
          aria-label="Close history"
          title="Close history"
          onclick={() => (historyOpen = false)}
        >
          <X size={16} />
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
        {#each workspaceState.userMessages as message, index (message.id)}
          <button
            type="button"
            class="block w-full truncate rounded-lg px-3 py-3 text-left text-[14px] text-muted transition-colors active:bg-elevated"
            title={message.content}
            onclick={() => historyJump(message.id)}
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

  <!-- Notifications sheet. -->
  {#if notificationsOpen}
    <div
      class="fixed inset-0 z-40 bg-black/50"
      role="presentation"
      onclick={() => (notificationsOpen = false)}
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
          class="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors active:bg-elevated"
          aria-label="Close notifications"
          title="Close notifications"
          onclick={() => (notificationsOpen = false)}
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
        <NotificationPanel />
      </div>
    </aside>
  {/if}

  <!-- Memory sheet. -->
  {#if memoryOpen}
    <div
      class="fixed inset-0 z-40 bg-black/50"
      role="presentation"
      onclick={() => (memoryOpen = false)}
    ></div>
    <aside
      class="fixed right-0 bottom-0 left-0 z-50 flex max-h-[82dvh] flex-col overflow-hidden rounded-t-2xl border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-2xl"
      aria-label="Memory"
    >
      <div class="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-dimmed">Memory</p>
        <button
          type="button"
          class="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors active:bg-elevated"
          aria-label="Close memory"
          title="Close memory"
          onclick={() => (memoryOpen = false)}
        >
          <X size={16} />
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        <MemoryPanel
          variant="sidebar"
          projectId={selectedThread?.projectId ?? selectedProject?.id}
          threadId={selectedThread?.id}
        />
      </div>
    </aside>
  {/if}

  <!-- Git sheet — the desktop git panel, scoped to the selected thread's project. -->
  {#if gitOpen && selectedThread}
    <div
      class="fixed inset-0 z-40 bg-black/50"
      role="presentation"
      onclick={() => (gitOpen = false)}
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
          class="flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors active:bg-elevated"
          aria-label="Close git"
          title="Close git"
          onclick={() => (gitOpen = false)}
        >
          <X size={16} />
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-hidden">
        <GitStatusPanel projectId={selectedThread.projectId} threadId={selectedThread.id} />
      </div>
    </aside>
  {/if}

  <!-- Sidebar drawer. -->
  {#if sidebarOpen}
    <div
      class="fixed inset-0 z-50 bg-black/50"
      role="presentation"
      onclick={() => (sidebarOpen = false)}
    ></div>
    <aside
      class="fixed top-0 bottom-0 left-0 z-50 flex w-[86vw] max-w-88 flex-col border-r border-border bg-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-2xl"
      aria-label="Sidebar"
    >
      <!-- One header row: the mode heading doubles as the switcher, and search
           lives beside it as an icon that opens its own dropdown. -->
      <div class="flex h-14 shrink-0 items-center gap-0.5 border-b border-border px-2">
        <DropdownMenu.Root bind:open={modeMenuOpen}>
          <DropdownMenu.Trigger
            class="flex h-11 min-w-0 flex-1 items-center gap-1.5 rounded-xl px-2.5 text-left transition-colors active:bg-elevated"
            aria-label="Switch sidebar view — currently {modeLabel}"
            title="Switch sidebar view"
          >
            <span class="truncate text-[15px] font-semibold tracking-tight">{modeLabel}</span>
            <ChevronDown
              size={15}
              class="shrink-0 text-dimmed transition-transform {modeMenuOpen ? 'rotate-180' : ''}"
            />
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
                <DropdownMenu.Item
                  class="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-[14px] outline-none transition-colors hover:bg-elevated focus:bg-elevated {sidebarMode ===
                  entry.id
                    ? 'text-foreground'
                    : 'text-muted'}"
                  onSelect={() => (sidebarMode = entry.id)}
                >
                  <span class="flex-1 text-left">{entry.label}</span>
                  {#if sidebarMode === entry.id}
                    <Check size={15} class="text-primary" />
                  {/if}
                </DropdownMenu.Item>
              {/each}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        <div class="flex shrink-0 items-center justify-center">
          <ThreadSearchControl
            threads={searchThreads}
            contextLabel={sidebarMode === 'chats' ? 'chats' : 'threads'}
            title="Search {sidebarMode === 'chats' ? 'chats' : 'threads'}"
            onOpen={openThread}
            fts={searchScope}
          />
        </div>

        <button
          type="button"
          class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted transition-colors active:bg-elevated"
          aria-label="Close the sidebar"
          title="Close the sidebar"
          onclick={() => (sidebarOpen = false)}
        >
          <X size={18} />
        </button>
      </div>

      <!-- Sidebar content — scrollable. -->
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
        {#if loading}
          <div class="flex items-center gap-2 px-3 py-4 text-[14px] text-muted">
            <Loader2 size={15} class="animate-spin" />
            Loading…
          </div>
        {:else if sidebarMode === 'projects'}
          <!-- Pinned threads above everything. -->
          <PinnedSection
            threads={pinnedThreads}
            projects={visibleProjects}
            selectedThreadId={selectedThread?.id ?? null}
            onOpen={openThread}
            onRename={handleRename}
            onTogglePin={togglePin}
            onDelete={handleDelete}
            onFork={forkThread}
          />

          {#each [...pinnedProjects, ...regularProjects] as project (project.id)}
            {@const folderThreads = threadsByProject.get(project.id) ?? []}
            {@const expanded = expandedFolders.has(project.id)}
            {@const working = folderThreads.some(
              (t) => t.status === 'planning' || t.status === 'executing'
            )}
            <FolderRow
              {project}
              iconUrl={projectIcons.get(project.id) ?? null}
              {expanded}
              {working}
              showLocation={hasProjectNameCollision(project, visibleProjects)}
              onToggle={() => toggleFolder(project.id)}
            />
            {#if expanded}
              <div class="ml-2 space-y-px py-0.5">
                {#each folderThreads as thread (thread.id)}
                  <ThreadRow
                    {thread}
                    selected={selectedThread?.id === thread.id}
                    onOpen={openThread}
                    onRename={handleRename}
                    onTogglePin={togglePin}
                    onDelete={handleDelete}
                    onFork={forkThread}
                  />
                {:else}
                  <p class="px-2 py-1.5 text-[12px] text-dimmed">No threads yet</p>
                {/each}
              </div>
            {/if}
          {:else}
            <div class="flex flex-col items-center gap-2 px-2 py-12 text-center">
              <p class="text-[13px] text-muted">No projects yet</p>
              <p class="text-[13px] text-dimmed">Add a project on the desktop to get started</p>
            </div>
          {/each}
        {:else if sidebarMode === 'threads'}
          <div class="space-y-px" role="list">
            {#each flatThreads as thread (thread.id)}
              <ThreadRow
                {thread}
                projectIconUrl={projectIcons.has(thread.projectId)
                  ? getProjectIcon(
                      projects.find((p) => p.id === thread.projectId)!,
                      projectIcons.get(thread.projectId)
                    )
                  : null}
                selected={selectedThread?.id === thread.id}
                onOpen={openThread}
                onRename={handleRename}
                onTogglePin={togglePin}
                onDelete={handleDelete}
                onFork={forkThread}
              />
            {:else}
              <p class="px-2 py-12 text-center text-[13px] text-dimmed">No threads yet</p>
            {/each}
          </div>
        {:else}
          <!-- Chats — the standalone inbox conversations. -->
          <div class="space-y-px" role="list">
            {#each chatThreads as thread (thread.id)}
              <ThreadRow
                {thread}
                selected={selectedThread?.id === thread.id}
                onOpen={openThread}
                onRename={handleRename}
                onTogglePin={togglePin}
                onDelete={handleDelete}
                onFork={forkThread}
              />
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

      <!-- Sidebar footer: the only setting is disconnect. -->
      <div class="shrink-0 border-t border-border p-2">
        <button
          type="button"
          class="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-elevated text-[14px] font-medium text-muted transition-colors active:bg-danger/10 active:text-danger"
          title="Disconnect from the desktop"
          onclick={() => onDisconnect()}
        >
          <Power size={15} />
          Disconnect
        </button>
      </div>
    </aside>
  {/if}
</div>

<style>
  /* The reused desktop conversation is laid out for a wide window. On a phone
     the gutters waste most of the line, so tighten them here rather than
     branching the shared components. */
  .mobile-shell :global(.conversation-gutter) {
    padding-left: 0.75rem;
    padding-right: 0.75rem;
  }

  .mobile-shell :global(.composer-gutter) {
    padding-bottom: calc(0.5rem + env(safe-area-inset-bottom));
  }

  .mobile-shell :global(.conversation-gutter[class*='overflow-y-auto']) {
    overscroll-behavior: contain;
  }
</style>
