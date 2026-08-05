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
    e.preventDefault()
    if (!onMoveProject) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    dropIndicator = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
  }

  function handleDrop(e: DragEvent): void {
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
    ? 'bg-elevated/70'
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
  <!-- Stable drop indicator — always rendered, opacity toggled to avoid layout shift -->
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
    <!-- Project icon ↔ chevron — one slot, chevron only while hovering -->
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
      nameClass="text-[13px] text-foreground"
      locationClass="text-[9px] text-dimmed"
      {showLocation}
    />
  </button>

  {#if actions}
    <span class="relative shrink-0">
      <span
        class="block opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {@render actions()}
      </span>
      {#if working}
        <span
          class="pointer-events-none absolute right-0 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center opacity-100 transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0"
        >
          <StatusBadge stage="working" animated title="Agent is working" />
        </span>
      {/if}
    </span>
  {:else if working}
    <span class="flex h-5 w-5 shrink-0 items-center justify-center">
      <StatusBadge stage="working" animated title="Agent is working" />
    </span>
  {/if}
</div>
