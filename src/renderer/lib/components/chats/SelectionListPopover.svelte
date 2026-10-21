<script lang="ts">
  import CioClapper from '@pdslng/cio-icon/CioClapper.svelte'
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioFileText from '@pdslng/cio-icon/CioFileText.svelte'
  import CioMarquee from '@pdslng/cio-icon/CioMarquee.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioShapes from '@pdslng/cio-icon/CioShapes.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import type { PromptReference } from '$shared/types'
  import { referenceHasEditableSurface } from '$lib/stores/response-references.svelte'
  import ComposerRelocationMenu from './ComposerRelocationMenu.svelte'
  import { summarizeComposerReferences } from './composer-reference-summary'
  import {
    isRelocatableReference,
    relocationItemName,
    relocationNoun,
    type ComposerRelocationRequest
  } from './composer-relocation'

  interface Props {
    references: readonly PromptReference[]
    /** Jump to the surface that draws a reference and open its comment editor:
     *  the selection's highlight in the conversation, the document's passage in
     *  the file panel, or the element's design in the browser. */
    onEdit?: (id: string) => void
    /** Remove the reference immediately. */
    onRemove: (id: string) => void
    /** Remove every attached reference immediately. */
    onRemoveAll?: () => void
    /** Carry a doc comment or an inspector comment to another chat. */
    onRelocateItem?: ComposerRelocationRequest
    /** Reports any row's relocation menu opening and closing, so the popover
     *  that holds the rows stays open while a menu is up. */
    onMenuOpenChange?: (open: boolean) => void
  }

  let { references, onEdit, onRemove, onRemoveAll, onRelocateItem, onMenuOpenChange }: Props =
    $props()

  /** Rows whose relocation menu is open, so one closing menu never reports the
   *  popover free while another is still up. */
  const openMenus = new SvelteSet<string>()

  function reportMenuOpen(id: string, open: boolean): void {
    if (open) openMenus.add(id)
    else openMenus.delete(id)
    onMenuOpenChange?.(openMenus.size > 0)
  }

  const summary = $derived(summarizeComposerReferences(references))

  /**
   * What the edit action promises, which depends on where the reference lives.
   *
   * A selection is edited in place, a document annotation in the file panel, a
   * design element in the browser, an inline artifact element in its artifact
   * card and a mark on the picture it was drawn on, so the label has to name the
   * surface the click actually brings up.
   */
  function editTitle(reference: PromptReference): string {
    switch (reference.kind) {
      case 'file':
        return `Open ${reference.label} and edit its comment`
      case 'design':
        return `Show ${reference.label} in the browser and edit its comment`
      case 'video':
        return `Show ${reference.label} on the timeline and edit its comment`
      case 'image':
        return `Show ${reference.label} on its picture and edit its comment`
      case 'svg':
      case 'html':
        return `Show ${reference.label} in its artifact and edit its comment`
      default:
        return `Edit comment on ${reference.label}`
    }
  }
</script>

<div
  class="w-80 border border-border bg-surface p-1.5 shadow-lg"
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
        class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
        title="Delete all attached references"
        aria-label="Delete all attached references"
        onclick={onRemoveAll}
      >
        <CioClose size={12} />
      </button>
    {/if}
  </div>
  <div class="max-h-64 overflow-y-auto">
    {#each references as reference, referenceIndex (reference.id)}
      {@const number = referenceIndex + 1}
      {@const isElement = reference.kind === 'design'}
      {@const isArtifactElement = reference.kind === 'svg' || reference.kind === 'html'}
      {@const isAnnotation = reference.kind === 'file'}
      {@const isNote = reference.kind === 'video'}
      {@const isMark = reference.kind === 'image'}
      <!-- A doc comment and an inspector comment name a document and an element
           this project holds, so both can be carried to another chat of it. A
           selection or a mark belongs to this conversation alone. -->
      <ComposerRelocationMenu
        noun={onRelocateItem && isRelocatableReference(reference)
          ? relocationNoun({ kind: 'reference', reference })
          : null}
        name={relocationItemName({ kind: 'reference', reference })}
        onOpenChange={(open) => reportMenuOpen(reference.id, open)}
        onRelocate={() => onRelocateItem?.({ kind: 'reference', reference }, 'relocate')}
        onCopy={() => onRelocateItem?.({ kind: 'reference', reference }, 'copy')}
      >
        <div class="flex items-start gap-2 px-2 py-1.5">
          <span
            class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center bg-accent/15 text-[0.625rem] font-semibold text-accent tabular-nums"
            aria-hidden="true"
          >
            {number}
          </span>
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-1 text-[0.6875rem] font-medium text-foreground">
              {#if isElement}
                <CioMarquee size={10} class="shrink-0 text-accent" />
              {:else if isArtifactElement}
                <CioShapes size={10} class="shrink-0 text-accent" />
              {:else if isAnnotation}
                <CioFileText size={10} class="shrink-0 text-accent" />
              {:else if isNote}
                <CioClapper size={10} class="shrink-0 text-accent" />
              {:else if isMark}
                <CioPencil size={10} class="shrink-0 text-accent" />
              {/if}
              <span class="truncate">{reference.label}</span>
            </p>
            {#if reference.comment}
              <p
                class="mt-0.5 line-clamp-2 text-xs text-foreground italic"
                title={reference.comment}
              >
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
                class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
                title={editTitle(reference)}
                aria-label={editTitle(reference)}
                onclick={() => onEdit(reference.id)}
              >
                <CioPencil size={11} />
              </button>
            {/if}
            <button
              type="button"
              class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
              title={`Delete ${reference.label}`}
              aria-label={`Delete ${reference.label}`}
              onclick={() => onRemove(reference.id)}
            >
              <CioTrash size={11} />
            </button>
          </div>
        </div>
      </ComposerRelocationMenu>
    {/each}
  </div>
</div>
