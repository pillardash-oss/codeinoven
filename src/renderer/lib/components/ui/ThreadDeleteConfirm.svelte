<script lang="ts">
  import Modal from './Modal.svelte'

  interface Props {
    /** Title of the thread about to be deleted, shown in the warning copy. */
    threadTitle: string
    onClose: () => void
    /** Permanently deletes the thread. The dialog closes on success. */
    onConfirm: () => Promise<void>
  }

  let { threadTitle, onClose, onConfirm }: Props = $props()

  let deleting = $state(false)

  async function confirm(): Promise<void> {
    if (deleting) return
    deleting = true
    try {
      await onConfirm()
    } finally {
      deleting = false
    }
  }
</script>

<Modal open title="Delete Thread" onClose={onClose}>
  <p class="text-sm leading-relaxed text-muted">
    This will permanently delete
    <span class="font-medium text-foreground">{threadTitle}</span>
    and all of its history. This action cannot be undone.
  </p>

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      title="Cancel"
      onclick={onClose}
    >
      Cancel
    </button>
    <button
      type="button"
      data-modal-primary
      class="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-danger/90 disabled:pointer-events-none disabled:opacity-60"
      title="Permanently delete this thread"
      onclick={() => void confirm()}
      disabled={deleting}
    >
      Delete
    </button>
  {/snippet}
</Modal>
