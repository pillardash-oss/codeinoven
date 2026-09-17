<script lang="ts">
  import { invoke } from '$lib/ipc.svelte'
  import {
    ChevronDown,
    Copy,
    Ellipsis,
    ExternalLink,
    Folder,
    FolderKanban,
    FolderOpen,
    FolderTree,
    MessageSquare,
    Pencil,
    Pin,
    PinOff,
    Plus,
    Trash2
  } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import type { SvelteMap } from 'svelte/reactivity'
  import CollapsibleSidebar from '$lib/components/layout/CollapsibleSidebar.svelte'
  import type { ScopeActionsController } from '$lib/components/scope/ScopeActionsController.svelte'
  import ProjectIdentity from '$lib/components/shared/ProjectIdentity.svelte'
  import ProjectSwitch from '$lib/components/shared/ProjectSwitch.svelte'
  import ScopeActionsMenu from '$lib/components/shared/ScopeActionsMenu.svelte'
  import ScopeBadge from '$lib/components/shared/ScopeBadge.svelte'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import ThreadSearchResultRow from '$lib/components/shared/ThreadSearchResultRow.svelte'
  import SpecConversationSidebar from '$lib/components/specs/SpecConversationSidebar.svelte'
  import PinnedSection from '$lib/components/threads/PinnedSection.svelte'
  import ThreadRow from '$lib/components/threads/ThreadRow.svelte'
  import { copyText } from '$lib/copy-text'
  import { keymapKeys } from '$lib/keymap/keymap'
  import { getProjectIcon, projectIconOnError } from '$lib/project-icons'
  import { pickColorForSeed } from '$lib/project-colors'
  import { hasProjectNameCollision } from '$lib/project-location'
  import { generateInitialsIconSvg, getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { pinnedFold } from '$lib/stores/pinned-fold.svelte'
  import { rendererRecovery, type MainView } from '$lib/stores/renderer-recovery.svelte'
  import { STAGE_COLORS, STAGE_LABELS, STAGE_ORDER, scopeState } from '$lib/stores/scope.svelte'
  import { threadProjectFilterState } from '$lib/stores/thread-project-filter.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { type Project, type Thread } from '$shared/types'
  import FolderRow from './FolderRow.svelte'
  import SidebarAccountControls from './SidebarAccountControls.svelte'
  import SidebarSearchControl from './SidebarSearchControl.svelte'
  import type { WorkspaceProjectDialogs } from './WorkspaceProjectDialogs.svelte'
  import type { WorkspaceSidebarController } from './WorkspaceSidebarController.svelte'
  import { filterThreadsByQuery, threadHasVisibleWork } from './workspace-thread-helpers'

  interface Props {
    mode: 'projects' | 'chats' | 'threads'
    active: boolean
    navigate: (view: MainView) => void
    scroller?: HTMLElement | null
    projects: Project[]
    visibleProjects: Project[]
    projectIcons: SvelteMap<string, string>
    /** True while the workspace's initial data load is in flight. */
    loading: boolean
    selectedThreadId: string | null
    threadsByProject: SvelteMap<string, Thread[]>
    pinnedThreads: Thread[]
    pinnedProjects: Project[]
    regularProjects: Project[]
    pinnedInboxThreads: Thread[]
    standaloneThreads: Thread[]
    pinnedTimelineThreads: Thread[]
    unpinnedTimelineThreads: Thread[]
    hasMoreHistory: boolean
    historyLoading: boolean
    projectPageLoading: string | null
    sidebar: WorkspaceSidebarController
    projectDialogs: WorkspaceProjectDialogs
    scopeActions: ScopeActionsController
    onSetProjects: (next: Project[]) => void
    onOpenThread: (thread: Thread) => void
    onRename: (thread: Thread, newName: string) => Promise<void>
    onTogglePin: (thread: Thread) => Promise<void>
    onDelete: (thread: Thread) => Promise<void>
    onFork: (thread: Thread) => Promise<void>
    onThreadMove: (
      projectId: string,
      draggedId: string,
      targetId: string,
      position: 'before' | 'after',
      includePinned?: boolean
    ) => Promise<void>
    onPinnedThreadMove: (
      draggedId: string,
      targetId: string,
      position: 'before' | 'after'
    ) => Promise<void>
    onTimelinePinnedMove: (
      draggedId: string,
      targetId: string,
      position: 'before' | 'after'
    ) => Promise<void>
    onProjectMove: (
      draggedId: string,
      targetId: string,
      position: 'before' | 'after'
    ) => Promise<void>
    onCreateThread: (project: Project, scopeBucketId?: string) => Promise<void>
    onOpenScopedThread: (thread: Thread) => Promise<void>
    onSwitchScopedProject: (projectId: string) => Promise<void>
    onLoadProjectThreadsPage: (projectId: string) => Promise<void>
    onLoadHistoryPage: () => Promise<void>
    projectHasMoreInDb: (projectId: string) => boolean
  }

  let {
    mode,
    active,
    navigate,
    scroller = $bindable(),
    projects,
    visibleProjects,
    projectIcons,
    loading,
    selectedThreadId,
    threadsByProject,
    pinnedThreads,
    pinnedProjects,
    regularProjects,
    pinnedInboxThreads,
    standaloneThreads,
    pinnedTimelineThreads,
    unpinnedTimelineThreads,
    hasMoreHistory,
    historyLoading,
    projectPageLoading,
    sidebar,
    projectDialogs,
    scopeActions,
    onSetProjects,
    onOpenThread,
    onRename,
    onTogglePin,
    onDelete,
    onFork,
    onThreadMove,
    onPinnedThreadMove,
    onTimelinePinnedMove,
    onProjectMove,
    onCreateThread,
    onOpenScopedThread,
    onSwitchScopedProject,
    onLoadProjectThreadsPage,
    onLoadHistoryPage,
    projectHasMoreInDb
  }: Props = $props()

  function getThreadIcon(thread: Thread): string | null {
    const project = projects.find((p) => p.id === thread.projectId)
    if (!project) return null
    return getProjectIcon(project, projectIcons.get(project.id))
  }

  function toggleFolder(projectId: string): void {
    if (sidebar.expandedFolders.has(projectId)) {
      sidebar.expandedFolders.delete(projectId)
      rendererRecovery.toggleCollapsedFolder(projectId)
    } else {
      sidebar.expandedFolders.add(projectId)
      rendererRecovery.toggleCollapsedFolder(projectId)
    }
  }

  // ─── Folder ellipsis menu actions ────────────────────────────────────────

  async function copyProjectPath(projectId: string): Promise<void> {
    const project = projects.find((p) => p.id === projectId)
    if (!project?.path) return
    try {
      await copyText(project.path)
    } catch {
      // Clipboard not available
    }
  }

  async function openInEditor(projectId: string): Promise<void> {
    await invoke('project:openInEditor', projectId)
  }

  async function toggleProjectPin(projectId: string): Promise<void> {
    const project = projects.find((p) => p.id === projectId)
    if (!project) return
    const updated = await invoke('project:setPinned', projectId, !project.pinned)
    onSetProjects(projects.map((p) => (p.id === updated.id ? updated : p)))
  }

  async function revealProjectInFileManager(projectId: string): Promise<void> {
    const project = projects.find((p) => p.id === projectId)
    if (!project || !project.path) return
    await invoke('shell:revealPath', project.path)
  }

  // Folder ellipsis menu
  let openProjectMenuId = $state<string | null>(null)

  let sidebarDropActive = $state(false)

  function carriesDroppedFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes('Files')
  }

  function handleSidebarDragOver(event: DragEvent): void {
    if (!carriesDroppedFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    sidebarDropActive = true
  }

  function handleSidebarDragLeave(event: DragEvent): void {
    const related = event.relatedTarget
    const current = event.currentTarget
    if (related instanceof Node && current instanceof Node && current.contains(related)) return
    sidebarDropActive = false
  }

  /**
   * Folders and files dropped on the project sidebar go through the same opener
   * the OS hand-off uses (main classifies each path, the app adds folders as
   * projects with de-duplication, and opens single files in the standalone
   * viewer). Routing both entry points through one path keeps the behavior
   * identical whether the folder arrived from Finder, Explorer, the taskbar, or
   * a drag into the sidebar.
   */
  async function handleSidebarDrop(event: DragEvent): Promise<void> {
    sidebarDropActive = false
    const files = event.dataTransfer?.files
    if (!files || files.length === 0) return
    const paths: string[] = []
    for (const file of Array.from(files)) {
      try {
        const path = window.api.getPathForFile(file)
        if (path) paths.push(path)
      } catch {
        // Not a local file (e.g. a web page image); ignore it.
      }
    }
    if (paths.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    try {
      await invoke('openWith:openPaths', paths)
    } catch (error) {
      reportError(error, 'The dropped items could not be opened')
    }
  }
</script>

<!-- Shared sidebar   shows Projects or Chats depending on the shell mode -->
{#if !workspaceState.specStudioOpen || workspaceState.specAgentSidebarOpen}
  <CollapsibleSidebar
    title={workspaceState.specStudioOpen
      ? 'Spec conversation'
      : mode === 'projects'
        ? 'Projects'
        : mode === 'threads'
          ? 'Threads'
          : 'Chats'}
    hideHeader={!workspaceState.specStudioOpen}
    bind:scroller
    fileDrop={{
      active: sidebarDropActive,
      onDragOver: handleSidebarDragOver,
      onDragLeave: handleSidebarDragLeave,
      onDrop: (event: DragEvent) => void handleSidebarDrop(event)
    }}
  >
    {#snippet header()}
      {#if workspaceState.specStudioOpen}
        <span class="text-[0.625rem] tabular-nums text-dimmed">
          {workspaceState.specAgentResponses.length}
        </span>
      {/if}
    {/snippet}

    {#snippet footer()}
      {#if !workspaceState.specStudioOpen}
        <SidebarAccountControls {active} {navigate} />
      {/if}
    {/snippet}

    {#if workspaceState.specStudioOpen}
      <SpecConversationSidebar />
    {:else if mode === 'projects' && scopeState.sidebarContext}
      {@const scopeContext = scopeState.sidebarContext}
      {@const scopeProject = projects.find((project) => project.id === scopeContext.projectId)}
      {@const scopeBucket = scopeState.buckets.find(
        (bucket) => bucket.id === scopeContext.bucketId
      )}
      {@const otherBuckets = scopeState.buckets.filter(
        (bucket) => bucket.id !== scopeContext.bucketId
      )}
      <div class="flex h-full flex-col">
        <!-- Board context bar: project identity + scope switcher sit right
               under the view/controls header -->
        <div
          class="flex shrink-0 items-center gap-2 border-b px-3 py-2"
          style:background-color={scopeProject?.color
            ? `color-mix(in srgb, ${scopeProject.color} 10%, var(--color-surface))`
            : undefined}
        >
          {#if scopeProject && getProjectIcon(scopeProject, projectIcons.get(scopeProject.id))}
            <img
              src={getProjectIcon(scopeProject, projectIcons.get(scopeProject.id))!}
              alt=""
              class="h-4 w-4 shrink-0 object-contain"
              onerror={projectIconOnError(scopeProject)}
            />
          {:else}
            <Folder size={14} class="shrink-0 text-muted" />
          {/if}
          {#if scopeProject}
            <ProjectIdentity
              project={scopeProject}
              class="min-w-0 flex-1"
              nameClass="text-xs font-semibold text-foreground"
              locationClass="text-[0.5625rem] text-dimmed"
              showLocation={hasProjectNameCollision(scopeProject, visibleProjects)}
            />
          {:else}
            <span class="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
              Project
            </span>
          {/if}
          {#if scopeBucket}
            {#if scopeBucket && scopeBucket.root.kind === 'worktree'}
              <span
                class="flex shrink-0 items-center"
                role="img"
                aria-label="Managed Git worktree scope on {scopeBucket.root.branch}"
                title="Managed Git worktree scope on {scopeBucket.root.branch}"
              >
                <FolderTree size={12} class="text-warning" />
              </span>
            {/if}
            <!-- The scope itself is the menu trigger: click or right-click it to
                   reach every scope action the scope board offers. -->
            <ScopeActionsMenu
              bucket={scopeBucket}
              actions={scopeActions}
              triggerClass="flex shrink-0 cursor-pointer items-center rounded-md transition-opacity hover:opacity-85"
              triggerTitle="Scope actions"
              menuClass="right-0 top-6"
            >
              {#snippet trigger()}
                <ScopeBadge bucket={scopeBucket} size="xs" />
              {/snippet}
            </ScopeActionsMenu>
          {/if}
          <ProjectSwitch
            activeProjectId={scopeProject?.id ?? null}
            class="h-5 w-5 shrink-0 text-dimmed hover:text-foreground"
            onSwitch={onSwitchScopedProject}
          >
            <FolderKanban size={12} />
          </ProjectSwitch>
        </div>

        {#if scopeActions.error}
          <div
            class="flex shrink-0 items-center gap-2 border-b bg-danger/10 px-3 py-1.5 text-xs text-danger"
          >
            <span class="min-w-0 flex-1">{scopeActions.error}</span>
            <button
              class="shrink-0 rounded-md px-1.5 py-0.5 transition-colors hover:bg-danger/10"
              aria-label="Dismiss scope action error"
              title="Dismiss"
              onclick={() => scopeActions.dismissError()}
            >
              Dismiss
            </button>
          </div>
        {/if}

        {#if otherBuckets.length > 0}
          <div class="shrink-0 border-b px-3 py-2">
            <div
              class="grid gap-1.5"
              class:grid-cols-1={otherBuckets.length === 1}
              class:grid-cols-2={otherBuckets.length > 1}
            >
              {#each otherBuckets as bucket (bucket.id)}
                {@const pinnedCount = scopeState.threadsFor(bucket.id, 'pinned').length}
                {@const todoCount = scopeState.threadsFor(bucket.id, 'todo').length}
                {@const workingCount = scopeState.threadsFor(bucket.id, 'working').length}
                {@const issueCount = scopeState.threadsFor(bucket.id, 'issue').length}
                {@const unreadCount = scopeState.threadsFor(bucket.id, 'unread').length}
                <div
                  class="group flex items-center gap-1 border-l-2 pl-2 pr-2.5 py-1.5 transition-colors hover:bg-elevated"
                  style:border-color={bucket.color ?? pickColorForSeed(bucket.id)}
                >
                  <button
                    class="relative flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-muted"
                    title={bucket.name}
                    onclick={() => scopeState.setSidebarBucket(bucket.id)}
                  >
                    <div class="absolute -top-1 left-0 flex gap-0.5">
                      {#if pinnedCount > 0}
                        <StatusBadge stage="pinned" title="Pinned threads" />
                      {/if}
                      {#if todoCount > 0}
                        <StatusBadge stage="todo" title="Todo threads" />
                      {/if}
                      {#if workingCount > 0}
                        <StatusBadge stage="working" title="Working threads" />
                      {/if}
                      {#if issueCount > 0}
                        <StatusBadge stage="issue" title="Issue threads" />
                      {/if}
                      {#if unreadCount > 0}
                        <StatusBadge stage="unread" title="Unread threads" />
                      {/if}
                    </div>
                    {#if bucket.iconType}
                      <img
                        src={getIconSvgDataUrl(
                          bucket.iconType,
                          bucket.color ?? pickColorForSeed(bucket.id)
                        )}
                        alt=""
                        class="h-3.5 w-3.5 shrink-0 object-contain"
                        draggable="false"
                      />
                    {:else if bucket.color}
                      <img
                        src={generateInitialsIconSvg(bucket.name, bucket.color)}
                        alt=""
                        class="h-3.5 w-3.5 shrink-0 object-contain"
                        draggable="false"
                      />
                    {/if}
                    {#if bucket.pinned}
                      <Pin size={10} class="shrink-0 text-accent" aria-hidden="true" />
                    {/if}
                    {#if bucket.root.kind === 'worktree'}
                      <span
                        class="flex shrink-0 items-center"
                        role="img"
                        aria-label="Managed Git worktree scope on {bucket.root.branch}"
                        title="Managed Git worktree scope on {bucket.root.branch}"
                      >
                        <FolderTree size={10} class="text-warning" />
                      </span>
                    {/if}
                    <span class="truncate">{bucket.name}</span>
                  </button>
                  <div class="opacity-0 transition-opacity group-hover:opacity-100">
                    <ScopeActionsMenu {bucket} actions={scopeActions} />
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        {#key scopeContext.bucketId}
          <div class="flex flex-1 min-h-0">
            <!-- Stage rail: slices share the full sidebar height, growing to
                   fill available space and shrinking to their floor when tight -->
            <div class="flex min-h-0 shrink-0 flex-col items-stretch border-r py-2 gap-1.5 w-11">
              {#each STAGE_ORDER as stage (stage)}
                {@const stageCount = scopeState.threadsFor(scopeContext.bucketId, stage).length}
                {@const isActive = scopeContext.stage === stage}
                {@const bgOpacity = isActive ? '35%' : '8%'}
                <button
                  class="flex min-h-12 flex-1 items-center justify-center rounded-md transition-all text-xs font-medium"
                  style="background-color: color-mix(in srgb, {STAGE_COLORS[
                    stage
                  ]} {bgOpacity}, transparent); color: {isActive
                    ? 'var(--color-foreground)'
                    : 'var(--color-muted)'}"
                  onclick={() => scopeState.selectSidebarStage(stage)}
                >
                  <span class="-rotate-90 flex flex-row items-center gap-3">
                    {#if stageCount > 0}
                      <span class="font-bold">{stageCount}</span>
                    {/if}
                    <span>{STAGE_LABELS[stage]}</span>
                  </span>
                </button>
              {/each}
            </div>

            <div class="flex flex-1 flex-col min-w-0">
              <div class="flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
                <StatusBadge stage={scopeContext.stage} size="md" />
                <span class="text-xs font-semibold">{STAGE_LABELS[scopeContext.stage]}</span>
                {#if scopeState.threadsFor(scopeContext.bucketId, scopeContext.stage).length > 0}
                  <span class="tabular-nums text-[0.625rem] text-dimmed"
                    >{scopeState.threadsFor(scopeContext.bucketId, scopeContext.stage).length}</span
                  >
                {/if}
              </div>
              <div class="flex-1 overflow-y-auto">
                {#each scopeState.threadsFor(scopeContext.bucketId, scopeContext.stage) as thread (thread.id)}
                  <ThreadRow
                    {thread}
                    selected={selectedThreadId === thread.id}
                    compact
                    hideScope
                    onOpen={onOpenScopedThread}
                    {onRename}
                    {onTogglePin}
                    {onDelete}
                    {onFork}
                  />
                {:else}
                  <p class="px-4 py-8 text-center text-xs text-dimmed">No threads in this slice</p>
                {/each}
                {#if scopeState.threadsFor(scopeContext.bucketId, scopeContext.stage).length > 0 && projectHasMoreInDb(scopeContext.projectId) && !scopeState.isProjectFullyHydrated(scopeContext.projectId)}
                  <div class="flex justify-center border-t py-1.5">
                    <button
                      class="flex items-center justify-center gap-1 px-3 py-1.5 text-[0.6875rem] text-dimmed transition-colors hover:text-foreground disabled:cursor-wait"
                      disabled={projectPageLoading === scopeContext.projectId}
                      onclick={() => void onLoadProjectThreadsPage(scopeContext.projectId)}
                    >
                      {projectPageLoading === scopeContext.projectId
                        ? 'Loading…'
                        : 'Load older threads'}
                    </button>
                  </div>
                {/if}
              </div>
            </div>
          </div>
        {/key}

        <!-- Scope action dialogs (edit, delete, worktree lifecycle, merge).
               Loaded on demand so their heavy worktree forms stay out of the
               main shell chunk. -->
        {#await import('../scope/ScopeActionsModals.svelte') then { default: ScopeActionsModals }}
          <ScopeActionsModals actions={scopeActions} />
        {/await}
      </div>
    {:else if loading}
      <p class="px-2 py-4 text-sm text-dimmed">Loading...</p>
    {:else}
      <!-- Only the active list stays mounted. Keeping inactive lists in the DOM
             duplicated every row component, observer, and derived calculation. -->
      {#if mode === 'chats'}
        {#if pinnedInboxThreads.length > 0}
          <PinnedSection
            sectionKey="chats"
            label="Pinned Chats"
            threads={pinnedInboxThreads}
            selectedThreadId={selectedThreadId ?? null}
            getRowIcon={() => null}
            onOpen={onOpenThread}
            {onRename}
            {onTogglePin}
            {onDelete}
            {onFork}
            onMovePinnedThread={(draggedId, targetId, pos) => {
              const thread = pinnedInboxThreads.find((t) => t.id === draggedId)
              if (thread) onThreadMove(thread.projectId, draggedId, targetId, pos)
            }}
          />
        {/if}

        {#if standaloneThreads.length > 0}
          <div class="space-y-px" role="list">
            {#each standaloneThreads.slice(0, 50) as thread (thread.id)}
              <ThreadRow
                {thread}
                selected={selectedThreadId === thread.id}
                onOpen={onOpenThread}
                {onRename}
                {onTogglePin}
                {onDelete}
                {onFork}
                onMoveThread={(draggedId, targetId, pos) =>
                  onThreadMove(thread.projectId, draggedId, targetId, pos)}
              />
            {/each}
          </div>
        {:else if pinnedInboxThreads.length === 0}
          <div class="flex flex-col items-center gap-2 px-2 py-10 text-center">
            <MessageSquare size={20} class="text-dimmed" />
            <p class="text-xs text-muted">No chats yet</p>
            <p class="text-xs text-dimmed">Start a new chat to get going</p>
          </div>
        {/if}
      {/if}
      {#if mode === 'threads'}
        {#if sidebar.threadsSearchOpen && sidebar.threadsSearchQuery.trim()}
          <!-- Threads search: results render inline in the sidebar so the user
                 can open several results without the search dismissing. -->
          {#if sidebar.threadsSearching && sidebar.threadsSearchResults.length === 0}
            <p class="px-2 py-6 text-center text-xs text-dimmed">Searching…</p>
          {:else if sidebar.threadsSearchResults.length === 0}
            <p class="px-2 py-6 text-center text-xs text-dimmed">No matching threads</p>
          {:else}
            <div class="space-y-px" role="list">
              {#each sidebar.threadsSearchResults as result (result.thread.id)}
                <ThreadSearchResultRow
                  {result}
                  selected={selectedThreadId === result.thread.id}
                  onOpen={onOpenThread}
                />
              {/each}
            </div>
          {/if}
        {:else}
          <!-- Threads mode: pinned section then flat list -->
          <PinnedSection
            sectionKey="threads"
            label="Pinned Threads"
            threads={pinnedTimelineThreads}
            selectedThreadId={selectedThreadId ?? null}
            getRowIcon={(t) => getThreadIcon(t)}
            onOpen={onOpenThread}
            {onRename}
            {onTogglePin}
            {onDelete}
            {onFork}
            onMovePinnedThread={(draggedId, targetId, pos) =>
              onTimelinePinnedMove(draggedId, targetId, pos)}
          />
          <div class="space-y-px" role="list">
            {#each unpinnedTimelineThreads as thread (thread.id)}
              <ThreadRow
                {thread}
                projectIconUrl={getThreadIcon(thread)}
                selected={selectedThreadId === thread.id}
                onOpen={onOpenThread}
                {onRename}
                {onTogglePin}
                {onDelete}
                {onFork}
              />
            {:else}
              <div class="flex flex-col items-center gap-2 px-2 py-10 text-center">
                <p class="text-xs text-muted">
                  {threadProjectFilterState.isAll
                    ? 'No threads yet'
                    : 'No threads in the selected projects'}
                </p>
              </div>
            {/each}
          </div>
          {#if hasMoreHistory}
            <button
              class="mt-2 flex w-full items-center justify-center gap-1 px-3 py-1.5 text-[0.6875rem] text-dimmed transition-colors hover:text-foreground disabled:cursor-wait"
              disabled={historyLoading}
              onclick={() => void onLoadHistoryPage()}
            >
              {historyLoading ? 'Loading history…' : 'Load older threads'}
            </button>
          {/if}
        {/if}
      {/if}
      {#if mode === 'projects'}
        <!-- Pinned threads above everything -->
        <PinnedSection
          sectionKey="projects-threads"
          label="Pinned Threads"
          threads={pinnedThreads}
          selectedThreadId={selectedThreadId ?? null}
          getRowIcon={(t) => {
            const project = projects.find((p) => p.id === t.projectId)
            return project ? getProjectIcon(project, projectIcons.get(project.id)) : null
          }}
          onOpen={onOpenThread}
          {onRename}
          {onTogglePin}
          {onDelete}
          {onFork}
          onMovePinnedThread={onPinnedThreadMove}
        />

        <!-- Pinned projects -->
        {#if pinnedProjects.length > 0}
          <div class="mb-1 pb-2 border-b">
            <button
              type="button"
              class="flex w-full items-center gap-1.5 px-2 pt-1 pb-0.5 text-left transition-colors hover:bg-overlay"
              aria-expanded={!pinnedFold.isFolded('projects-projects')}
              aria-label="{pinnedFold.isFolded('projects-projects')
                ? 'Expand'
                : 'Fold'} Pinned Projects"
              title="{pinnedFold.isFolded('projects-projects') ? 'Expand' : 'Fold'} Pinned Projects"
              onclick={() => pinnedFold.toggle('projects-projects')}
            >
              <ChevronDown
                size={12}
                class="shrink-0 text-dimmed transition-transform {pinnedFold.isFolded(
                  'projects-projects'
                )
                  ? '-rotate-90'
                  : ''}"
              />
              <span class="text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed"
                >Pinned Projects</span
              >
              <span class="text-[0.625rem] text-dimmed/70">{pinnedProjects.length}</span>
            </button>
            <div class="space-y-px" role="list">
              {#if !pinnedFold.isFolded('projects-projects')}
                {#each pinnedProjects as project (project.id)}
                  {@const folderThreads = threadsByProject.get(project.id) ?? []}
                  {@const expanded =
                    sidebar.expandedFolders.has(project.id) ||
                    sidebar.projectSearchOpen.has(project.id)}
                  {@const working = folderThreads.some((thread) => threadHasVisibleWork(thread))}
                  <DropdownMenu.Root
                    open={openProjectMenuId === project.id}
                    onOpenChange={(o) => {
                      openProjectMenuId = o ? project.id : null
                    }}
                  >
                    <div>
                      <FolderRow
                        {project}
                        iconUrl={projectIcons.get(project.id) ?? null}
                        {expanded}
                        {working}
                        showLocation={hasProjectNameCollision(project, visibleProjects)}
                        onToggle={() => toggleFolder(project.id)}
                        onMoveProject={(draggedId, targetId, pos) =>
                          onProjectMove(draggedId, targetId, pos)}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          openProjectMenuId = project.id
                        }}
                      >
                        {#snippet actions()}
                          <span class="flex shrink-0 items-center gap-0.5">
                            <SidebarSearchControl
                              open={sidebar.projectSearchOpen.has(project.id)}
                              query={sidebar.projectSearchQueries.get(project.id) ?? ''}
                              onOpenChange={(open) => {
                                if (open) sidebar.openProjectSearch(project.id)
                                else sidebar.closeProjectSearch(project.id)
                              }}
                              onQueryChange={(value) => {
                                sidebar.projectSearchQueries.set(project.id, value)
                                sidebar.runProjectSearch(project.id, value)
                              }}
                              ariaLabel="Search threads in {project.name}"
                              title="Search threads"
                              placeholder="Search threads in {project.name}…"
                            />
                            <button
                              class="flex h-5 w-5 items-center justify-center rounded text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
                              aria-label="New thread in {project.name}"
                              title="New thread"
                              data-shortcut={keymapKeys('nav-new-thread').join(',')}
                              onclick={() => onCreateThread(project)}
                            >
                              <Plus size={12} />
                            </button>
                            <DropdownMenu.Trigger
                              class="flex h-5 w-5 items-center justify-center rounded text-dimmed transition-colors hover:bg-overlay hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
                              aria-label="Options for {project.name}"
                              title="Project options"
                              oncontextmenu={(e: MouseEvent) => e.preventDefault()}
                            >
                              <Ellipsis size={12} />
                            </DropdownMenu.Trigger>
                          </span>
                        {/snippet}
                      </FolderRow>
                      {#if expanded}
                        {@const searchQ = sidebar.projectSearchQueries.get(project.id) ?? ''}
                        {@const isSearching = Boolean(searchQ.trim())}
                        {@const searchResults = sidebar.projectSearchResults.get(project.id) ?? []}
                        {@const filteredThreads = isSearching
                          ? []
                          : filterThreadsByQuery(folderThreads, '')}
                        <div class="ml-2">
                          {#if isSearching && sidebar.projectSearching.has(project.id) && searchResults.length === 0}
                            <p class="px-2 py-1.5 text-[0.6875rem] text-dimmed">Searching…</p>
                          {:else if (isSearching ? searchResults.length : filteredThreads.length) === 0}
                            <p class="px-2 py-1.5 text-[0.6875rem] text-dimmed">
                              {searchQ.trim() ? 'No matching threads' : 'No threads yet'}
                            </p>
                          {:else if isSearching}
                            <div
                              class="max-h-80 space-y-px overflow-y-auto overscroll-contain py-0.5"
                              role="list"
                            >
                              {#each searchResults as result (result.thread.id)}
                                <ThreadSearchResultRow
                                  {result}
                                  selected={selectedThreadId === result.thread.id}
                                  onOpen={onOpenThread}
                                />
                              {/each}
                            </div>
                          {:else}
                            <div class="space-y-px py-0.5" role="list">
                              {#each filteredThreads.slice(0, sidebar.getVisibleCount(project.id)) as thread (thread.id)}
                                <ThreadRow
                                  {thread}
                                  selected={selectedThreadId === thread.id}
                                  onOpen={onOpenThread}
                                  {onRename}
                                  {onTogglePin}
                                  {onDelete}
                                  {onFork}
                                  onMoveThread={(draggedId, targetId, pos) =>
                                    onThreadMove(project.id, draggedId, targetId, pos)}
                                />
                              {/each}
                            </div>
                            {#if filteredThreads.length > sidebar.getVisibleCount(project.id)}
                              <button
                                class="flex w-full items-center justify-center gap-1 px-3 py-1.5 text-[0.6875rem] text-dimmed transition-colors hover:text-foreground"
                                onclick={() =>
                                  sidebar.showMoreThreads(project.id, filteredThreads.length)}
                              >
                                Show {filteredThreads.length - sidebar.getVisibleCount(project.id)} more
                              </button>
                            {:else if sidebar.getVisibleCount(project.id) >= filteredThreads.length && filteredThreads.length > 0 && projectHasMoreInDb(project.id)}
                              <button
                                class="flex w-full items-center justify-center gap-1 px-3 py-1.5 text-[0.6875rem] text-dimmed transition-colors hover:text-foreground disabled:cursor-wait"
                                disabled={projectPageLoading === project.id}
                                onclick={() => void onLoadProjectThreadsPage(project.id)}
                              >
                                {projectPageLoading === project.id
                                  ? 'Loading…'
                                  : 'Load older threads'}
                              </button>
                            {/if}
                            {#if sidebar.getVisibleCount(project.id) > sidebar.threadsPerPage}
                              <button
                                class="flex w-full items-center justify-center gap-1 px-3 py-1.5 text-[0.6875rem] text-dimmed transition-colors hover:text-foreground"
                                onclick={() => sidebar.showLessThreads(project.id)}
                              >
                                Show less
                              </button>
                            {/if}
                          {/if}
                        </div>
                      {/if}
                    </div>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        side="bottom"
                        align="end"
                        sideOffset={4}
                        collisionPadding={8}
                        class="z-50 w-48 overflow-hidden rounded-xl border bg-surface p-1 shadow-lg"
                      >
                        <DropdownMenu.Item
                          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                          onSelect={() => projectDialogs.askEditProject(project.id)}
                        >
                          <Pencil size={14} class="text-muted" />
                          Edit Project
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                          onSelect={() => openInEditor(project.id)}
                        >
                          <ExternalLink size={14} class="text-muted" />
                          Open in Editor
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                          onSelect={() => copyProjectPath(project.id)}
                        >
                          <Copy size={14} class="text-muted" />
                          Copy Path
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                          onSelect={() => revealProjectInFileManager(project.id)}
                        >
                          <FolderOpen size={14} class="text-muted" />
                          {navigator.platform.toUpperCase().indexOf('MAC') >= 0
                            ? 'Reveal in File Manager'
                            : 'Show in Explorer'}
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                          onSelect={() => toggleProjectPin(project.id)}
                        >
                          {#if project.pinned}
                            <PinOff size={14} class="text-muted" />
                            Unpin Project
                          {:else}
                            <Pin size={14} class="text-muted" />
                            Pin Project
                          {/if}
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator class="mx-2 my-1 h-px bg-border" />
                        <DropdownMenu.Item
                          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-danger outline-none transition-colors hover:bg-danger/10 focus:bg-danger/10"
                          onSelect={() => projectDialogs.askRemoveProject(project.id)}
                        >
                          <Trash2 size={14} />
                          Remove Project
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                {/each}
              {/if}
            </div>
          </div>
        {/if}

        <!-- Folder tree -->
        {#if regularProjects.length === 0 && pinnedProjects.length === 0}
          <div class="flex flex-col items-center gap-2 px-2 py-10 text-center">
            <FolderOpen size={20} class="text-dimmed" />
            <p class="text-xs text-muted">No projects yet</p>
            <p class="text-xs text-dimmed">Add a folder to get started</p>
          </div>
        {:else if regularProjects.length > 0}
          <div class="space-y-0.5" role="list">
            {#each regularProjects as project (project.id)}
              {@const folderThreads = threadsByProject.get(project.id) ?? []}
              {@const expanded =
                sidebar.expandedFolders.has(project.id) ||
                sidebar.projectSearchOpen.has(project.id)}
              {@const working = folderThreads.some((thread) => threadHasVisibleWork(thread))}
              <DropdownMenu.Root
                open={openProjectMenuId === project.id}
                onOpenChange={(o) => {
                  openProjectMenuId = o ? project.id : null
                }}
              >
                <div>
                  <FolderRow
                    {project}
                    iconUrl={projectIcons.get(project.id) ?? null}
                    {expanded}
                    {working}
                    showLocation={hasProjectNameCollision(project, visibleProjects)}
                    onToggle={() => toggleFolder(project.id)}
                    onMoveProject={(draggedId, targetId, pos) =>
                      onProjectMove(draggedId, targetId, pos)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      openProjectMenuId = project.id
                    }}
                  >
                    {#snippet actions()}
                      <span class="flex shrink-0 items-center gap-0.5">
                        <SidebarSearchControl
                          open={sidebar.projectSearchOpen.has(project.id)}
                          query={sidebar.projectSearchQueries.get(project.id) ?? ''}
                          onOpenChange={(open) => {
                            if (open) sidebar.openProjectSearch(project.id)
                            else sidebar.closeProjectSearch(project.id)
                          }}
                          onQueryChange={(value) => {
                            sidebar.projectSearchQueries.set(project.id, value)
                            sidebar.runProjectSearch(project.id, value)
                          }}
                          ariaLabel="Search threads in {project.name}"
                          title="Search threads"
                          placeholder="Search threads in {project.name}…"
                        />
                        <button
                          class="flex h-5 w-5 items-center justify-center rounded text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
                          aria-label="New thread in {project.name}"
                          title="New thread"
                          data-shortcut={keymapKeys('nav-new-thread').join(',')}
                          onclick={() => onCreateThread(project)}
                        >
                          <Plus size={12} />
                        </button>
                        <DropdownMenu.Trigger
                          class="flex h-5 w-5 items-center justify-center rounded text-dimmed transition-colors hover:bg-overlay hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
                          aria-label="Options for {project.name}"
                          title="Project options"
                          oncontextmenu={(e: MouseEvent) => e.preventDefault()}
                        >
                          <Ellipsis size={12} />
                        </DropdownMenu.Trigger>
                      </span>
                    {/snippet}
                  </FolderRow>

                  <!-- Threads under folder -->
                  {#if expanded}
                    {@const searchQ = sidebar.projectSearchQueries.get(project.id) ?? ''}
                    {@const isSearching = Boolean(searchQ.trim())}
                    {@const searchResults = sidebar.projectSearchResults.get(project.id) ?? []}
                    {@const filteredThreads = isSearching
                      ? []
                      : filterThreadsByQuery(folderThreads, '')}
                    <div class="ml-2">
                      {#if isSearching && sidebar.projectSearching.has(project.id) && searchResults.length === 0}
                        <p class="px-2 py-1.5 text-[0.6875rem] text-dimmed">Searching…</p>
                      {:else if (isSearching ? searchResults.length : filteredThreads.length) === 0}
                        <p class="px-2 py-1.5 text-[0.6875rem] text-dimmed">
                          {searchQ.trim() ? 'No matching threads' : 'No threads yet'}
                        </p>
                      {:else if isSearching}
                        <div
                          class="max-h-80 space-y-px overflow-y-auto overscroll-contain py-0.5"
                          role="list"
                        >
                          {#each searchResults as result (result.thread.id)}
                            <ThreadSearchResultRow
                              {result}
                              selected={selectedThreadId === result.thread.id}
                              onOpen={onOpenThread}
                            />
                          {/each}
                        </div>
                      {:else}
                        <div class="space-y-px py-0.5" role="list">
                          {#each filteredThreads.slice(0, sidebar.getVisibleCount(project.id)) as thread (thread.id)}
                            <ThreadRow
                              {thread}
                              selected={selectedThreadId === thread.id}
                              onOpen={onOpenThread}
                              {onRename}
                              {onTogglePin}
                              {onDelete}
                              {onFork}
                              onMoveThread={(draggedId, targetId, pos) =>
                                onThreadMove(project.id, draggedId, targetId, pos)}
                            />
                          {/each}
                        </div>
                        {#if filteredThreads.length > sidebar.getVisibleCount(project.id)}
                          <button
                            class="flex w-full items-center justify-center gap-1 px-3 py-1.5 text-[0.6875rem] text-dimmed transition-colors hover:text-foreground"
                            onclick={() =>
                              sidebar.showMoreThreads(project.id, filteredThreads.length)}
                          >
                            Show {filteredThreads.length - sidebar.getVisibleCount(project.id)} more
                          </button>
                        {:else if sidebar.getVisibleCount(project.id) >= filteredThreads.length && filteredThreads.length > 0 && projectHasMoreInDb(project.id)}
                          <button
                            class="flex w-full items-center justify-center gap-1 px-3 py-1.5 text-[0.6875rem] text-dimmed transition-colors hover:text-foreground disabled:cursor-wait"
                            disabled={projectPageLoading === project.id}
                            onclick={() => void onLoadProjectThreadsPage(project.id)}
                          >
                            {projectPageLoading === project.id ? 'Loading…' : 'Load older threads'}
                          </button>
                        {/if}
                        {#if sidebar.getVisibleCount(project.id) > sidebar.threadsPerPage}
                          <button
                            class="flex w-full items-center justify-center gap-1 px-3 py-1.5 text-[0.6875rem] text-dimmed transition-colors hover:text-foreground"
                            onclick={() => sidebar.showLessThreads(project.id)}
                          >
                            Show less
                          </button>
                        {/if}
                      {/if}
                    </div>
                  {/if}
                </div>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    side="bottom"
                    align="end"
                    sideOffset={4}
                    collisionPadding={8}
                    class="z-50 w-48 overflow-hidden rounded-xl border bg-surface p-1 shadow-lg"
                  >
                    <DropdownMenu.Item
                      class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                      onSelect={() => projectDialogs.askEditProject(project.id)}
                    >
                      <Pencil size={14} class="text-muted" />
                      Edit Project
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                      onSelect={() => openInEditor(project.id)}
                    >
                      <ExternalLink size={14} class="text-muted" />
                      Open in Editor
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                      onSelect={() => copyProjectPath(project.id)}
                    >
                      <Copy size={14} class="text-muted" />
                      Copy Path
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                      onSelect={() => revealProjectInFileManager(project.id)}
                    >
                      <FolderOpen size={14} class="text-muted" />
                      {navigator.platform.toUpperCase().indexOf('MAC') >= 0
                        ? 'Reveal in File Manager'
                        : 'Show in Explorer'}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                      onSelect={() => toggleProjectPin(project.id)}
                    >
                      {#if project.pinned}
                        <PinOff size={14} class="text-muted" />
                        Unpin Project
                      {:else}
                        <Pin size={14} class="text-muted" />
                        Pin Project
                      {/if}
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator class="mx-2 my-1 h-px bg-border" />
                    <DropdownMenu.Item
                      class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-danger outline-none transition-colors hover:bg-danger/10 focus:bg-danger/10"
                      onSelect={() => projectDialogs.askRemoveProject(project.id)}
                    >
                      <Trash2 size={14} />
                      Remove Project
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            {/each}
          </div>
        {/if}
      {/if}
    {/if}
  </CollapsibleSidebar>
{/if}
