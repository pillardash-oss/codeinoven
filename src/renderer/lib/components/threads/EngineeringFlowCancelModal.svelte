<script lang="ts">
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'

  interface Props {
    open: boolean
    title?: string
    message?: string
    oncancel: () => void
    onconfirm: () => void | Promise<void>
  }

  let {
    open,
    title = 'Stop Engineering work?',
    message = 'Generated documents and prototype artifacts will be preserved. The active lifecycle run will stop.',
    oncancel,
    onconfirm
  }: Props = $props()
</script>

<ConfirmDialog
  {open}
  {title}
  onCancel={oncancel}
  onConfirm={onconfirm}
  cancelLabel="Keep running"
  confirmLabel="Stop work"
>
  <p>{message}</p>
</ConfirmDialog>
