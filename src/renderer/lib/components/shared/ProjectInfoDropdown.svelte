<script lang="ts">
  import { FolderKanban, FolderOpen, GitBranch, GitFork, Pencil, Pin, PinOff } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { projectIconOnError } from '$lib/project-icons'
  import { projectLocationLabel, remoteOriginLabel } from '$lib/project-location'
  import { projectRemotes } from '$lib/stores/project-remotes.svelte'
  import type { Project } from '$shared/types'

  interface Props {
    project: Project
    iconUrl?: string | null
    branch?: string | null
    onPinToggled?: (updated: Project) => void
    onEdit?: (projectId: string) => void
    onError?: (message: string) => void
    class?: string
    align?: 'start' | 'center' | 'end'
    side?: 'top' | 'bottom' | 'left' | 'right'
    sideOffset?: number
    children?: Snippet
  }

  let {
    project,
    iconUrl = null,
    branch = null,
    onPinToggled = () => {},
    onEdit = () => {},
    onError = () => {},
    class: className = '',
    align = 'start',
    side = 'bottom',
    sideOffset = 6,
    children
  }: Props = $props()

  let pinned = $derived(Boolean(project.pinned))
  let location = $derived(projectLocationLabel(project))
  let remoteOriginUrl = $derived(projectRemotes.get(project.id) ?? null)
  let repoLabel = $derived(remoteOriginUrl ? remoteOriginLabel(remoteOriginUrl) : null)

  async function togglePin(): Promise<void> {
    try {
      const updated = await invoke('project:setPinned', project.id, !pinned)
      onPinToggled(updated)
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not update project pin')
    }
  }

  function onOpenChange(open: boolean): void {
    if (open && project.source === 'local' && project.path) {
      void projectRemotes.ensure(project.id, project.path)
    }
  }
</script>

<DropdownMenu.Root {onOpenChange}>
  <DropdownMenu.Trigger
    class={`flex items-center justify-center rounded transition-colors hover:bg-elevated focus:outline-none ${className}`}
    aria-label="{project.name} — project details"
    title="{project.name} — project details"
  >
    {@render children?.()}
  </DropdownMenu.Trigger>

  <DropdownMenu.Portal>
    <DropdownMenu.Content
      {side}
      {align}
      {sideOffset}
      class="z-60 w-72 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-lg"
    >
      <div class="flex items-center gap-2 rounded-lg px-2.5 py-2">
        <span
          class="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-raised text-dimmed"
          style:border-color={project.color}
          aria-hidden="true"
        >
          {#if iconUrl}
            <img
              src={iconUrl}
              alt=""
              class="h-4 w-4 object-contain"
              onerror={projectIconOnError(project)}
            />
          {:else}
            <FolderKanban size={13} />
          {/if}
        </span>
        <span class="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
          >{project.name}</span
        >
        <button
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
          aria-label={pinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
          title={pinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
          onclick={() => void togglePin()}
        >
          {#if pinned}
            <PinOff size={14} />
          {:else}
            <Pin size={14} />
          {/if}
        </button>
      </div>

      {#if repoLabel || location}
        <div class="space-y-1 rounded-lg px-2.5 py-2">
          {#if repoLabel}
            <div class="flex min-w-0 items-center gap-2">
              <GitFork size={13} class="shrink-0 text-dimmed" />
              <span
                class="min-w-0 flex-1 truncate text-xs text-muted"
                title={remoteOriginUrl ?? repoLabel}
              >
                {repoLabel}
              </span>
              {#if branch}
                <span
                  class="flex shrink-0 items-center gap-1 rounded bg-elevated px-1.5 py-0.5 text-[10px] text-muted"
                  title={branch}
                >
                  <GitBranch size={10} class="shrink-0" />
                  <span class="max-w-24 truncate">{branch}</span>
                </span>
              {/if}
            </div>
          {/if}
          {#if location}
            <div class="flex min-w-0 items-center gap-2">
              <FolderOpen size={13} class="shrink-0 text-dimmed" />
              <span class="truncate text-xs text-muted" title={project.path}>
                {location}
              </span>
            </div>
          {/if}
        </div>
      {/if}

      <DropdownMenu.Separator class="mx-2 my-1 h-px bg-border" />

      <DropdownMenu.Item
        class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
        onSelect={() => onEdit(project.id)}
      >
        <Pencil size={14} class="text-muted" />
        Edit Project
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
