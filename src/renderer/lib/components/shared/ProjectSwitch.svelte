<script lang="ts">
  import { Check, ChevronDown, FolderKanban, Search } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import { scopeState, type ScopeProject } from '$lib/stores/scope.svelte'
  import { hasProjectNameCollision, projectIdentityTitle } from '$lib/project-location'
  import { projectIconOnError } from '$lib/project-icons'
  import ProjectIdentity from './ProjectIdentity.svelte'

  interface Props {
    activeProjectId?: string | null
    onSwitch?: (projectId: string) => void
    /** Multi-select mode: the picker toggles a set of project ids instead of one. */
    multiSelect?: boolean
    /** Selected project ids in multi-select mode; empty = all projects. */
    selectedIds?: readonly string[]
    onSelectionChange?: (projectIds: string[]) => void
    /** Trigger caption in multi-select mode when nothing is selected. */
    allLabel?: string
    /** Compact trigger sizing for tight footers / toolbars. */
    compact?: boolean
    class?: string
    align?: 'start' | 'center' | 'end'
    side?: 'top' | 'bottom' | 'left' | 'right'
    sideOffset?: number
    projects?: readonly ScopeProject[]
    ariaLabel?: string
    placeholder?: string
    searchPlaceholder?: string
    emptyMessage?: string
    disabled?: boolean
    children?: Snippet
  }

  let {
    activeProjectId = null,
    onSwitch = () => {},
    multiSelect = false,
    selectedIds = [],
    onSelectionChange = () => {},
    allLabel = 'All projects',
    compact = false,
    class: className = '',
    align = 'end',
    side = 'bottom',
    sideOffset = 6,
    projects,
    ariaLabel = 'Switch project',
    placeholder = 'Select a project',
    searchPlaceholder = 'Search projects…',
    emptyMessage = 'No matching projects',
    disabled = false,
    children
  }: Props = $props()

  let projectSearch = $state('')
  let availableProjects = $derived(
    (projects ?? scopeState.projects).map((project) => {
      const record = scopeState.projectRecords.find((candidate) => candidate.id === project.id)
      return {
        ...project,
        path: project.path ?? record?.path,
        source: project.source ?? record?.source,
        host: project.host ?? record?.host
      }
    })
  )
  let selectedProject = $derived(
    availableProjects.find((project) => project.id === activeProjectId) ?? null
  )
  let selectedIdSet = $derived(new Set(selectedIds))
  let selectedMultiProjects = $derived(
    availableProjects.filter((project) => selectedIdSet.has(project.id))
  )
  function toggleProject(projectId: string): void {
    onSelectionChange(
      selectedIdSet.has(projectId)
        ? selectedIds.filter((candidate) => candidate !== projectId)
        : [...selectedIds, projectId]
    )
  }
  let selectedProjectHasCollision = $derived(
    selectedProject ? hasProjectNameCollision(selectedProject, availableProjects) : false
  )
  let filteredProjects = $derived(
    availableProjects.filter((project) =>
      [project.name, project.path, project.host].some((value) =>
        value?.toLowerCase().includes(projectSearch.trim().toLowerCase())
      )
    )
  )
</script>

<DropdownMenu.Root
  onOpenChange={(open) => {
    if (open) projectSearch = ''
  }}
>
  <DropdownMenu.Trigger
    class={children
      ? `flex items-center justify-center rounded transition-colors hover:bg-elevated focus:outline-none ${className}`
      : compact
        ? `flex h-7 items-center gap-1.5 rounded-md border border-border bg-elevated px-2 text-left text-[0.625rem] font-medium text-dimmed outline-none transition-colors hover:bg-overlay hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 ${className}`
        : `flex w-full items-center gap-2 rounded-lg border bg-elevated px-3 text-left text-sm outline-none transition-colors hover:bg-overlay focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 ${selectedProjectHasCollision ? 'min-h-11 py-1.5' : 'h-9'} ${className}`}
    aria-label={ariaLabel}
    title={ariaLabel}
    {disabled}
  >
    {#if children}
      {@render children()}
    {:else if multiSelect}
      <span class="flex -space-x-1.5" aria-hidden="true">
        {#each selectedMultiProjects.slice(0, 3) as project (project.id)}
          <span
            class="flex h-5 w-5 items-center justify-center overflow-hidden rounded border bg-raised text-dimmed"
            style:border-color={project.color}
          >
            {#if project.iconUrl}
              <img
                src={project.iconUrl}
                alt=""
                class="h-3.5 w-3.5 object-contain"
                onerror={projectIconOnError(project)}
              />
            {:else}
              <FolderKanban size={11} />
            {/if}
          </span>
        {/each}
        {#if selectedMultiProjects.length === 0}
          <span
            class="flex h-5 w-5 items-center justify-center rounded border bg-raised text-dimmed"
          >
            <FolderKanban size={11} />
          </span>
        {/if}
      </span>
      <span class="min-w-0 flex-1 truncate">
        {selectedMultiProjects.length === 0
          ? allLabel
          : `${selectedMultiProjects.length} project${selectedMultiProjects.length === 1 ? '' : 's'}`}
      </span>
      <ChevronDown size={compact ? 12 : 14} class="shrink-0 text-dimmed" />
    {:else}
      <span
        class="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-raised text-dimmed"
        style:border-color={selectedProject?.color}
        aria-hidden="true"
      >
        {#if selectedProject?.iconUrl}
          <img
            src={selectedProject.iconUrl}
            alt=""
            class="h-4 w-4 object-contain"
            onerror={projectIconOnError(selectedProject)}
          />
        {:else}
          <FolderKanban size={13} />
        {/if}
      </span>
      {#if selectedProject}
        <ProjectIdentity
          project={selectedProject}
          class="min-w-0 flex-1"
          showLocation={selectedProjectHasCollision}
        />
      {:else}
        <span class="min-w-0 flex-1 truncate text-dimmed">{placeholder}</span>
      {/if}
      <ChevronDown size={14} class="shrink-0 text-dimmed" />
    {/if}
  </DropdownMenu.Trigger>

  <DropdownMenu.Portal>
    <DropdownMenu.Content
      {side}
      {align}
      {sideOffset}
      class="z-60 min-w-64 rounded-xl border border-border bg-surface p-1 shadow-lg"
    >
      <div class="relative mx-1 mb-1 mt-0.5">
        <input
          type="text"
          placeholder={searchPlaceholder}
          bind:value={projectSearch}
          class="w-full rounded-md border border-border bg-elevated py-1.5 pl-7 pr-2 text-xs text-foreground placeholder:text-dimmed focus:outline-none"
          onclick={(event: MouseEvent) => event.stopPropagation()}
          onkeydown={(event: KeyboardEvent) => event.stopPropagation()}
        />
        <Search
          size={12}
          class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-dimmed"
        />
      </div>

      {#if multiSelect}
        <DropdownMenu.Item
          class="flex items-center gap-2 rounded-md px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-elevated"
          textValue={allLabel}
          onSelect={(event) => {
            event.preventDefault()
            onSelectionChange([])
          }}
        >
          <span class="min-w-0 flex-1 truncate text-xs font-medium">{allLabel}</span>
          {#if selectedIds.length === 0}
            <Check size={12} class="shrink-0 text-primary" />
          {/if}
        </DropdownMenu.Item>
        <div class="mx-1 my-1 border-t border-border" aria-hidden="true"></div>
      {/if}

      {#each filteredProjects as project (project.id)}
        <DropdownMenu.Item
          class="flex items-center gap-2 rounded-md px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-elevated"
          textValue={project.name}
          title={projectIdentityTitle(project)}
          onSelect={(event) => {
            if (multiSelect) {
              event.preventDefault()
              toggleProject(project.id)
              return
            }
            onSwitch(project.id)
          }}
        >
          {#if project.color}
            <span
              class="w-0.5 shrink-0 self-stretch rounded-full"
              style:background-color={project.color}
            ></span>
          {/if}
          {#if project.iconUrl}
            <img
              src={project.iconUrl}
              alt=""
              class="h-4 w-4 shrink-0 rounded object-contain"
              onerror={projectIconOnError(project)}
            />
          {/if}
          <ProjectIdentity
            {project}
            class="min-w-0 flex-1"
            showLocation={hasProjectNameCollision(project, availableProjects)}
          />
          {#if multiSelect
            ? selectedIds.includes(project.id)
            : activeProjectId === project.id}
            <Check size={12} class="shrink-0 text-primary" />
          {/if}
        </DropdownMenu.Item>
      {/each}

      {#if filteredProjects.length === 0}
        <p class="px-3 py-5 text-center text-xs text-dimmed">{emptyMessage}</p>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
