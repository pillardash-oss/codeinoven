<script lang="ts">
  import Modal from '../ui/Modal.svelte'
  import type { Snippet } from 'svelte'

  interface Props {
    open: boolean
    onClose: () => void
  }

  let { open, onClose }: Props = $props()
</script>

<Modal {open} title="Oven Setup" {onClose} chrome={true} onCloseAutoFocus={() => {}}>
  <div class="space-y-4">
    <p class="text-sm text-muted">Remote oven setup</p>
  </div>
  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <button type="button" class="rounded-lg border px-3 py-2 text-sm" onclick={onClose}>Close</button>
    </div>
  {/snippet}
</Modal>
