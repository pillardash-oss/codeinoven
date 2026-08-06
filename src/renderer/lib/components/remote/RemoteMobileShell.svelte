<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import {
    Bell,
    BrainCircuit,
    ChevronDown,
    FileText,
    History,
    Loader2,
    MessageSquare,
    PanelLeft,
    Search,
    X
  } from '@lucide/svelte'
  import ThreadView from '$lib/components/threads/ThreadView.svelte'
  import FolderRow from '$lib/components/workspace/FolderRow.svelte'
  import ThreadRow from '$lib/components/threads/ThreadRow.svelte'
  import PinnedSection from '$lib/components/threads/PinnedSection.svelte'
  import ThreadSearchControl from '$lib/components/shared/ThreadSearchControl.svelte'
  import NotificationPanel from '$lib/components/notifications/NotificationPanel.svelte'
  import MemoryPanel from '$lib/components/memory/MemoryPanel.svelte'
  import ScopeView from '$lib/components/scope/ScopeView.svelte'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
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

  /** The sidebar's view mode: the dropdown heading switches between them. */
  let sidebarMode = $state<'projects' | 'trades' | 'charts'>('projects')
  let sidebarOpen = $state(false)

  let projects = $state<Project[]>([])
  let allThreads = $state<Thread[]>([])
  let loading = $state(true)

  const projectIcons = new SvelteMap<string, string>()
  const expandedFolders = new SvelteSet<string>()

  /** Overlays for the header icons — notifications and memory proposals. */
  let notificationsOpen = $state(false)
  let memoryOpen = $state(false)
  let historyOpen = $state(false)

  let selectedThread = $derived(workspaceState.selectedThread)
  let selectedProject = $derived(workspaceState.activeProject)

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

  let tradesThreads = $derived(
    allThreads
      .filter((t) => !t.archived && t.projectId !== INBOX_PROJECT_ID)
      .sort((a, b) => threadSort(a, b, null))
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
  })
</script>

<div class="flex h-full flex-col overflow-hidden bg-app text-foreground">
  <!-- Compact header: floating menu button · thread title · right icons -->
  <header class="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-surface px-2">
    <button
      type="button"
      class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted transition-colors hover:bg-elevated hover:text-foreground"
      aria-label="Open the sidebar"
      title="Open the sidebar"
      onclick={() => (sidebarOpen = true)}
    >
      <PanelLeft size={18} />
    </button>

    <div class="min-w-0 flex-1 px-1 text-center">
      <p class="truncate text-[13px] font-semibold tracking-tight">
        {selectedThread?.title ?? 'CodeInOven'}
      </p>
      {#if selectedProject && selectedThread}
        <p class="truncate text-[10px] text-dimmed">{selectedProject.name}</p>
      {/if}
    </div>

    <div class="flex shrink-0 items-center gap-0.5">
      <!-- History — jump to a past message. -->
      <button
        type="button"
        class="relative flex h-9 w-9 items-center justify-center rounded-xl text-muted transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Message history"
        title="Message history"
        disabled={workspaceState.messageCount === 0}
        onclick={() => (historyOpen = !historyOpen)}
      >
        <History size={16} />
      </button>

      <!-- Memory proposals. -->
      <button
        type="button"
        class="relative flex h-9 w-9 items-center justify-center rounded-xl text-muted transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Open memory"
        title="Open memory"
        onclick={() => (memoryOpen = !memoryOpen)}
      >
        <BrainCircuit size={16} />
        {#if memoryProposalState.hasPending}
          <span class="absolute top-0.5 right-0.5 flex items-start">
            <StatusBadge kind="attention" title="Memory proposals needing attention" />
          </span>
        {/if}
      </button>

      <!-- Spec studio. -->
      {#if selectedThread && workspaceState.specStudioAvailable}
        <button
          type="button"
          class="flex h-9 w-9 items-center justify-center rounded-xl text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label={workspaceState.specStudioOpen ? 'Close spec studio' : 'Open spec studio'}
          title={workspaceState.specStudioOpen ? 'Close spec studio' : 'Open spec studio'}
          onclick={() => workspaceState.toggleSpecStudio?.()}
        >
          <FileText size={16} />
        </button>
      {/if}

      <!-- Notifications. -->
      <button
        type="button"
        class="relative flex h-9 w-9 items-center justify-center rounded-xl text-muted transition-colors hover:bg-elevated hover:text-foreground"
        aria-label={`Open notifications (${notificationPanelState.totalCount})`}
        title="Open notifications"
        onclick={() => (notificationsOpen = !notificationsOpen)}
      >
        <Bell size={16} />
        {#if notificationPanelState.totalCount > 0}
          <span class="absolute top-0.5 right-0.5 flex items-start gap-px">
            {#if notificationPanelState.hasCompleted}
              <StatusBadge kind="completed" title="Completed notifications" />
            {/if}
            {#if notificationPanelState.hasAttention}
              <StatusBadge kind="attention" title="Notifications needing attention" />
            {/if}
          </span>
        {/if}
      </button>
    </div>
  </header>

  <!-- Conversation — the desktop ThreadView, reused as-is (it embeds the
       ChatComposer at the bottom). -->
  <main class="min-h-0 flex-1">
    {#if selectedThread}
      {#key selectedThread.id}
        <ThreadView
          thread={selectedThread}
          chatMode={selectedThread.projectId === INBOX_PROJECT_ID}
        />
      {/key}
    {:else}
      <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div class="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface">
          <MessageSquare size={22} class="text-primary" />
        </div>
        <p class="text-sm font-medium">Select a thread</p>
        <p class="max-w-60 text-xs leading-relaxed text-dimmed">
          Open the sidebar to browse your projects and conversations.
        </p>
        <button
          type="button"
          class="mt-1 flex h-9 items-center gap-1.5 rounded-xl bg-primary px-4 text-[13px] font-medium text-on-primary transition-colors hover:bg-primary-hover"
          onclick={() => (sidebarOpen = true)}
        >
          <PanelLeft size={14} />
          Open sidebar
        </button>
      </div>
    {/if}
  </main>

  <!-- History jump menu. -->
  {#if historyOpen}
    <div
      class="fixed inset-0 z-40 bg-black/40"
      role="presentation"
      onclick={() => (historyOpen = false)}
    ></div>
    <aside
      class="fixed right-0 bottom-0 left-0 z-50 max-h-[70vh] overflow-hidden rounded-t-2xl border-t border-border bg-surface shadow-2xl"
      aria-label="Jump to message"
    >
      <div class="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-dimmed">
          Your messages
        </p>
        <button
          type="button"
          class="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Close history"
          title="Close history"
          onclick={() => (historyOpen = false)}
        >
          <X size={15} />
        </button>
      </div>
      <div class="max-h-[calc(70vh-2.75rem)] overflow-y-auto p-1.5">
        {#each workspaceState.userMessages as message, index (message.id)}
          <button
            type="button"
            class="block w-full truncate rounded-lg px-3 py-2.5 text-left text-[13px] text-muted transition-colors hover:bg-elevated hover:text-foreground"
            title={message.content}
            onclick={() => historyJump(message.id)}
          >
            <span class="mr-1.5 tabular-nums text-dimmed">{index + 1}.</span>
            {message.content}
          </button>
        {:else}
          <p class="px-3 py-6 text-center text-xs text-dimmed">No messages yet</p>
        {/each}
      </div>
    </aside>
  {/if}

  <!-- Notifications sheet. -->
  {#if notificationsOpen}
    <div
      class="fixed inset-0 z-40 bg-black/40"
      role="presentation"
      onclick={() => (notificationsOpen = false)}
    ></div>
    <aside
      class="fixed right-0 bottom-0 left-0 z-50 flex max-h-[80vh] flex-col overflow-hidden rounded-t-2xl border-t border-border bg-surface shadow-2xl"
      aria-label="Notifications"
    >
      <div class="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-dimmed">
          Notifications
        </p>
        <button
          type="button"
          class="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Close notifications"
          title="Close notifications"
          onclick={() => (notificationsOpen = false)}
        >
          <X size={15} />
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <NotificationPanel />
      </div>
    </aside>
  {/if}

  <!-- Memory sheet. -->
  {#if memoryOpen}
    <div
      class="fixed inset-0 z-40 bg-black/40"
      role="presentation"
      onclick={() => (memoryOpen = false)}
    ></div>
    <aside
      class="fixed right-0 bottom-0 left-0 z-50 flex max-h-[80vh] flex-col overflow-hidden rounded-t-2xl border-t border-border bg-surface shadow-2xl"
      aria-label="Memory"
    >
      <div class="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-dimmed">Memory</p>
        <button
          type="button"
          class="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Close memory"
          title="Close memory"
          onclick={() => (memoryOpen = false)}
        >
          <X size={15} />
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-3">
        <MemoryPanel
          variant="sidebar"
          projectId={selectedThread?.projectId ?? selectedProject?.id}
          threadId={selectedThread?.id}
        />
      </div>
    </aside>
  {/if}

  <!-- Sidebar drawer. -->
  {#if sidebarOpen}
    <div
      class="fixed inset-0 z-50 bg-black/40"
      role="presentation"
      onclick={() => (sidebarOpen = false)}
    ></div>
    <aside
      class="fixed top-0 bottom-0 left-0 z-50 flex w-[86vw] max-w-80 flex-col border-r border-border bg-surface shadow-2xl"
      aria-label="Sidebar"
    >
      <!-- Sidebar header: mode dropdown + close. -->
      <div class="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
        <div class="relative min-w-0 flex-1">
          <select
            class="w-full appearance-none rounded-xl border border-border bg-elevated px-3 py-2 pr-8 text-[13px] font-medium outline-none focus:border-primary"
            bind:value={sidebarMode}
            aria-label="Switch sidebar view"
          >
            <option value="projects">Projects</option>
            <option value="trades">Trades</option>
            <option value="charts">Charts</option>
          </select>
          <ChevronDown
            size={14}
            class="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-dimmed"
          />
        </div>
        <button
          type="button"
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Close the sidebar"
          title="Close the sidebar"
          onclick={() => (sidebarOpen = false)}
        >
          <X size={16} />
        </button>
      </div>

      <!-- Search — the same ThreadSearchControl the desktop sidebar uses. -->
      <div class="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
        <ThreadSearchControl
          threads={allThreads.filter((t) => t.projectId !== INBOX_PROJECT_ID)}
          contextLabel="threads"
          title="Search threads"
          onOpen={openThread}
          fts={{ filter: (t) => t.projectId !== INBOX_PROJECT_ID && !t.archived }}
        />
        <span class="flex h-7 items-center gap-1 text-[11px] text-dimmed">
          <Search size={13} />
          Search
        </span>
      </div>

      <!-- Sidebar content — scrollable. -->
      <div class="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {#if loading}
          <div class="flex items-center gap-2 px-3 py-4 text-[13px] text-muted">
            <Loader2 size={14} class="animate-spin" />
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
                  <p class="px-2 py-1.5 text-[11px] text-dimmed">No threads yet</p>
                {/each}
              </div>
            {/if}
          {:else}
            <div class="flex flex-col items-center gap-2 px-2 py-10 text-center">
              <p class="text-xs text-muted">No projects yet</p>
              <p class="text-xs text-dimmed">Add a project on the desktop to get started</p>
            </div>
          {/each}
        {:else if sidebarMode === 'trades'}
          <div class="space-y-px" role="list">
            {#each tradesThreads as thread (thread.id)}
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
              <p class="px-2 py-10 text-center text-xs text-dimmed">No threads yet</p>
            {/each}
          </div>
        {:else}
          <!-- Charts — the desktop ScopeView board, reused as-is. -->
          <ScopeView navigateToProjects={() => (sidebarMode = 'projects')} />
        {/if}
      </div>

      <!-- Sidebar footer: the only setting is disconnect. -->
      <div class="shrink-0 border-t border-border p-2">
        <button
          type="button"
          class="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-elevated text-[13px] font-medium text-muted transition-colors hover:bg-danger/10 hover:text-danger"
          title="Disconnect from the desktop"
          onclick={() => onDisconnect()}
        >
          <X size={14} />
          Disconnect
        </button>
      </div>
    </aside>
  {/if}
</div>
