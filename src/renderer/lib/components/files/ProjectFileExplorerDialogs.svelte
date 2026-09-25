<script lang="ts">
  import type { ProjectFileInfo } from '$shared/types'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import FileInfoDialog from './FileInfoDialog.svelte'

  interface Props {
    deleteTarget: { paths: string[]; label: string } | null
    operationPending: boolean
    onClearDeleteTarget: () => void
    onConfirmDelete: () => void
    info: ProjectFileInfo | null
    onClearInfo: () => void
  }

  let {
    deleteTarget,
    operationPending,
    onClearDeleteTarget,
    onConfirmDelete,
    info,
    onClearInfo
  }: Props = $props()
</script>

<ConfirmDialog
  open={deleteTarget !== null}
  title="Delete {deleteTarget?.paths.length === 1
    ? 'this item'
    : `${deleteTarget?.paths.length ?? 0} items`}?"
  onCancel={onClearDeleteTarget}
  onConfirm={onConfirmDelete}
  confirmLabel="Move to Trash"
  disabled={operationPending}
>
  <p>
    <span class="font-medium text-foreground">{deleteTarget?.label}</span> will be moved to Trash. Open
    tabs for the deleted items will close.
  </p>
</ConfirmDialog>

<FileInfoDialog {info} onClear={onClearInfo} />
