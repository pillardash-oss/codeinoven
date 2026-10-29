<script lang="ts">
  import CioRedo from '@pdslng/cio-icon/CioRedo.svelte'
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  interface Props {
    canUndo: boolean
    canRedo: boolean
    undoTitle: string
    redoTitle: string
    onUndo: () => void
    onRedo: () => void
    labelled?: boolean
    /** Sit in a 24px toolbar row instead of a 28px one, so every control in that
     *  row shares one baseline and one height. */
    compact?: boolean
  }
  let {
    canUndo,
    canRedo,
    undoTitle,
    redoTitle,
    onUndo,
    onRedo,
    labelled = false,
    compact = false
  }: Props = $props()
</script>

<button
  type="button"
  class={[
    'flex shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40',
    compact ? 'h-6' : 'h-7',
    labelled ? 'gap-1.5 px-2 text-[0.6875rem] font-medium' : compact ? 'w-6' : 'w-7'
  ]}
  disabled={!canUndo}
  title={undoTitle}
  aria-label={undoTitle}
  onclick={onUndo}
>
  <CioUndo size={compact ? 12 : 13} />
  {#if labelled}<span>Undo</span>{/if}
</button>
<button
  type="button"
  class={[
    'flex shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40',
    compact ? 'h-6' : 'h-7',
    labelled ? 'gap-1.5 px-2 text-[0.6875rem] font-medium' : compact ? 'w-6' : 'w-7'
  ]}
  disabled={!canRedo}
  title={redoTitle}
  aria-label={redoTitle}
  onclick={onRedo}
>
  <CioRedo size={compact ? 12 : 13} />
  {#if labelled}<span>Redo</span>{/if}
</button>
