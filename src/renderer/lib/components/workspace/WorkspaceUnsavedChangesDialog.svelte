<script lang="ts">
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'

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
<ConfirmDialog
  open={target !== null}
  title="Unsaved changes"
  {onCancel}
  onConfirm={onSave}
  confirmLabel="Save & close"
  variant="primary"
  secondaryAction={{ label: 'Discard changes', onSelect: onDiscard, tone: 'danger' }}
>
  <p>
    <span class="font-mono text-foreground">{target?.path}</span> has unsaved changes. Save them before
    closing the tab?
  </p>
</ConfirmDialog>
