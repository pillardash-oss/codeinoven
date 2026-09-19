<script lang="ts">
  import { AlertDialog, Dialog } from 'bits-ui'

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

<AlertDialog.Root
  open={fullscreenPendingPath !== null}
  onOpenChange={(open) => !open && onClearFullscreenPending()}
>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-50 bg-overlay/70" />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <AlertDialog.Title class="text-sm font-semibold text-foreground">
        Unsaved changes
      </AlertDialog.Title>
      <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
        Save changes to {activeTabPath} before viewing another file?
      </AlertDialog.Description>
      <div class="mt-5 flex justify-end gap-2">
        <AlertDialog.Cancel
          class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
          onclick={onClearFullscreenPending}
        >
          Cancel
        </AlertDialog.Cancel>
        <AlertDialog.Action
          class="h-8 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          onclick={onConfirmFullscreenSaveAndNavigate}
        >
          Save
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>

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

<AlertDialog.Root
  open={deleteTargetPath !== null}
  onOpenChange={(open) => !open && onClearDeleteTarget()}
>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-50 bg-overlay/70" />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <AlertDialog.Title class="text-sm font-semibold text-foreground">
        Delete file?
      </AlertDialog.Title>
      <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
        {deleteTargetPath} will be moved to Trash. Its open tab will close.
      </AlertDialog.Description>
      <div class="mt-5 flex justify-end gap-2">
        <AlertDialog.Cancel
          class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
        >
          Cancel
        </AlertDialog.Cancel>
        <AlertDialog.Action
          class="h-8 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
          disabled={mutationPending}
          onclick={onConfirmDelete}
        >
          Move to Trash
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
