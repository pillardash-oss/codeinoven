<script lang="ts">
  import CioRedo from 'cio-icon/CioRedo.svelte'
  import CioUndo from 'cio-icon/CioUndo.svelte'
  interface Props {
    canUndo: boolean
    canRedo: boolean
    undoTitle: string
    redoTitle: string
    onUndo: () => void
    onRedo: () => void
    labelled?: boolean
  }
  let { canUndo, canRedo, undoTitle, redoTitle, onUndo, onRedo, labelled = false }: Props = $props()
</script>

<button
  type="button"
  class={[
    'flex h-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40',
    labelled ? 'gap-1.5 px-2 text-[0.6875rem] font-medium' : 'w-7'
  ]}
  disabled={!canUndo}
  title={undoTitle}
  aria-label={undoTitle}
  onclick={onUndo}
>
  <CioUndo size={13} />
  {#if labelled}<span>Undo</span>{/if}
</button>
<button
  type="button"
  class={[
    'flex h-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40',
    labelled ? 'gap-1.5 px-2 text-[0.6875rem] font-medium' : 'w-7'
  ]}
  disabled={!canRedo}
  title={redoTitle}
  aria-label={redoTitle}
  onclick={onRedo}
>
  <CioRedo size={13} />
  {#if labelled}<span>Redo</span>{/if}
</button>
