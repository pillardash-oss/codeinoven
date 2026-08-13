<script lang="ts">
  import { Redo2, Undo2 } from '@lucide/svelte'

  interface Props {
    canUndo: boolean
    canRedo: boolean
    onUndo: () => void
    onRedo: () => void
  }

  let { canUndo, canRedo, onUndo, onRedo }: Props = $props()
</script>

<div
  class="flex items-center rounded-md border border-border bg-elevated"
  aria-label="Edit history"
>
  <button
    type="button"
    class="flex h-7 w-7 items-center justify-center rounded-l-md text-muted transition-colors hover:bg-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
    disabled={!canUndo}
    title="Undo last edit"
    aria-label="Undo last edit"
    onclick={onUndo}
  >
    <Undo2 size={13} aria-hidden="true" />
  </button>
  <button
    type="button"
    class="flex h-7 w-7 items-center justify-center rounded-r-md border-l border-border text-muted transition-colors hover:bg-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
    disabled={!canRedo}
    title="Redo last undone edit"
    aria-label="Redo last undone edit"
    onclick={onRedo}
  >
    <Redo2 size={13} aria-hidden="true" />
  </button>
</div>
