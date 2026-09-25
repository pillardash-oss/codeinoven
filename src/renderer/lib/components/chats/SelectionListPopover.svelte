<script lang="ts">
  import { FileText, Pencil, SquareDashedMousePointer, Trash2, X } from '@lucide/svelte'
  import type { PromptReference } from '$shared/types'
  import { referenceHasEditableSurface } from '$lib/stores/response-references.svelte'
  import { summarizeComposerReferences } from './composer-reference-summary'

  interface Props {
    references: readonly PromptReference[]
    /** Jump to the selection's highlight and open its comment editor. Only
     *  offered for a response selection; a design element's comment is edited on
     *  the page, by its own pin. */
    onEdit?: (id: string) => void
    /** Remove the reference immediately. */
    onRemove: (id: string) => void
    /** Remove every attached reference immediately. */
    onRemoveAll?: () => void
  }

  let { references, onEdit, onRemove, onRemoveAll }: Props = $props()

  const summary = $derived(summarizeComposerReferences(references))
</script>

<div
  class="w-80 rounded-xl border border-border bg-surface p-1.5 shadow-lg"
  role="dialog"
  aria-label={summary.aria}
>
  <div class="flex items-center justify-between gap-1 px-2 pt-1 pb-1">
    <span class="text-[0.6875rem] font-semibold text-muted">
      {summary.aria}
    </span>
    {#if onRemoveAll}
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
        title="Delete all attached references"
        aria-label="Delete all attached references"
        onclick={onRemoveAll}
      >
        <X size={12} />
      </button>
    {/if}
  </div>
  <div class="max-h-64 overflow-y-auto">
    {#each references as reference, referenceIndex (reference.id)}
      {@const number = referenceIndex + 1}
      {@const isElement = reference.kind === 'design'}
      {@const isAnnotation = reference.kind === 'file'}
      <div class="flex items-start gap-2 rounded-lg px-2 py-1.5">
        <span
          class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[0.625rem] font-semibold text-accent tabular-nums"
          aria-hidden="true"
        >
          {number}
        </span>
        <div class="min-w-0 flex-1">
          <p class="flex items-center gap-1 text-[0.6875rem] font-medium text-foreground">
            {#if isElement}
              <SquareDashedMousePointer size={10} class="shrink-0 text-accent" />
            {:else if isAnnotation}
              <FileText size={10} class="shrink-0 text-accent" />
            {/if}
            <span class="truncate">{reference.label}</span>
          </p>
          {#if reference.comment}
            <p class="mt-0.5 line-clamp-2 text-xs text-foreground italic" title={reference.comment}>
              “{reference.comment}”
            </p>
          {/if}
          <p class="mt-0.5 line-clamp-2 text-[0.6875rem] text-muted" title={reference.text}>
            {reference.text}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-0.5">
          {#if onEdit && referenceHasEditableSurface(reference)}
            <button
              type="button"
              class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
              title={isAnnotation
                ? `Open ${reference.label} and edit its comment`
                : isElement
                  ? `Show ${reference.label} in the browser and edit its comment`
                  : `Edit comment on ${reference.label}`}
              aria-label={isAnnotation
                ? `Open ${reference.label} and edit its comment`
                : isElement
                  ? `Show ${reference.label} in the browser and edit its comment`
                  : `Edit comment on ${reference.label}`}
              onclick={() => onEdit(reference.id)}
            >
              <Pencil size={11} />
            </button>
          {/if}
          <button
            type="button"
            class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
            title={`Delete ${reference.label}`}
            aria-label={`Delete ${reference.label}`}
            onclick={() => onRemove(reference.id)}
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>
    {/each}
  </div>
</div>
