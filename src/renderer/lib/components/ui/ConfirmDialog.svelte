<script lang="ts">
  import { Loader2 } from '@lucide/svelte'
  import type { Snippet } from 'svelte'
  import Modal from './Modal.svelte'

  /**
   * The shared confirmation dialog.
   *
   * Every confirmation in the app renders through this one, so the shape never
   * depends on which surface raised it: the shared `Modal` chrome, a cancel on
   * the left, and a single commit on the right that reports progress while it
   * runs. Callers supply content and labels only, never styling.
   *
   * `variant` is `danger` for anything that destroys work and `primary` for a
   * commit that only moves state, such as checking out a branch or saving a
   * buffer before a navigation. `secondaryAction` covers the few dialogs that
   * offer a third way out, such as discarding an unsaved buffer instead of
   * saving it.
   *
   * Bodies carry whatever the decision needs: prose, a list of the files at
   * stake, or a field whose value travels with the confirmation.
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
    /** `danger` destroys work; `primary` only moves state. */
    variant?: 'danger' | 'primary'
    /** A third choice between cancel and commit, e.g. Discard next to Save. */
    secondaryAction?: { label: string; onSelect: () => void; tone?: 'danger' | 'neutral' }
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
    disabled = false,
    variant = 'danger',
    secondaryAction
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
      data-modal-dismiss
      class="rounded-lg border bg-elevated px-3 py-2 text-sm font-medium hover:bg-overlay"
      onclick={onCancel}
    >
      {cancelLabel}
    </button>
    {#if secondaryAction}
      <button
        type="button"
        class={[
          'rounded-lg border px-3 py-2 text-sm font-medium',
          secondaryAction.tone === 'danger'
            ? 'border-danger/40 text-danger hover:bg-danger/10'
            : 'bg-elevated hover:bg-overlay'
        ]}
        onclick={secondaryAction.onSelect}
      >
        {secondaryAction.label}
      </button>
    {/if}
    <button
      type="button"
      data-modal-primary
      class={[
        'inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'danger' ? 'bg-danger text-on-danger' : 'bg-primary text-on-primary'
      ]}
      disabled={disabled || busy}
      onclick={() => void onConfirm()}
    >
      {#if busy}
        <Loader2 size={14} class="animate-spin" />
      {/if}
      <span>{confirmLabel}</span>
    </button>
  {/snippet}
</Modal>
