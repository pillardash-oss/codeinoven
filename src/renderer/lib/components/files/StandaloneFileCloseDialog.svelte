<script lang="ts">
  import { standaloneFiles } from '$lib/stores/standalone-files.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'

  /**
   * The one unsaved-changes prompt for OS-opened files. It reads the pending
   * close from the store, so it serves the docked panel and the fullscreen
   * reader alike and is mounted once at the app root.
   */
  const pending = $derived(standaloneFiles.pendingClose)
</script>

<ConfirmDialog
  open={pending !== null}
  title="Unsaved changes"
  onCancel={() => standaloneFiles.dismissClose()}
  onConfirm={() => standaloneFiles.saveAndClosePending()}
  confirmLabel="Save and close"
  variant="primary"
  secondaryAction={{
    label: 'Discard',
    onSelect: () => standaloneFiles.discardPending(),
    tone: 'danger'
  }}
>
  <p>
    <span class="font-medium text-foreground">{pending?.name}</span> has edits that are not saved to disk
    yet.
  </p>
</ConfirmDialog>
