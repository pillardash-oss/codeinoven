<script lang="ts">
  import { invoke } from '$lib/ipc.svelte'
  import { projectIconOnError } from '$lib/project-icons'
  import { pickColorForSeed } from '$lib/project-colors'
  import { hasProjectNameCollision, projectIdentityTitle } from '$lib/project-location'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import ProjectIdentity from '$lib/components/shared/ProjectIdentity.svelte'
  import PickerMenuShell from '$lib/components/shared/PickerMenuShell.svelte'
  import type { ScopeProject } from '$lib/stores/scope-board'
  import { isOrchestrationChildThread, type Thread } from '$shared/types'

  /** Tabs shown before the rest fold into the overflow menu. Beyond this the
   *  names shrink to two or three letters and stop identifying anything. */
  const MAX_TABS = 5
  const RECENT_KEY = 'cio:header-project-recent'

  function readRecent(): string[] {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
      return Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === 'string')
        : []
    } catch {
      return []
    }
  }

  let recent = $state<string[]>(readRecent())
  let overflowOpen = $state(false)
  let overflowQuery = $state('')
  let overflowRoot: HTMLDivElement | undefined

  function captureOverflowRoot(node: HTMLDivElement): () => void {
    overflowRoot = node
    return () => {
      if (overflowRoot === node) overflowRoot = undefined
    }
  }

  /** The active project and the most recently opened ones keep a tab, shown in
   *  the user's own project order so tabs never jump when one is opened. */
  const visibleIds = $derived.by(() => {
    const ids: string[] = []
    if (scopeState.activeProjectId) ids.push(scopeState.activeProjectId)
    for (const id of recent) {
      if (ids.length >= MAX_TABS) break
      if (!ids.includes(id) && scopeState.projects.some((p) => p.id === id)) ids.push(id)
    }
    for (const project of scopeState.projects) {
      if (ids.length >= MAX_TABS) break
      if (!ids.includes(project.id)) ids.push(project.id)
    }
    return ids
  })
  const visibleProjects = $derived(scopeState.projects.filter((p) => visibleIds.includes(p.id)))
  const overflowProjects = $derived(scopeState.projects.filter((p) => !visibleIds.includes(p.id)))
  const filteredOverflow = $derived.by(() => {
    const query = overflowQuery.trim().toLowerCase()
    return query
      ? overflowProjects.filter((p) => p.name.toLowerCase().includes(query))
      : overflowProjects
  })

  function rememberProject(projectId: string): void {
    recent = [projectId, ...recent.filter((id) => id !== projectId)].slice(0, 20)
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent))
    } catch {
      // Storage is a convenience: the tabs still work without it.
    }
  }

  function closeOverflow(): void {
    overflowOpen = false
    overflowQuery = ''
  }

  function pickOverflow(project: ScopeProject): void {
    closeOverflow()
    void switchProject(project.id)
  }

  function onOverflowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeOverflow()
    } else if (event.key === 'Enter' && filteredOverflow[0]) {
      event.preventDefault()
      pickOverflow(filteredOverflow[0])
    }
  }

  /**
   * Lift the menu into the browser's top layer. The header is its own stacking
   * context, so a z-index alone loses to the board's sticky slice headers and
   * scope cards, which cover the filter field. A manual popover escapes every
   * stacking context, and is anchored under the trigger by its own rect.
   */
  function topLayer(node: HTMLDivElement): () => void {
    const anchor = overflowRoot?.getBoundingClientRect()
    if (anchor) {
      node.style.top = `${anchor.bottom + 4}px`
      node.style.right = `${Math.max(0, window.innerWidth - anchor.right)}px`
    }
    node.showPopover()
    // The field's own autofocus ran before the popover was shown, so focus it
    // again now that it is in the top layer.
    node.querySelector('input')?.focus()
    return () => {
      if (node.matches(':popover-open')) node.hidePopover()
    }
  }

  function onWindowPointerDown(event: PointerEvent): void {
    if (!overflowOpen || !overflowRoot) return
    if (event.target instanceof Node && overflowRoot.contains(event.target)) return
    closeOverflow()
  }

  async function switchProject(projectId: string): Promise<void> {
    rememberProject(projectId)
    const project = scopeState.projectRecords.find((p) => p.id === projectId) ?? null
    if (!project) return

    const scopeProject = scopeState.projects.find((p) => p.id === projectId)

    const allThreads: Thread[] = await invoke('thread:listAll')
    const projectThreads = allThreads
      .filter((t) => t.projectId === projectId && !t.archived)
      .filter((t) => !isOrchestrationChildThread(t))
      .sort((a, b) => b.lastActivity - a.lastActivity)

    const activeThread = projectThreads[0] ?? null

    if (activeThread) {
      workspaceState.openThread(activeThread, project, scopeProject?.iconUrl ?? null)
    } else {
      workspaceState.clearThread()
      workspaceState.activeProject = project
      workspaceState.activeProjectIconUrl = scopeProject?.iconUrl ?? null
      rendererRecovery.setSelectedProject(projectId)
    }

    scopeState.clearSidebarContext()
    await scopeState.activateProject(projectId)
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<!-- Scope view header area   separator, scrollable tabs, sticky tools -->
<div class="titlebar-no-drag flex min-w-0 flex-1 items-center self-stretch pl-3">
  <!-- Visual separator between nav buttons and scope tabs -->
  <div class="mr-2 h-5 w-px shrink-0 bg-border/50" aria-hidden="true"></div>

  <div
    class="min-w-0 flex-1 overflow-x-auto overscroll-x-contain"
    role="tablist"
    aria-label="Project tabs"
    tabindex="0"
  >
    <!-- `w-max max-w-full` is the shrink-before-scroll primitive: the row takes
         its content width when it fits, but is capped at the viewport width when
         it does not, so tabs shrink and their project names keep truncating down
         to the icon-only floor before the row overflows into a horizontal scroll.
         `w-max` alone would skip straight to scrolling, and `w-fit` cannot be
         used because the row's intrinsic min-content still counts the
         untruncated labels, which makes it clamp straight back to max-content. -->
    <div class="ml-auto flex h-full w-max max-w-full items-center gap-0.5">
      {#each visibleProjects as project (project.id)}
        {@const projectColor = project.color ?? pickColorForSeed(project.id)}
        {@const isActiveProject = scopeState.activeProjectId === project.id}
        <!-- min-w is the icon-only floor: 1.25rem icon + 0.25rem gap + 1rem
             horizontal padding. The button shrinks to it as its name is
             truncated, then the row scrolls. `overflow-hidden` keeps the active
             underline inside the rounded corners. -->
        <button
          class="relative flex min-h-8 min-w-[2.5rem] items-center gap-1 overflow-hidden px-2 py-0.5 transition-colors {isActiveProject
            ? 'bg-selected text-foreground'
            : 'text-muted hover:bg-elevated hover:text-foreground'}"
          role="tab"
          aria-selected={isActiveProject}
          title={projectIdentityTitle(project)}
          onclick={() => void switchProject(project.id)}
        >
          <span
            class="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden"
            style:background-color={`color-mix(in srgb, ${projectColor} 6%, var(--color-raised))`}
            aria-hidden="true"
          >
            {#if project.iconUrl}
              <img
                src={project.iconUrl}
                alt=""
                class="h-3.5 w-3.5 object-contain"
                onerror={projectIconOnError(project)}
              />
            {/if}
          </span>
          <ProjectIdentity
            {project}
            class="max-w-36 text-left"
            nameClass="text-[0.6875rem] font-medium"
            locationClass="text-[0.5rem] text-dimmed"
            showLocation={hasProjectNameCollision(project, scopeState.projects)}
          />
          <!-- The active tab is marked by the current-row surface plus a bottom
               rule, never a filled block: on dark it is the light rule, on
               light the dark one. -->
          {#if isActiveProject}
            <span
              class="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-foreground"
              aria-hidden="true"
            ></span>
          {/if}
        </button>
      {/each}
    </div>
  </div>
  {#if overflowProjects.length > 0}
    <div class="relative ml-0.5 shrink-0" {@attach captureOverflowRoot}>
      <button
        type="button"
        class="flex min-h-8 items-center px-2 text-[0.6875rem] font-medium tabular-nums transition-colors {overflowOpen
          ? 'bg-selected text-foreground'
          : 'text-muted hover:bg-elevated hover:text-foreground'}"
        aria-haspopup="menu"
        aria-expanded={overflowOpen}
        aria-label={`Show ${overflowProjects.length} more projects`}
        title={`Show ${overflowProjects.length} more projects`}
        onclick={() => (overflowOpen ? closeOverflow() : (overflowOpen = true))}
      >
        +{overflowProjects.length}
      </button>
      {#if overflowOpen}
        <div
          popover="manual"
          class="fixed bottom-auto left-auto m-0 overflow-visible border-0 bg-transparent p-0"
          {@attach topLayer}
        >
          <PickerMenuShell
            bind:query={overflowQuery}
            label="More projects"
            placeholder="Filter projects"
            autofocusSearch
            onSearchInput={() => {}}
            onSearchKeydown={onOverflowKeydown}
          >
            {#each filteredOverflow as project (project.id)}
              <button
                type="button"
                role="menuitem"
                class="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-foreground hover:bg-elevated"
                title={projectIdentityTitle(project)}
                onclick={() => pickOverflow(project)}
              >
                <span
                  class="flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden"
                  style:background-color={`color-mix(in srgb, ${project.color ?? pickColorForSeed(project.id)} 6%, var(--color-raised))`}
                  aria-hidden="true"
                >
                  {#if project.iconUrl}
                    <img
                      src={project.iconUrl}
                      alt=""
                      class="h-3 w-3 object-contain"
                      onerror={projectIconOnError(project)}
                    />
                  {/if}
                </span>
                <span class="min-w-0 truncate">{project.name}</span>
              </button>
            {:else}
              <p class="px-2 py-1.5 text-xs text-dimmed">No project matches</p>
            {/each}
          </PickerMenuShell>
        </div>
      {/if}
    </div>
  {/if}
</div>
