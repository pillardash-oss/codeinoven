<script lang="ts">
  import { filterThreadsByQuery } from '../workspace-thread-helpers'
  import { threadMediaActivity } from '$lib/speech/thread-media-activity.svelte'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import { onDestroy } from 'svelte'
  import { slide } from 'svelte/transition'
  import { DropdownMenu } from 'bits-ui'
  import { toast } from 'svelte-sonner'
  import CioArchive from '@pdslng/cio-icon/CioArchive.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import CioEllipsis from '@pdslng/cio-icon/CioEllipsis.svelte'
  import CioExternalLink from '@pdslng/cio-icon/CioExternalLink.svelte'
  import CioFolderOpen from '@pdslng/cio-icon/CioFolderOpen.svelte'
  import CioKey from '@pdslng/cio-icon/CioKey.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioPin from '@pdslng/cio-icon/CioPin.svelte'
  import CioPinOff from '@pdslng/cio-icon/CioPinOff.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import EmptyState from '$lib/components/ui/EmptyState.svelte'
  import PinnedSection from '$lib/components/threads/PinnedSection.svelte'
  import ThreadRow from '$lib/components/threads/ThreadRow.svelte'
  import ThreadSearchResultRow from '$lib/components/shared/ThreadSearchResultRow.svelte'
  import { foldDuration, foldSlide } from '$lib/components/shared/card-motion'
  import { archiveItem } from '$lib/archive-actions'
  import { copyText } from '$lib/copy-text'
  import { invoke } from '$lib/ipc.svelte'
  import { encodeShortcutTokens } from '$lib/keymap/keymap'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { osFileManagerLabel, revealInOsFileManager } from '$lib/os-file-manager'
  import { getProjectIcon } from '$lib/project-icons'
  import { hasProjectNameCollision } from '$lib/project-location'
  import { pinnedFold } from '$lib/stores/pinned-fold.svelte'
  import { projectDeletionState } from '$lib/stores/project-deletion.svelte'
  import { projectEnvDock } from '$lib/stores/project-env-dock.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { foldedSectionRows } from '$lib/thread-section-rows'
  import { emptyThreadStateCounts, type ThreadStateCounts } from '$lib/thread-state-counts'
  import type { Project, Thread } from '$shared/types'
  import FolderRow from '../FolderRow.svelte'
  import SidebarProjectSearchField from '../SidebarProjectSearchField.svelte'
  import SidebarSearchControl from '../SidebarSearchControl.svelte'
  import type { WorkspaceProjectDialogs } from '../WorkspaceProjectDialogs.svelte'
  import type { WorkspaceSidebarController } from '../WorkspaceSidebarController.svelte'
  import { moveThreadInList } from '../sidebar-thread-drop'
  import type { ThreadOrderSettle } from '../thread-order-settle.svelte'
  import { projectOrderKey } from './workspace-sidebar-keys'

  /**
   * The Projects panel's tree: the pinned threads block, the pinned folder block
   * and the regular folder list, with each folder's own thread list, its search
   * field and its ellipsis menu.
   *
   * It owns only what a folder needs to behave like a folder: which menu is open,
   * which fold is still playing (so a folded folder's peek row waits for it), and
   * the folder row's menu actions. Everything it draws comes from the sidebar's
   * controller and the workspace handlers it is handed, so the panel root stays
   * the one place that knows which lists exist.
   */
  interface Props {
    projects: Project[]
    visibleProjects: Project[]
    projectIcons: SvelteMap<string, string>
    threadsByProject: SvelteMap<string, Thread[]>
    activeThreadId: string | null
    pinnedThreadsShown: Thread[]
    pinnedProjectsShown: Project[]
    regularProjectsShown: Project[]
    /** The panel search's query, so a matching-empty tree says so. */
    projectsQuery: string
    projectStateCounts: ReadonlyMap<string, ThreadStateCounts>
    threadOrderSettle: ThreadOrderSettle
    sidebar: WorkspaceSidebarController
    projectDialogs: WorkspaceProjectDialogs
    projectPageLoading: string | null
    onOpenThread: (thread: Thread) => void
    onRename: (thread: Thread, newName: string) => Promise<void>
    onTogglePin: (thread: Thread) => Promise<void>
    onDelete: (thread: Thread) => Promise<void>
    onFork: (thread: Thread) => Promise<void>
    onThreadDrop: (projectId: string, ordered: Thread[], draggedId: string) => Promise<void>
    onPinnedThreadMove: (
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
    onSetProjects: (next: Project[]) => void
    onLoadProjectThreadsPage: (projectId: string) => Promise<void>
    projectHasMoreInDb: (projectId: string) => boolean
  }

  let {
    projects,
    visibleProjects,
    projectIcons,
    threadsByProject,
    activeThreadId,
    pinnedThreadsShown,
    pinnedProjectsShown,
    regularProjectsShown,
    projectsQuery,
    projectStateCounts,
    threadOrderSettle,
    sidebar,
    projectDialogs,
    projectPageLoading,
    onOpenThread,
    onRename,
    onTogglePin,
    onDelete,
    onFork,
    onThreadDrop,
    onPinnedThreadMove,
    onProjectMove,
    onCreateThread,
    onSetProjects,
    onLoadProjectThreadsPage,
    projectHasMoreInDb
  }: Props = $props()

  function toggleFolder(projectId: string): void {
    if (sidebar.expandedFolders.has(projectId)) {
      sidebar.expandedFolders.delete(projectId)
      // Folding resets the folder's row budget so re-expanding shows the
      // default page, exactly as if the user had clicked "Show less".
      sidebar.showLessThreads(projectId)
      rendererRecovery.toggleCollapsedFolder(projectId)
      settleFold(projectId)
    } else {
      sidebar.expandedFolders.add(projectId)
      rendererRecovery.toggleCollapsedFolder(projectId)
      if (foldingProjectId === projectId) foldingProjectId = null
    }
  }

  /**
   * The project whose fold is still playing, so its peek row waits for it.
   *
   * A folded folder keeps the one thread the user is working in on screen, but
   * that row may not mount in the same frame as the fold: an outgoing `slide`
   * holds the list in flow while its height collapses, so a peek row drawn
   * beside it would show the active thread twice for the length of the fold.
   * One folder is folded at a time, so one id is all the state this needs.
   */
  let foldingProjectId = $state<string | null>(null)
  let foldSettleTimer: ReturnType<typeof setTimeout> | undefined

  function settleFold(projectId: string): void {
    clearTimeout(foldSettleTimer)
    const settle = foldDuration()
    if (settle <= 0) {
      foldingProjectId = null
      return
    }
    foldingProjectId = projectId
    foldSettleTimer = setTimeout(() => (foldingProjectId = null), settle)
  }

  onDestroy(() => clearTimeout(foldSettleTimer))

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
    await revealInOsFileManager(project.path)
  }

  // Folder ellipsis menu
  let openProjectMenuId = $state<string | null>(null)
</script>

<!-- The detailed row both project folder lists draw, and the one row a folded
     folder keeps on screen for the thread the user is working in. One markup for
     every place a folder's row is drawn, so a peeked row and a listed row stay
     the same row, with the same bookmark, drag and menu behavior. -->
{#snippet folderThreadRow(thread: Thread, projectId: string, siblings: readonly Thread[])}
  <ThreadRow
    {thread}
    detailed
    hideProjectName
    selected={activeThreadId === thread.id}
    onOpen={onOpenThread}
    {onRename}
    {onTogglePin}
    showBookmark
    onBookmark={async (target) => {
      try {
        const updated = await invoke('thread:setBookmarked', target.projectId, target.id, true)
        workspaceState.updateThread(updated)
        scopeState.updateThread(updated)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Could not bookmark thread.')
      }
    }}
    {onDelete}
    {onFork}
    onMoveThread={(draggedId, targetId, position) => {
      const ordered = moveThreadInList(siblings, draggedId, targetId, position)
      if (ordered) void onThreadDrop(projectId, ordered, draggedId)
    }}
  />
{/snippet}

<!-- Pinned threads above everything. This block owns its rows, so it
         sticks on its own wrapper: the header stays put while the pinned
         rows pass under it and the pinned-projects block below pushes it
         out, exactly as the threads view's own pinned block does. -->
<PinnedSection
  sectionKey="projects-threads"
  label="Pinned Threads"
  threads={pinnedThreadsShown.filter((thread) => !thread.bookmarked)}
  detailed
  sticky
  activeThreadId={activeThreadId ?? null}
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
{#if pinnedProjectsShown.length > 0}
  <div class="mb-1 pb-2">
    <button
      type="button"
      class="sticky -top-2 z-10 flex w-full items-center gap-1.5 bg-surface px-2 pt-1 pb-0.5 text-left transition-colors hover:bg-overlay"
      aria-expanded={!pinnedFold.isFolded('projects-projects')}
      aria-label="{pinnedFold.isFolded('projects-projects') ? 'Expand' : 'Fold'} Pinned Projects"
      title="{pinnedFold.isFolded('projects-projects') ? 'Expand' : 'Fold'} Pinned Projects"
      onclick={() => pinnedFold.toggle('projects-projects')}
    >
      <CioChevronDown
        size={12}
        class="shrink-0 text-dimmed transition-transform {pinnedFold.isFolded('projects-projects')
          ? '-rotate-90'
          : ''}"
      />
      <span class="text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed"
        >Pinned Projects</span
      >
      <span class="text-[0.625rem] text-dimmed/70">{pinnedProjectsShown.length}</span>
    </button>
    {#if !pinnedFold.isFolded('projects-projects')}
      <div transition:slide={foldSlide()} class="space-y-px" role="list">
        {#each pinnedProjectsShown as project (project.id)}
          {@const folderThreads = threadOrderSettle.view(
            projectOrderKey(project.id),
            threadsByProject.get(project.id) ?? []
          )}
          {@const expanded =
            sidebar.expandedFolders.has(project.id) || sidebar.projectSearchOpen.has(project.id)}
          <!-- A folded folder still reveals the one thread the user is on, so
                 folding a project can never take the active thread off screen.
                 Unfolding brings the rest of the folder back. -->
          {@const revealedThreads = expanded
            ? []
            : foldedSectionRows(folderThreads, activeThreadId)}
          {@const stateCounts = projectStateCounts.get(project.id) ?? emptyThreadStateCounts()}
          <DropdownMenu.Root
            open={openProjectMenuId === project.id}
            onOpenChange={(o) => {
              openProjectMenuId = o ? project.id : null
            }}
          >
            <div>
              <FolderRow
                media={[
                  ...new SvelteSet(
                    (threadsByProject.get(project.id) ?? []).flatMap((thread) =>
                      threadMediaActivity(thread.id)
                    )
                  )
                ]}
                {project}
                iconUrl={projectIcons.get(project.id) ?? null}
                {expanded}
                sticky
                {stateCounts}
                totalThreads={(threadsByProject.get(project.id) ?? []).length}
                showLocation={hasProjectNameCollision(project, visibleProjects)}
                deleting={projectDeletionState.isPending(project.id)}
                deletingLabel={projectDeletionState.label(project.id) ?? undefined}
                actionsPinned={sidebar.projectSearchOpen.has(project.id) ||
                  openProjectMenuId === project.id}
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
                      inlineField
                      fieldId="project-search-{project.id}"
                      onOpenChange={(open) => {
                        if (open) sidebar.openProjectSearch(project.id)
                        else sidebar.closeProjectSearch(project.id)
                      }}
                      onQueryChange={(value) => {
                        sidebar.projectSearchQueries.set(project.id, value)
                        sidebar.runProjectSearch(project.id, value)
                      }}
                      loading={sidebar.projectSearching.has(project.id)}
                      ariaLabel="Search threads in {project.name}"
                      title="Search threads"
                      placeholder="Search threads in {project.name}…"
                    />
                    <button
                      class="flex h-5 w-5 items-center justify-center text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
                      aria-label="Env secrets for {project.name}"
                      title="Env secrets"
                      onclick={() =>
                        projectEnvDock.open({
                          projectId: project.id,
                          projectName: project.name,
                          iconUrl: getProjectIcon(project, projectIcons.get(project.id)),
                          color: project.color
                        })}
                    >
                      <CioKey size={12} />
                    </button>
                    <button
                      class="flex h-5 w-5 items-center justify-center text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
                      aria-label="New thread in {project.name}"
                      title="New thread"
                      data-shortcut={encodeShortcutTokens(keymapState.keysFor('nav-new-thread'))}
                      onclick={() => onCreateThread(project)}
                    >
                      <CioPlus size={12} />
                    </button>
                    <DropdownMenu.Trigger
                      class="flex h-5 w-5 items-center justify-center text-dimmed transition-colors hover:bg-overlay hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
                      aria-label="Options for {project.name}"
                      title="Project options"
                      oncontextmenu={(e: MouseEvent) => e.preventDefault()}
                    >
                      <CioEllipsis size={12} />
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
                {@const visibleFolderThreads = expanded
                  ? sidebar.visibleThreads(project.id, filteredThreads, activeThreadId)
                  : revealedThreads}
                {@const projectDisplayThreads = [
                  ...visibleFolderThreads.filter((thread) => thread.bookmarked),
                  ...visibleFolderThreads.filter((thread) => !thread.bookmarked)
                ]}
                {@const hiddenFolderCount = sidebar.hiddenThreadCount(
                  project.id,
                  filteredThreads,
                  visibleFolderThreads
                )}
                <!-- The list the fold owns. It is the only child of this branch,
                       so its own `slide` is what plays when the folder closes:
                       folding never drops an ancestor with it. -->
                <div transition:slide={foldSlide()} class="ml-2">
                  {#if sidebar.projectSearchOpen.has(project.id)}
                    <SidebarProjectSearchField
                      id="project-search-{project.id}"
                      query={searchQ}
                      loading={sidebar.projectSearching.has(project.id)}
                      placeholder="Search threads in {project.name}…"
                      ariaLabel="Search threads in {project.name}"
                      onQueryChange={(value) => {
                        sidebar.projectSearchQueries.set(project.id, value)
                        sidebar.runProjectSearch(project.id, value)
                      }}
                      onClose={() => sidebar.closeProjectSearch(project.id)}
                    />
                  {/if}
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
                          selected={activeThreadId === result.thread.id}
                          onOpen={onOpenThread}
                        />
                      {/each}
                    </div>
                  {:else}
                    <div class="space-y-px py-0.5" role="list">
                      {#each projectDisplayThreads as thread (thread.id)}
                        {@render folderThreadRow(thread, project.id, folderThreads)}
                      {/each}
                    </div>
                    {#if expanded && hiddenFolderCount > 0}
                      <button
                        class="flex w-full items-center justify-center gap-1 px-3 py-1.5 text-[0.6875rem] text-dimmed transition-colors hover:text-foreground"
                        onclick={() => sidebar.showMoreThreads(project.id, filteredThreads.length)}
                      >
                        Show {hiddenFolderCount} more
                      </button>
                    {:else if expanded && sidebar.getVisibleCount(project.id) >= filteredThreads.length && filteredThreads.length > 0 && projectHasMoreInDb(project.id)}
                      <button
                        class="flex w-full items-center justify-center gap-1 px-3 py-1.5 text-[0.6875rem] text-dimmed transition-colors hover:text-foreground disabled:cursor-wait"
                        disabled={projectPageLoading === project.id}
                        onclick={() => void onLoadProjectThreadsPage(project.id)}
                      >
                        {projectPageLoading === project.id ? 'Loading…' : 'Show more'}
                      </button>
                    {/if}
                    {#if expanded && sidebar.getVisibleCount(project.id) > sidebar.threadsPerPage}
                      <button
                        class="flex w-full items-center justify-center gap-1 px-3 py-1.5 text-[0.6875rem] text-dimmed transition-colors hover:text-foreground"
                        onclick={() => sidebar.showLessThreads(project.id)}
                      >
                        Show less
                      </button>
                    {/if}
                  {/if}
                </div>
              {:else if revealedThreads.length > 0 && foldingProjectId !== project.id}
                <!-- Folded, a folder keeps the one thread the user is working in
                         on screen. That row is its own block, never a reason to hold
                         the list open: holding it open is what used to swallow the
                         fold animation for the folder the user was working in. -->
                <div class="ml-2 space-y-px py-0.5" role="list">
                  {#each revealedThreads as thread (thread.id)}
                    {@render folderThreadRow(thread, project.id, folderThreads)}
                  {/each}
                </div>
              {/if}
            </div>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                side="bottom"
                align="end"
                sideOffset={4}
                collisionPadding={8}
                class="z-50 w-48 overflow-hidden border bg-surface p-1 shadow-lg"
              >
                <DropdownMenu.Item
                  class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                  onSelect={() => projectDialogs.askEditProject(project.id)}
                >
                  <CioPencil size={14} class="text-muted" />
                  Edit Project
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                  onSelect={() => openInEditor(project.id)}
                >
                  <CioExternalLink size={14} class="text-muted" />
                  Open in Editor
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                  onSelect={() => copyProjectPath(project.id)}
                >
                  <CioCopy size={14} class="text-muted" />
                  Copy Path
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                  onSelect={() => revealProjectInFileManager(project.id)}
                >
                  <CioFolderOpen size={14} class="text-muted" />
                  {osFileManagerLabel()}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                  onSelect={() => toggleProjectPin(project.id)}
                >
                  {#if project.pinned}
                    <CioPinOff size={14} class="text-muted" />
                    Unpin Project
                  {:else}
                    <CioPin size={14} class="text-muted" />
                    Pin Project
                  {/if}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none hover:bg-elevated focus:bg-elevated"
                  onSelect={() => void archiveItem('project', project.id, project.name)}
                >
                  <CioArchive size={14} class="text-muted" />
                  Archive Project
                </DropdownMenu.Item>
                <DropdownMenu.Separator class="mx-2 my-1 h-px bg-border" />
                <DropdownMenu.Item
                  class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-danger outline-none transition-colors hover:bg-danger/10 focus:bg-danger/10"
                  onSelect={() => projectDialogs.askRemoveProject(project.id)}
                >
                  <CioTrash size={14} />
                  Remove Project
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<!-- Folder tree -->
{#if regularProjectsShown.length === 0 && pinnedProjectsShown.length === 0}
  <!-- The panel never paints for a project-less install (the view's own empty
           state takes the pane and carries the add-project door), so this is the
           state a search leaves behind: it stays centered in the column and says
           what narrowed the tree. -->
  <EmptyState
    class="h-full"
    icon={CioFolderOpen}
    title={projectsQuery ? 'No matching projects' : 'No projects yet'}
    description={projectsQuery
      ? 'Nothing in your projects matches that search.'
      : 'Add a folder to get started.'}
  />
{:else if regularProjectsShown.length > 0}
  <div class="space-y-0.5" role="list">
    {#each regularProjectsShown as project (project.id)}
      {@const folderThreads = threadOrderSettle.view(
        projectOrderKey(project.id),
        threadsByProject.get(project.id) ?? []
      )}
      {@const expanded =
        sidebar.expandedFolders.has(project.id) || sidebar.projectSearchOpen.has(project.id)}
      <!-- A folded folder still reveals the one thread the user is on, so
             folding a project can never take the active thread off screen.
             Unfolding brings the rest of the folder back. -->
      {@const revealedThreads = expanded ? [] : foldedSectionRows(folderThreads, activeThreadId)}
      {@const stateCounts = projectStateCounts.get(project.id) ?? emptyThreadStateCounts()}
      <DropdownMenu.Root
        open={openProjectMenuId === project.id}
        onOpenChange={(o) => {
          openProjectMenuId = o ? project.id : null
        }}
      >
        <div>
          <FolderRow
            media={[
              ...new SvelteSet(
                (threadsByProject.get(project.id) ?? []).flatMap((thread) =>
                  threadMediaActivity(thread.id)
                )
              )
            ]}
            {project}
            iconUrl={projectIcons.get(project.id) ?? null}
            {expanded}
            sticky
            {stateCounts}
            totalThreads={(threadsByProject.get(project.id) ?? []).length}
            showLocation={hasProjectNameCollision(project, visibleProjects)}
            deleting={projectDeletionState.isPending(project.id)}
            deletingLabel={projectDeletionState.label(project.id) ?? undefined}
            actionsPinned={sidebar.projectSearchOpen.has(project.id) ||
              openProjectMenuId === project.id}
            onToggle={() => toggleFolder(project.id)}
            onMoveProject={(draggedId, targetId, pos) => onProjectMove(draggedId, targetId, pos)}
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
                  inlineField
                  fieldId="project-search-{project.id}"
                  onOpenChange={(open) => {
                    if (open) sidebar.openProjectSearch(project.id)
                    else sidebar.closeProjectSearch(project.id)
                  }}
                  onQueryChange={(value) => {
                    sidebar.projectSearchQueries.set(project.id, value)
                    sidebar.runProjectSearch(project.id, value)
                  }}
                  loading={sidebar.projectSearching.has(project.id)}
                  ariaLabel="Search threads in {project.name}"
                  title="Search threads"
                  placeholder="Search threads in {project.name}…"
                />
                <button
                  class="flex h-5 w-5 items-center justify-center text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
                  aria-label="New thread in {project.name}"
                  title="New thread"
                  data-shortcut={encodeShortcutTokens(keymapState.keysFor('nav-new-thread'))}
                  onclick={() => onCreateThread(project)}
                >
                  <CioPlus size={12} />
                </button>
                <DropdownMenu.Trigger
                  class="flex h-5 w-5 items-center justify-center text-dimmed transition-colors hover:bg-overlay hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
                  aria-label="Options for {project.name}"
                  title="Project options"
                  oncontextmenu={(e: MouseEvent) => e.preventDefault()}
                >
                  <CioEllipsis size={12} />
                </DropdownMenu.Trigger>
              </span>
            {/snippet}
          </FolderRow>

          <!-- Threads under folder -->
          {#if expanded}
            {@const searchQ = sidebar.projectSearchQueries.get(project.id) ?? ''}
            {@const isSearching = Boolean(searchQ.trim())}
            {@const searchResults = sidebar.projectSearchResults.get(project.id) ?? []}
            {@const filteredThreads = isSearching ? [] : filterThreadsByQuery(folderThreads, '')}
            {@const visibleFolderThreads = expanded
              ? sidebar.visibleThreads(project.id, filteredThreads, activeThreadId)
              : revealedThreads}
            {@const projectDisplayThreads = [
              ...visibleFolderThreads.filter((thread) => thread.bookmarked),
              ...visibleFolderThreads.filter((thread) => !thread.bookmarked)
            ]}
            {@const hiddenFolderCount = sidebar.hiddenThreadCount(
              project.id,
              filteredThreads,
              visibleFolderThreads
            )}
            <!-- The list the fold owns: the only child of this branch, so its
                   own `slide` plays when the folder closes. See the pinned list. -->
            <div transition:slide={foldSlide()} class="ml-2">
              {#if sidebar.projectSearchOpen.has(project.id)}
                <SidebarProjectSearchField
                  id="project-search-{project.id}"
                  query={searchQ}
                  loading={sidebar.projectSearching.has(project.id)}
                  placeholder="Search threads in {project.name}…"
                  ariaLabel="Search threads in {project.name}"
                  onQueryChange={(value) => {
                    sidebar.projectSearchQueries.set(project.id, value)
                    sidebar.runProjectSearch(project.id, value)
                  }}
                  onClose={() => sidebar.closeProjectSearch(project.id)}
                />
              {/if}
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
                      selected={activeThreadId === result.thread.id}
                      onOpen={onOpenThread}
                    />
                  {/each}
                </div>
              {:else}
                <div class="space-y-px py-0.5" role="list">
                  {#each projectDisplayThreads as thread (thread.id)}
                    {@render folderThreadRow(thread, project.id, folderThreads)}
                  {/each}
                </div>
                {#if expanded && hiddenFolderCount > 0}
                  <button
                    class="flex w-full items-center justify-center gap-1 px-3 py-1.5 text-[0.6875rem] text-dimmed transition-colors hover:text-foreground"
                    onclick={() => sidebar.showMoreThreads(project.id, filteredThreads.length)}
                  >
                    Show {hiddenFolderCount} more
                  </button>
                {:else if expanded && sidebar.getVisibleCount(project.id) >= filteredThreads.length && filteredThreads.length > 0 && projectHasMoreInDb(project.id)}
                  <button
                    class="flex w-full items-center justify-center gap-1 px-3 py-1.5 text-[0.6875rem] text-dimmed transition-colors hover:text-foreground disabled:cursor-wait"
                    disabled={projectPageLoading === project.id}
                    onclick={() => void onLoadProjectThreadsPage(project.id)}
                  >
                    {projectPageLoading === project.id ? 'Loading…' : 'Show more'}
                  </button>
                {/if}
                {#if expanded && sidebar.getVisibleCount(project.id) > sidebar.threadsPerPage}
                  <button
                    class="flex w-full items-center justify-center gap-1 px-3 py-1.5 text-[0.6875rem] text-dimmed transition-colors hover:text-foreground"
                    onclick={() => sidebar.showLessThreads(project.id)}
                  >
                    Show less
                  </button>
                {/if}
              {/if}
            </div>
          {:else if revealedThreads.length > 0 && foldingProjectId !== project.id}
            <!-- The one row a folded folder keeps for the thread being worked
                     in, drawn after the fold so closing the folder still moves. -->
            <div class="ml-2 space-y-px py-0.5" role="list">
              {#each revealedThreads as thread (thread.id)}
                {@render folderThreadRow(thread, project.id, folderThreads)}
              {/each}
            </div>
          {/if}
        </div>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="bottom"
            align="end"
            sideOffset={4}
            collisionPadding={8}
            class="z-50 w-48 overflow-hidden border bg-surface p-1 shadow-lg"
          >
            <DropdownMenu.Item
              class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
              onSelect={() => projectDialogs.askEditProject(project.id)}
            >
              <CioPencil size={14} class="text-muted" />
              Edit Project
            </DropdownMenu.Item>
            <DropdownMenu.Item
              class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
              onSelect={() => openInEditor(project.id)}
            >
              <CioExternalLink size={14} class="text-muted" />
              Open in Editor
            </DropdownMenu.Item>
            <DropdownMenu.Item
              class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
              onSelect={() => copyProjectPath(project.id)}
            >
              <CioCopy size={14} class="text-muted" />
              Copy Path
            </DropdownMenu.Item>
            <DropdownMenu.Item
              class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
              onSelect={() => revealProjectInFileManager(project.id)}
            >
              <CioFolderOpen size={14} class="text-muted" />
              {osFileManagerLabel()}
            </DropdownMenu.Item>
            <DropdownMenu.Item
              class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
              onSelect={() => toggleProjectPin(project.id)}
            >
              {#if project.pinned}
                <CioPinOff size={14} class="text-muted" />
                Unpin Project
              {:else}
                <CioPin size={14} class="text-muted" />
                Pin Project
              {/if}
            </DropdownMenu.Item>
            <DropdownMenu.Item
              class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none hover:bg-elevated focus:bg-elevated"
              onSelect={() => void archiveItem('project', project.id, project.name)}
            >
              <CioArchive size={14} class="text-muted" />
              Archive Project
            </DropdownMenu.Item>
            <DropdownMenu.Separator class="mx-2 my-1 h-px bg-border" />
            <DropdownMenu.Item
              class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-danger outline-none transition-colors hover:bg-danger/10 focus:bg-danger/10"
              onSelect={() => projectDialogs.askRemoveProject(project.id)}
            >
              <CioTrash size={14} />
              Remove Project
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    {/each}
  </div>
{/if}
