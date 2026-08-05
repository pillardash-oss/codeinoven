<script lang="ts" module>
  export interface ProjectSelectOption {
    id: string
    name: string
    iconUrl?: string | null
    color?: string
    disabled?: boolean
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte'
  import ProjectSwitch from './ProjectSwitch.svelte'

  interface Props {
    projects: readonly ProjectSelectOption[]
    value?: string | null
    onValueChange: (projectId: string) => void
    ariaLabel: string
    placeholder?: string
    searchPlaceholder?: string
    emptyMessage?: string
    disabled?: boolean
    class?: string
    align?: 'start' | 'center' | 'end'
    side?: 'top' | 'bottom' | 'left' | 'right'
    sideOffset?: number
    trigger?: Snippet<[ProjectSelectOption | null]>
  }

  let {
    projects,
    value = null,
    onValueChange,
    ariaLabel,
    placeholder = 'Select a project',
    searchPlaceholder = 'Search projects…',
    emptyMessage = 'No matching projects',
    disabled = false,
    class: className = '',
    align = 'start',
    side = 'bottom',
    sideOffset = 6,
    trigger
  }: Props = $props()
</script>

{#if trigger}
  {#snippet projectTrigger()}
    {@render trigger(projects.find((project) => project.id === value) ?? null)}
  {/snippet}

  <ProjectSwitch
    {projects}
    activeProjectId={value}
    onSwitch={onValueChange}
    {ariaLabel}
    {placeholder}
    {searchPlaceholder}
    {emptyMessage}
    {disabled}
    class={className}
    {align}
    {side}
    {sideOffset}
  >
    {@render projectTrigger()}
  </ProjectSwitch>
{:else}
  <ProjectSwitch
    {projects}
    activeProjectId={value}
    onSwitch={onValueChange}
    {ariaLabel}
    {placeholder}
    {searchPlaceholder}
    {emptyMessage}
    {disabled}
    class={className}
    {align}
    {side}
    {sideOffset}
  />
{/if}
