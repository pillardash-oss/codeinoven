<script lang="ts">
  import { Dialog } from 'bits-ui'

  interface CloseTabTarget {
    sidebarTabId: string
    projectId: string
    fileTabId: string
    path: string
  }

  interface Props {
    /** A files tab with unsaved changes waiting on a save/discard decision. */
    target: CloseTabTarget | null
    /** Dismiss without closing the tab. */
    onCancel: () => void
    /** Close the tab and discard unsaved changes. */
    onDiscard: () => void
    /** Save the file and close the tab. */
    onSave: () => Promise<void>
  }

  let { target, onCancel, onDiscard, onSave }: Props = $props()
</script>

<!-- Closing a files tab with unsaved changes -->
<Dialog.Root
  open={target !== null}
  onOpenChange={(open) => {
    if (!open) onCancel()
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-overlay/70" />
    <Dialog.Content
      class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <Dialog.Title class="text-sm font-semibold text-foreground">Unsaved changes</Dialog.Title>
      <Dialog.Description class="mt-2 text-xs leading-5 text-muted">
        <span class="font-mono text-foreground">{target?.path}</span> has unsaved changes. Save them before
        closing the tab?
      </Dialog.Description>
      <div class="mt-5 flex justify-end gap-2">
        <Dialog.Close
          class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
        >
          Cancel
        </Dialog.Close>
        <button
          type="button"
          class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
          title="Close the tab and discard unsaved changes"
          onclick={onDiscard}
        >
          Discard changes
        </button>
        <button
          type="button"
          class="h-8 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover"
          title="Save the file and close the tab"
          onclick={() => void onSave()}
        >
          Save &amp; close
        </button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
