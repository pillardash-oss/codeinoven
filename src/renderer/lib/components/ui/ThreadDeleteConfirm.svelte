<script lang="ts">
  import ConfirmDialog from './ConfirmDialog.svelte'

  interface Props {
    /** Whether the confirmation dialog is visible. */
    open: boolean
    /** Title of the thread about to be deleted, shown in the warning copy. */
    threadTitle: string
    onClose: () => void
    /** Permanently deletes the thread. The dialog closes on success. */
    onConfirm: () => Promise<void>
  }

  let { open, threadTitle, onClose, onConfirm }: Props = $props()

  /** True while the delete runs, so the commit reports progress and a second
   *  click cannot start a second delete. */
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

<ConfirmDialog
  {open}
  title="Delete Thread"
  onCancel={onClose}
  onConfirm={confirm}
  confirmLabel="Delete"
  busy={deleting}
  note="This action cannot be undone."
>
  <p>
    This will permanently delete
    <span class="font-medium text-foreground">{threadTitle}</span>
    and all of its history.
  </p>
</ConfirmDialog>
