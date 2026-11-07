<script lang="ts">
  import CioArrowLeft from '@pdslng/cio-icon/CioArrowLeft.svelte'
  import { openThreadById } from '$lib/threads/open-thread-by-id'
  import type { Thread } from '$shared/types'

  /**
   * The one way back up a delegation chain.
   *
   * A thread can be created by another thread rather than by the user: a pawn its
   * spawner owned, a run an agent dispatched, a worker an Assignment started. The
   * app already records that parent, but the only place it surfaced was a card in
   * the composer of a locked thread, so a linked thread read as an orphan once
   * the reader scrolled past it. This strip puts the parent above the transcript
   * of every linked thread, so the chain can be walked in both directions.
   *
   * Navigation goes through the same reveal every other surface uses, which
   * matters for a dispatch that landed in a different project: the user arrives
   * at the thread that asked for the work, not at a selected id in a view that
   * cannot render it.
   */
  interface Props {
    /** The resolved parent row, when the view already holds it. */
    parent: Thread | null
    /** Fallback ids for a parent the view does not hold, e.g. another project. */
    parentProjectId?: string
    parentThreadId?: string
  }

  let { parent, parentProjectId, parentThreadId }: Props = $props()

  let target = $derived(
    parent !== null
      ? { projectId: parent.projectId, threadId: parent.id, title: parent.title }
      : parentProjectId !== undefined && parentThreadId !== undefined
        ? { projectId: parentProjectId, threadId: parentThreadId, title: null }
        : null
  )

  function openParent(): void {
    if (target === null) return
    void openThreadById(target.projectId, target.threadId)
  }
</script>

{#if target !== null}
  <div class="flex shrink-0 items-center border-b border-border bg-surface px-4 py-1">
    <button
      type="button"
      class="flex min-w-0 items-center gap-1.5 border border-transparent px-1.5 py-0.5 text-[0.5625rem] font-semibold tracking-wide text-muted uppercase transition-colors hover:border-border hover:bg-dimmed/10 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-border"
      title="Open the thread that created this one"
      aria-label="Open the parent thread"
      onclick={openParent}
    >
      <CioArrowLeft size={10} class="shrink-0" />
      <span class="shrink-0">Parent</span>
      {#if target.title}
        <span class="min-w-0 truncate normal-case tracking-normal text-foreground">
          {target.title}
        </span>
      {/if}
    </button>
  </div>
{/if}
