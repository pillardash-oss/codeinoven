<script lang="ts">
  import { AlertTriangle } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import { scopeConfirmations } from '$lib/stores/scope-confirmations.svelte'

  /**
   * The confirmation dialog for a destructive scope action an agent asked for.
   *
   * Mounted once at the app root. It renders whatever the agent queue holds, so
   * an agent working in a project the user is not looking at still reaches them,
   * and its answer is what releases the agent's parked tool call.
   */
  const request = $derived(scopeConfirmations.current)
  const open = $derived(request !== null)

  function close(): void {
    // Closing without choosing is a denial: main denies an unanswered request
    // anyway, and denying now releases the agent's tool call immediately
    // instead of leaving it parked until the request expires.
    void scopeConfirmations.respond(false)
  }
</script>

<Modal {open} title="Confirm scope action" onClose={close} size="md">
  {#if request}
    <div class="space-y-4">
      <div class="flex items-start gap-3">
        <span class="mt-0.5 text-warning">
          <AlertTriangle size={18} aria-hidden="true" />
        </span>
        <p class="text-sm leading-relaxed text-foreground">
          An agent working in <span class="font-medium">{request.projectName}</span> asked to
          {request.summary}.
        </p>
      </div>

      {#if request.consequences.length > 0}
        <ul class="space-y-1.5 rounded-lg border border-border bg-raised p-3 text-xs text-muted">
          {#each request.consequences as consequence (consequence)}
            <li>{consequence}</li>
          {/each}
        </ul>
      {/if}

      {#if request.dirtyFiles.length > 0}
        <div class="space-y-1">
          <p class="text-xs font-medium text-foreground">
            Uncommitted files in the checkout ({request.dirtyFiles.length})
          </p>
          <ul class="max-h-32 space-y-0.5 overflow-y-auto text-xs text-dimmed">
            {#each request.dirtyFiles.slice(0, 40) as file (file)}
              <li class="truncate" title={file}>{file}</li>
            {/each}
          </ul>
        </div>
      {/if}

      <p class="text-xs text-dimmed">
        Requested by the agent in the thread
        <span class="text-muted">{request.threadTitle || request.threadId}</span>. Answering Deny
        changes nothing.
      </p>
    </div>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      title="Deny this action; nothing will be changed"
      onclick={() => void scopeConfirmations.respond(false)}
      disabled={scopeConfirmations.responding}
    >
      Deny
    </button>
    <button
      type="button"
      data-modal-primary
      class="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-on-danger transition-colors hover:bg-danger-hover disabled:pointer-events-none disabled:opacity-60"
      title="Allow this action exactly as described"
      onclick={() => void scopeConfirmations.respond(true)}
      disabled={scopeConfirmations.responding}
    >
      Allow
    </button>
  {/snippet}
</Modal>
