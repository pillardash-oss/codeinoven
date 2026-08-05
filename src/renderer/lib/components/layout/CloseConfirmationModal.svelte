<script lang="ts">
  import Modal from '$lib/components/ui/Modal.svelte'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import type { CloseConfirmationPayload } from '$shared/ipc-contract'

  interface Props {
    payload: CloseConfirmationPayload | null
    onDismiss: () => void
    onConfirm: () => void | Promise<void>
  }

  let { payload, onDismiss, onConfirm }: Props = $props()

  const VISIBLE_PROJECTS = 2

  let visibleProjects = $derived((payload?.projects ?? []).slice(0, VISIBLE_PROJECTS))
  let remainingCount = $derived(Math.max(0, (payload?.projects.length ?? 0) - VISIBLE_PROJECTS))
</script>

<Modal open={payload !== null} title="Close application?" onClose={onDismiss}>
  {#if payload}
    <div class="space-y-4">
      <div class="space-y-1">
        <p class="text-sm text-muted">Threads are still working in these projects:</p>
        <ul class="space-y-1.5">
          {#each visibleProjects as project (project.projectId)}
            <li class="flex items-center gap-2 text-sm text-foreground">
              <StatusBadge stage="working" animated size="sm" title="Working" />
              <span>
                <span class="font-medium">{project.projectName}</span> still working
              </span>
            </li>
          {/each}
          {#if remainingCount > 0}
            <li class="pl-4 text-sm text-muted">
              +{remainingCount} more {remainingCount === 1 ? 'project' : 'projects'} still working
            </li>
          {/if}
        </ul>
      </div>
      <p class="text-sm leading-relaxed text-muted">
        Are you sure you want to close? Working threads will be interrupted.
      </p>
    </div>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      title="Keep the app open"
      onclick={onDismiss}
    >
      Dismiss
    </button>
    <button
      type="button"
      class="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-danger/90"
      title="Close the application and interrupt working threads"
      onclick={() => void onConfirm()}
    >
      Close application
    </button>
  {/snippet}
</Modal>
