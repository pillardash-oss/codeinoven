<script lang="ts">
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import Modal from '../ui/Modal.svelte'

  interface Props {
    fullscreenPendingPath: string | null
    activeTabPath: string | undefined
    onClearFullscreenPending: () => void
    onConfirmFullscreenSaveAndNavigate: () => void
    renameTarget: { path: string; name: string } | null
    onClearRenameTarget: () => void
    mutationPending: boolean
    onRenameSubmit: () => void
    deleteTargetPath: string | null
    onClearDeleteTarget: () => void
    onConfirmDelete: () => void
  }

  let {
    fullscreenPendingPath,
    activeTabPath,
    onClearFullscreenPending,
    onConfirmFullscreenSaveAndNavigate,
    renameTarget,
    onClearRenameTarget,
    mutationPending,
    onRenameSubmit,
    deleteTargetPath,
    onClearDeleteTarget,
    onConfirmDelete
  }: Props = $props()

  function submitRename(event: SubmitEvent): void {
    event.preventDefault()
    onRenameSubmit()
  }
</script>

<ConfirmDialog
  open={fullscreenPendingPath !== null}
  title="Unsaved changes"
  onCancel={onClearFullscreenPending}
  onConfirm={onConfirmFullscreenSaveAndNavigate}
  confirmLabel="Save"
  variant="primary"
>
  <p>
    Save changes to <span class="font-medium text-foreground">{activeTabPath}</span> before viewing another
    file?
  </p>
</ConfirmDialog>

<Modal
  open={renameTarget !== null}
  title="Rename file"
  description="Enter a new file name, including its extension."
  onClose={onClearRenameTarget}
>
  {#if renameTarget}
    <form id="viewer-rename-file-form" onsubmit={submitRename}>
      <label class="text-xs font-medium text-foreground" for="viewer-rename-file">File name</label>
      <input
        id="viewer-rename-file"
        bind:value={renameTarget.name}
        class="mt-1 h-9 w-full rounded-lg border border-border bg-app px-3 text-sm text-foreground outline-none focus:border-primary"
        autocomplete="off"
      />
    </form>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      data-modal-dismiss
      class="rounded-lg border bg-elevated px-3 py-2 text-sm font-medium hover:bg-overlay"
      onclick={onClearRenameTarget}
    >
      Cancel
    </button>
    <!-- The submit button lives in the fixed footer, outside the form it
         submits, so it carries the form attribute. -->
    <button
      type="submit"
      form="viewer-rename-file-form"
      data-modal-primary
      class="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={mutationPending || !renameTarget?.name.trim()}
    >
      Rename
    </button>
  {/snippet}
</Modal>

<ConfirmDialog
  open={deleteTargetPath !== null}
  title="Delete file?"
  onCancel={onClearDeleteTarget}
  onConfirm={onConfirmDelete}
  confirmLabel="Move to Trash"
  disabled={mutationPending}
>
  <p>
    <span class="font-medium text-foreground">{deleteTargetPath}</span> will be moved to Trash. Its open
    tab will close.
  </p>
</ConfirmDialog>
