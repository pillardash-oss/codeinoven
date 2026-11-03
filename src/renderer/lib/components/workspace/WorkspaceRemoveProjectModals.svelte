<script lang="ts">
  import Modal from '$lib/components/ui/Modal.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import { APP_NAME } from '$shared/brand'
  import type { WorkspaceProjectDialogs } from './WorkspaceProjectDialogs.svelte'

  interface Props {
    dialogs: WorkspaceProjectDialogs
  }

  let { dialogs }: Props = $props()
</script>

<!-- Remove Project Confirmation -->
<Modal
  open={dialogs.showRemoveModal}
  title="Remove Project"
  size="lg"
  onClose={dialogs.closeRemoveModal}
>
  <p class="text-sm leading-relaxed text-muted">
    This will remove
    <span class="font-medium text-foreground">{dialogs.removeTarget?.name}</span>
    and all of its threads from {APP_NAME}. The folder itself will remain on your device.
  </p>

  {#if dialogs.removeDeleteFolder}
    <p class="mt-3 text-sm font-medium leading-relaxed text-danger">
      You have stated that we should delete this project's folder too from your device!
    </p>
  {/if}

  {#snippet footer()}
    <div class="mr-auto flex items-center">
      <Switch
        bind:checked={dialogs.removeDeleteFolder}
        title="Delete this project's folder from your device too"
        aria-label="Delete folder from device"
        label="Delete folder from device"
      />
    </div>
    <button
      type="button"
      class="px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated disabled:pointer-events-none disabled:opacity-50"
      title="Cancel"
      onclick={dialogs.closeRemoveModal}
    >
      Cancel
    </button>
    <button
      type="button"
      class="bg-danger px-4 py-2 text-sm font-medium text-on-danger transition-colors hover:bg-danger/90 disabled:pointer-events-none disabled:opacity-60"
      title="Remove this project and its threads from {APP_NAME}"
      onclick={() => void dialogs.confirmRemoveProject()}
    >
      Remove
    </button>
  {/snippet}
</Modal>

<!-- Remove Project With Folder Erasure: Final Confirmation -->
<Modal
  open={dialogs.showRemoveFinalConfirm}
  title="Delete Project Folder"
  onClose={dialogs.cancelRemoveFinalConfirm}
>
  <p class="text-sm leading-relaxed text-muted">
    Your project will be removed from {APP_NAME} and erased from your device. It cannot be recovered again!
  </p>

  {#snippet footer()}
    <button
      type="button"
      class="px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated disabled:pointer-events-none disabled:opacity-50"
      title="Go back to the previous step"
      onclick={dialogs.cancelRemoveFinalConfirm}
    >
      Cancel
    </button>
    <button
      type="button"
      class="bg-danger px-4 py-2 text-sm font-medium text-on-danger transition-colors hover:bg-danger/90 disabled:pointer-events-none disabled:opacity-60"
      title="Delete this project from {APP_NAME} and erase its folder from your device"
      onclick={() => void dialogs.confirmRemoveWithFolder()}
    >
      Delete Project and Folder
    </button>
  {/snippet}
</Modal>
