<script lang="ts">
  import Modal from './Modal.svelte'

  interface Props {
    /** Whether the confirmation dialog is visible. */
    open: boolean
    /** Percent of the current usage window already consumed, when known —
     *  shown as an extra warning so a reset isn't spent while usage is low. */
    usedPercent?: number
    onClose: () => void
    /** Redeems the banked reset. The dialog closes on success. */
    onConfirm: () => Promise<void>
  }

  let { open, usedPercent, onClose, onConfirm }: Props = $props()

  let activating = $state(false)

  async function confirm(): Promise<void> {
    if (activating) return
    activating = true
    try {
      await onConfirm()
    } finally {
      activating = false
    }
  }
</script>

<Modal {open} title="Activate Banked Reset" onClose={onClose}>
  <p class="text-sm leading-relaxed text-muted">
    This immediately resets your Codex weekly and 5-hour usage windows and permanently consumes
    one banked reset. This action cannot be undone.
  </p>
  {#if usedPercent !== undefined && usedPercent < 50}
    <p class="mt-2 text-sm leading-relaxed text-warning">
      You've only used {Math.round(usedPercent)}% of your current window — activating now wastes
      most of the reset's value.
    </p>
  {/if}

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
      title="Permanently activate this banked reset"
      onclick={() => void confirm()}
      disabled={activating}
    >
      {activating ? 'Activating…' : 'Activate Reset'}
    </button>
  {/snippet}
</Modal>
