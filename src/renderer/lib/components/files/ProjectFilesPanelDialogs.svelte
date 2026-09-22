<script lang="ts">
  import { Dialog } from 'bits-ui'

  import ConfirmDialog from '../ui/ConfirmDialog.svelte'

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

<Dialog.Root open={renameTarget !== null} onOpenChange={(open) => !open && onClearRenameTarget()}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-overlay/70" />
    <Dialog.Content
      class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <Dialog.Title class="text-sm font-semibold text-foreground">Rename file</Dialog.Title>
      <Dialog.Description class="mt-1 text-xs text-muted">
        Enter a new file name, including its extension.
      </Dialog.Description>
      {#if renameTarget}
        <form class="mt-4" onsubmit={submitRename}>
          <label class="text-xs font-medium text-foreground" for="viewer-rename-file">
            File name
          </label>
          <input
            id="viewer-rename-file"
            bind:value={renameTarget.name}
            class="mt-1 h-9 w-full rounded-lg border border-border bg-app px-3 text-sm text-foreground outline-none focus:border-primary"
            autocomplete="off"
          />
          <div class="mt-5 flex justify-end gap-2">
            <Dialog.Close
              class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
            >
              Cancel
            </Dialog.Close>
            <button
              type="submit"
              class="h-8 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
              disabled={mutationPending || !renameTarget.name.trim()}
            >
              Rename
            </button>
          </div>
        </form>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

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
