<script lang="ts">
  import { Pencil, Trash2, X } from '@lucide/svelte'
  import type { PromptReference } from '$shared/types'

  interface Props {
    references: readonly PromptReference[]
    /** Jump to the selection's highlight and open its comment editor. */
    onEdit?: (id: string) => void
    /** Remove the selection immediately. */
    onRemove: (id: string) => void
    /** Remove every attached selection immediately. */
    onRemoveAll?: () => void
  }

  let { references, onEdit, onRemove, onRemoveAll }: Props = $props()
</script>

<div
  class="w-80 rounded-xl border border-border bg-surface p-1.5 shadow-lg"
  role="dialog"
  aria-label={`${references.length} attached ${references.length === 1 ? 'selection' : 'selections'}`}
>
  <div class="flex items-center justify-between gap-1 px-2 pb-1 pt-1">
    <span class="text-[0.6875rem] font-semibold text-muted">
      {references.length} attached {references.length === 1 ? 'selection' : 'selections'}
    </span>
    {#if onRemoveAll}
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
        title="Delete all selections"
        aria-label="Delete all selections"
        onclick={onRemoveAll}
      >
        <X size={12} />
      </button>
    {/if}
  </div>
  <div class="max-h-64 overflow-y-auto">
    {#each references as reference, referenceIndex (reference.id)}
      {@const number = referenceIndex + 1}
      <div class="flex items-start gap-2 rounded-lg px-2 py-1.5">
        <span
          class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[0.625rem] font-semibold text-accent tabular-nums"
          aria-hidden="true"
        >
          {number}
        </span>
        <div class="min-w-0 flex-1">
          <p class="line-clamp-2 text-xs text-muted" title={reference.text}>
            {reference.text}
          </p>
          {#if reference.comment}
            <p class="mt-0.5 line-clamp-2 text-xs text-foreground italic" title={reference.comment}>
              “{reference.comment}”
            </p>
          {/if}
        </div>
        <div class="flex shrink-0 items-center gap-0.5">
          {#if onEdit}
            <button
              type="button"
              class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
              title={`Edit comment on selection ${number}`}
              aria-label={`Edit comment on selection ${number}`}
              onclick={() => onEdit(reference.id)}
            >
              <Pencil size={11} />
            </button>
          {/if}
          <button
            type="button"
            class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
            title={`Delete selection ${number}`}
            aria-label={`Delete selection ${number}`}
            onclick={() => onRemove(reference.id)}
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>
    {/each}
  </div>
</div>
