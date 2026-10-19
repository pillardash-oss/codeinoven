<script lang="ts">
  import { appConfirm } from '$lib/stores/app-confirm.svelte'
  import ConfirmDialog from './ConfirmDialog.svelte'

  /**
   * The one dialog that answers `appConfirm` requests.
   *
   * Mounted once at the app root so a confirmation survives the menu that raised
   * it, and renders whatever is at the head of the queue.
   */
  const request = $derived(appConfirm.current)
</script>

<ConfirmDialog
  open={request !== null}
  title={request?.options.title ?? ''}
  confirmLabel={request?.options.confirmLabel ?? 'Confirm'}
  cancelLabel={request?.options.cancelLabel}
  note={request?.options.note}
  variant={request?.options.tone ?? 'danger'}
  onCancel={() => appConfirm.answer(false)}
  onConfirm={() => appConfirm.answer(true)}
>
  {#if request}
    <div class="space-y-2">
      {#each request.options.body as paragraph (paragraph)}
        <p class="text-sm leading-relaxed text-foreground">{paragraph}</p>
      {/each}
    </div>
  {/if}
</ConfirmDialog>
