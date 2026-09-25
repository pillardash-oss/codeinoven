<script lang="ts">
  import ConfirmDialog from './ConfirmDialog.svelte'

  interface Props {
    /** Whether the confirmation dialog is visible. */
    open: boolean
    /** Percent of the current usage window already consumed, when known
     *  shown as an extra warning so a reset isn't spent while usage is low. */
    usedPercent?: number
    onClose: () => void
    /** Redeems the banked reset. The dialog closes on success. */
    onConfirm: () => Promise<void>
  }

  let { open, usedPercent, onClose, onConfirm }: Props = $props()

  /** True while the reset is redeemed, so the commit reports progress and a
   *  second click cannot spend a second reset. */
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

<ConfirmDialog
  {open}
  title="Activate Banked Reset"
  onCancel={onClose}
  onConfirm={confirm}
  confirmLabel="Activate Reset"
  busy={activating}
>
  <p>
    This immediately resets your Codex weekly and 5-hour usage windows and permanently consumes one
    banked reset. This action cannot be undone.
  </p>
  {#if usedPercent !== undefined && usedPercent < 50}
    <p class="text-warning">
      You've only used {Math.round(usedPercent)}% of your current window activating now wastes most
      of the reset's value.
    </p>
  {/if}
</ConfirmDialog>
