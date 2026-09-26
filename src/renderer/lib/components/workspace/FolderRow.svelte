<script lang="ts">
  import { Folder, ChevronRight } from '@lucide/svelte'
  import type { Snippet } from 'svelte'
  import type { Project } from '$shared/types'
  import { getProjectIcon, projectIconOnError } from '$lib/project-icons'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import ProjectIdentity from '$lib/components/shared/ProjectIdentity.svelte'
  import { projectIdentityTitle } from '$lib/project-location'

  interface Props {
    project: Project
    /** Data URL of the project's custom icon. */
    iconUrl?: string | null
    expanded: boolean
    /** Whether any thread inside this folder is currently being worked on. */
    working?: boolean
    onToggle: () => void
    /** Hover actions rendered on the right (e.g. new-thread button, ellipsis menu). */
    actions?: Snippet
    /**
     * Keep the hover actions visible and interactive without hover, for cases where a
     * control opened from them (search popover, options menu) must stay reachable.
     */
    actionsPinned?: boolean
    /** Callback for drag-to-reorder; position is relative to this item. */
    onMoveProject?: (id: string, targetId: string, position: 'before' | 'after') => void
    /** Callback for right-click context menu. */
    onContextMenu?: (e: MouseEvent, projectId: string) => void
    /** Show location metadata when this name collides with another visible project. */
    showLocation?: boolean
  }

  let {
    project,
    iconUrl = null,
    expanded,
    working = false,
    onToggle,
    actions,
    actionsPinned = false,
    onMoveProject,
    onContextMenu,
    showLocation = false
  }: Props = $props()

  const resolvedIcon = $derived(getProjectIcon(project, iconUrl ?? undefined))

  let dropIndicator = $state<'before' | 'after' | null>(null)

  function setDragImage(e: DragEvent, label: string): void {
    const ghost = document.createElement('div')
    ghost.textContent = label
    ghost.style.cssText =
      'position:absolute;top:-1000px;left:-1000px;padding:3px 8px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:6px;font-size:13px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.15)'
    document.body.appendChild(ghost)
    e.dataTransfer!.setDragImage(ghost, 0, 0)
    requestAnimationFrame(() => document.body.removeChild(ghost))
  }

  function handleDragStart(e: DragEvent): void {
    e.dataTransfer!.setData('text/plain', project.id)
    e.dataTransfer!.effectAllowed = 'move'
    setDragImage(e, project.name)
    // Auto-collapse when dragging to keep the list compact
    if (expanded) {
      onToggle()
    }
  }

  function handleDragOver(e: DragEvent): void {
    // A folder/file dragged in from the OS is handled by the sidebar's own drop
    // target, never as a reorder of this row.
    if (e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    if (!onMoveProject) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    dropIndicator = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
  }

  function handleDrop(e: DragEvent): void {
    if (e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    const draggedId = e.dataTransfer!.getData('text/plain')
    if (draggedId && draggedId !== project.id && onMoveProject) {
      onMoveProject(draggedId, project.id, dropIndicator ?? 'after')
    }
    dropIndicator = null
  }

  function handleDragLeave(): void {
    dropIndicator = null
  }
</script>

<div
  class="group relative flex items-center gap-1 border-l-2 px-1.5 py-1.5 transition-colors {expanded
    ? 'bg-elevated/70 hover:bg-elevated'
    : 'hover:bg-elevated'}"
  style={project.color
    ? `border-color: ${project.color}`
    : expanded
      ? 'border-color: var(--color-foreground)'
      : undefined}
  class:border-transparent={!project.color && !expanded}
  class:hover:border-border-strong={!project.color && !expanded}
  role="listitem"
  draggable="true"
  ondragstart={handleDragStart}
  ondragover={handleDragOver}
  ondrop={handleDrop}
  ondragleave={handleDragLeave}
  oncontextmenu={(e: MouseEvent) => onContextMenu?.(e, project.id)}
>
  <!-- Stable drop indicator   always rendered, opacity toggled to avoid layout shift -->
  <div
    class="pointer-events-none absolute left-0 right-0 top-0 h-[2px] transition-opacity duration-100 {dropIndicator ===
    'before'
      ? 'bg-primary opacity-100'
      : 'opacity-0'}"
  ></div>
  <div
    class="pointer-events-none absolute bottom-0 left-0 right-0 h-[2px] transition-opacity duration-100 {dropIndicator ===
    'after'
      ? 'bg-primary opacity-100'
      : 'opacity-0'}"
  ></div>
  <button
    class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
    aria-expanded={expanded}
    title={`${expanded ? 'Collapse' : 'Expand'} ${projectIdentityTitle(project)}`}
    onclick={onToggle}
  >
    <!-- Project icon ↔ chevron   one slot, chevron only while hovering -->
    <span class="relative h-4 w-4 shrink-0">
      <span
        class="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover:opacity-0"
        aria-hidden="true"
      >
        {#if resolvedIcon}
          <img
            src={resolvedIcon}
            alt=""
            class="h-4 w-4 object-contain"
            draggable="false"
            onerror={projectIconOnError(project)}
          />
        {:else}
          <Folder size={14} class="text-muted" />
        {/if}
      </span>
      <span
        class="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        aria-hidden="true"
      >
        <ChevronRight
          size={13}
          class="text-dimmed transition-transform duration-150 {expanded ? 'rotate-90' : ''}"
        />
      </span>
    </span>

    <ProjectIdentity
      {project}
      class="min-w-0 flex-1"
      nameClass="text-[0.8125rem] text-foreground"
      locationClass="text-[0.5625rem] text-dimmed"
      {showLocation}
    />
  </button>

  <!-- The working badge and the hover actions float over the right edge of the row
       instead of reserving width in the flex flow, so the project name always keeps
       the full width of the row until the actions are actually visible. The left-to-right
       fade keeps the overlaid controls legible over a long name. -->
  {#if working}
    <span
      class="pointer-events-none absolute inset-y-0 right-1.5 flex items-center bg-linear-to-l from-elevated from-65% to-transparent pl-4 transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0"
    >
      <StatusBadge stage="working" animated title="Agent is working" />
    </span>
  {/if}

  {#if actions}
    <span
      class="pointer-events-none absolute inset-y-0 right-1.5 flex items-center justify-end bg-linear-to-l from-elevated from-65% to-transparent pl-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 {actionsPinned
        ? 'opacity-100'
        : ''}"
    >
      <!-- Only the buttons take pointer events, so the fade never swallows a click
           meant for the row's expand toggle underneath. -->
      <span
        class="flex items-center {actionsPinned
          ? 'pointer-events-auto'
          : 'pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto'}"
      >
        {@render actions()}
      </span>
    </span>
  {/if}
</div>
