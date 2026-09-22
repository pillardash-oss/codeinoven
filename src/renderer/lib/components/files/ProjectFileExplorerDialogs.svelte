<script lang="ts">
  import { AlertDialog } from 'bits-ui'
  import type { ProjectFileInfo } from '$shared/types'
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

<AlertDialog.Root
  open={deleteTarget !== null}
  onOpenChange={(open) => !open && onClearDeleteTarget()}
>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-50 bg-overlay/70" />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <AlertDialog.Title class="text-sm font-semibold text-foreground"
        >Delete {deleteTarget?.paths.length === 1
          ? 'this item'
          : `${deleteTarget?.paths.length ?? 0} items`}?</AlertDialog.Title
      >
      <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
        {deleteTarget?.label} will be moved to Trash. Open tabs for the deleted items will close.
      </AlertDialog.Description>
      <div class="mt-5 flex justify-end gap-2">
        <AlertDialog.Cancel
          class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
        >
          Cancel
        </AlertDialog.Cancel>
        <AlertDialog.Action
          class="h-8 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
          disabled={operationPending}
          onclick={onConfirmDelete}
        >
          Move to Trash
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>

<FileInfoDialog {info} onClear={onClearInfo} />
