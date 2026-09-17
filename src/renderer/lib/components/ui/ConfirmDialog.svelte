<script lang="ts">
  import { Loader2 } from '@lucide/svelte'
  import type { Snippet } from 'svelte'
  import Modal from './Modal.svelte'

  /**
   * The shared confirmation dialog for destructive actions.
   *
   * Every destructive action in the app must be confirmed, and the shape of that
   * confirmation is always the same: a tokenized danger surface, a cancel on the
   * left, and a single destructive commit on the right that can show progress
   * while the action runs. Callers supply only the title and body.
   */
  interface Props {
    open: boolean
    title: string
    /** Dismissal: backdrop, escape, and the cancel button all route here. */
    onCancel: () => void
    onConfirm: () => void | Promise<void>
    /** Body copy. The caller owns its own paragraphs and emphasis. */
    children: Snippet
    confirmLabel: string
    cancelLabel?: string
    /** Extra emphasis line under the body, e.g. that the action is irreversible. */
    note?: string
    /** Runs the action and replaces the confirm label with a spinner. */
    busy?: boolean
    /** Blocks the confirm button while the action is still unavailable. */
    disabled?: boolean
  }

  let {
    open,
    title,
    onCancel,
    onConfirm,
    children,
    confirmLabel,
    cancelLabel = 'Cancel',
    note,
    busy = false,
    disabled = false
  }: Props = $props()
</script>

<Modal {open} {title} onClose={onCancel}>
  <div class="space-y-2 text-sm text-muted">
    {@render children()}
    {#if note}
      <p class="font-medium text-foreground">{note}</p>
    {/if}
  </div>

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg border bg-elevated px-3 py-2 text-sm font-medium hover:bg-overlay"
      onclick={onCancel}
    >
      {cancelLabel}
    </button>
    <button
      type="button"
      class="inline-flex items-center gap-2 rounded-lg bg-danger px-3 py-2 text-sm font-semibold text-on-danger hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled || busy}
      onclick={() => void onConfirm()}
    >
      {#if busy}
        <Loader2 size={14} class="animate-spin" />
        <span>{confirmLabel}</span>
      {:else}
        {confirmLabel}
      {/if}
    </button>
  {/snippet}
</Modal>
