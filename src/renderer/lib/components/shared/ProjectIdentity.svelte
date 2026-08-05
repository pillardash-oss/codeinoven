<script lang="ts">
  import {
    projectIdentityTitle,
    projectLocationLabel,
    type ProjectLocationSource
  } from '$lib/project-location'

  interface Props {
    project: ProjectLocationSource
    class?: string
    nameClass?: string
    locationClass?: string
    showLocation?: boolean
  }

  let {
    project,
    class: className = '',
    nameClass = 'text-xs font-medium text-foreground',
    locationClass = 'text-[10px] text-dimmed',
    showLocation = false
  }: Props = $props()

  let location = $derived(projectLocationLabel(project))
  let title = $derived(projectIdentityTitle(project))
</script>

<span class="block min-w-0 {className}" {title}>
  <span class="block truncate {nameClass}">{project.name}</span>
  {#if showLocation && location}
    <span
      class="block overflow-hidden text-ellipsis whitespace-nowrap text-left leading-tight {locationClass}"
      dir="rtl"
    >
      <bdi dir="ltr">{location}</bdi>
    </span>
  {/if}
</span>
