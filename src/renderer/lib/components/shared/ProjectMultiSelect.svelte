<script lang="ts" module>
  import type { ProjectSelectOption } from './ProjectSelect.svelte'

  export interface ProjectMultiSelectOption extends ProjectSelectOption {
    path?: string
    host?: string
  }
</script>

<script lang="ts">
  import { Check, ChevronDown, FolderKanban, Search } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import { hasProjectNameCollision, projectIdentityTitle } from '$lib/project-location'
  import { projectIconOnError } from '$lib/project-icons'
  import ProjectIdentity from './ProjectIdentity.svelte'

  interface Props {
    projects: readonly ProjectMultiSelectOption[]
    values: readonly string[]
    onValuesChange: (projectIds: string[]) => void
    disabled?: boolean
  }

  let { projects, values, onValuesChange, disabled = false }: Props = $props()
  let search = $state('')
  let selectedIds = $derived(new Set(values))
  let selectedProjects = $derived(projects.filter((project) => selectedIds.has(project.id)))
  let filteredProjects = $derived(
    projects.filter((project) => {
      const query = search.trim().toLowerCase()
      return [project.name, project.path, project.host].some((value) =>
        value?.toLowerCase().includes(query)
      )
    })
  )

  function toggleProject(projectId: string): void {
    onValuesChange(
      selectedIds.has(projectId)
        ? values.filter((candidate) => candidate !== projectId)
        : [...values, projectId]
    )
  }
</script>

<DropdownMenu.Root
  onOpenChange={(open) => {
    if (open) search = ''
  }}
>
  <DropdownMenu.Trigger
    class="flex min-h-9 w-full items-center gap-2 rounded-lg border bg-elevated px-3 py-2 text-left text-xs outline-none transition-colors hover:bg-overlay focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
    aria-label="Select projects"
    title="Select projects"
    {disabled}
  >
    <span class="flex -space-x-1.5" aria-hidden="true">
      {#each selectedProjects.slice(0, 3) as project (project.id)}
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
      {#if selectedProjects.length === 0}
        <span class="flex h-5 w-5 items-center justify-center rounded border bg-raised text-dimmed">
          <FolderKanban size={11} />
        </span>
      {/if}
    </span>
    <span class="min-w-0 flex-1 truncate">
      {selectedProjects.length === 0
        ? 'Select projects'
        : `${selectedProjects.length} project${selectedProjects.length === 1 ? '' : 's'} selected`}
    </span>
    <ChevronDown size={13} class="shrink-0 text-dimmed" />
  </DropdownMenu.Trigger>

  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="end"
      sideOffset={6}
      class="z-70 w-80 rounded-xl border bg-surface p-1 shadow-lg"
    >
      <div class="relative mx-1 mb-1 mt-0.5">
        <input
          type="search"
          placeholder="Search projects…"
          bind:value={search}
          class="h-8 w-full rounded-md border bg-elevated pl-7 pr-2 text-xs text-foreground outline-none focus:border-primary"
          onclick={(event: MouseEvent) => event.stopPropagation()}
          onkeydown={(event: KeyboardEvent) => event.stopPropagation()}
        />
        <Search
          size={12}
          class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-dimmed"
        />
      </div>

      <div class="max-h-64 overflow-y-auto">
        {#each filteredProjects as project (project.id)}
          <DropdownMenu.Item
            class="flex items-center gap-2 rounded-md px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-elevated"
            textValue={project.name}
            title={projectIdentityTitle(project)}
            onSelect={(event) => {
              event.preventDefault()
              toggleProject(project.id)
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
              showLocation={hasProjectNameCollision(project, projects)}
            />
            {#if selectedIds.has(project.id)}
              <Check size={13} class="shrink-0 text-primary" />
            {/if}
          </DropdownMenu.Item>
        {/each}
      </div>

      {#if filteredProjects.length === 0}
        <p class="px-3 py-5 text-center text-xs text-dimmed">No matching projects</p>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
