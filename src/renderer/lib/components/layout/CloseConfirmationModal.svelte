<script lang="ts">
  import Modal from '$lib/components/ui/Modal.svelte'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import type {
    CloseConfirmationPayload,
    CloseConfirmationProject,
    CloseConfirmationThread
  } from '$shared/ipc-contract'

  interface Props {
    payload: CloseConfirmationPayload | null
    onDismiss: () => void
    onConfirm: () => void | Promise<void>
  }

  let { payload, onDismiss, onConfirm }: Props = $props()

  const VISIBLE_PROJECTS = 2
  const VISIBLE_THREADS_PER_PROJECT = 3

  let visibleProjects = $derived((payload?.projects ?? []).slice(0, VISIBLE_PROJECTS))
  let remainingProjectCount = $derived(
    Math.max(0, (payload?.projects.length ?? 0) - VISIBLE_PROJECTS)
  )

  function visibleThreads(project: CloseConfirmationProject): CloseConfirmationThread[] {
    return project.threads.slice(0, VISIBLE_THREADS_PER_PROJECT)
  }
</script>

<Modal open={payload !== null} title="Close application?" onClose={onDismiss}>
  {#if payload}
    <div class="space-y-4">
      <div class="space-y-2">
        <p class="text-sm text-muted">These threads are still working:</p>
        <ul class="space-y-2.5">
          {#each visibleProjects as project (project.projectId)}
            <li class="space-y-1">
              <div class="flex items-center gap-2 text-sm text-foreground">
                <StatusBadge stage="working" animated size="sm" title="Working" />
                <span class="min-w-0 truncate font-medium">{project.projectName}</span>
                <span class="shrink-0 text-xs text-dimmed tabular-nums">
                  {project.threadCount}
                  {project.threadCount === 1 ? 'thread' : 'threads'}
                </span>
              </div>
              <ul class="space-y-0.5 border-l border-border pl-3">
                {#each visibleThreads(project) as thread (thread.threadId)}
                  <li class="flex items-center gap-1.5 text-xs text-muted">
                    <span class="shrink-0 uppercase tracking-wide text-dimmed">
                      {thread.status === 'executing' ? 'Executing' : 'Planning'}
                    </span>
                    <span class="min-w-0 truncate" title={thread.title}>{thread.title}</span>
                  </li>
                {/each}
                {#if project.threads.length > VISIBLE_THREADS_PER_PROJECT}
                  <li class="pl-0 text-xs text-dimmed">
                    +{project.threads.length - VISIBLE_THREADS_PER_PROJECT} more
                  </li>
                {/if}
              </ul>
            </li>
          {/each}
          {#if remainingProjectCount > 0}
            <li class="pl-4 text-sm text-muted">
              +{remainingProjectCount} more {remainingProjectCount === 1 ? 'project' : 'projects'}
            </li>
          {/if}
        </ul>
      </div>
      <p class="text-sm leading-relaxed text-muted">
        Are you sure you want to close? These threads will be interrupted.
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
