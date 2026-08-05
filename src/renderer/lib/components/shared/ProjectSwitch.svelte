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
      : `flex w-full items-center gap-2 rounded-lg border bg-elevated px-3 text-left text-sm outline-none transition-colors hover:bg-overlay focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 ${selectedProjectHasCollision ? 'min-h-11 py-1.5' : 'h-9'} ${className}`}
    aria-label={ariaLabel}
    title={ariaLabel}
    {disabled}
  >
    {#if children}
      {@render children()}
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

      {#each filteredProjects as project (project.id)}
        <DropdownMenu.Item
          class="flex items-center gap-2 rounded-md px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-elevated"
          textValue={project.name}
          title={projectIdentityTitle(project)}
          onSelect={() => onSwitch(project.id)}
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
          {#if activeProjectId === project.id}
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
