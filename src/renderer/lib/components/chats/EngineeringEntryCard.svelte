<script lang="ts">
  import { FileText, Lightbulb, PenLine } from '@lucide/svelte'

  interface Props {
    /** Which document the "Jump directly into…" choice produces. */
    target: 'prd' | 'spec'
    busy?: boolean
    onBrainstormFirst: () => void | Promise<void>
    onJumpIn: () => void | Promise<void>
  }
  let { target, busy = false, onBrainstormFirst, onJumpIn }: Props = $props()

  const label = $derived(target === 'prd' ? 'PRD' : 'Spec')
</script>

<section
  class="rounded-2xl border bg-surface p-4 shadow-sm"
  aria-labelledby="engineering-entry-title"
>
  <h2 id="engineering-entry-title" class="text-sm font-semibold text-foreground">
    Engineer this message
  </h2>
  <p class="mt-1 text-xs leading-5 text-muted">
    Explore the direction with a Brainstorm first, or jump straight into the {label} using the message
    you typed.
  </p>
  <div class="mt-4 grid gap-2 sm:grid-cols-2">
    <button
      type="button"
      class="rounded-xl bg-thread-spec px-3 py-2.5 text-left text-xs font-medium text-foreground disabled:opacity-50"
      disabled={busy}
      onclick={() => void onBrainstormFirst()}
    >
      <span class="flex items-center gap-2">
        <Lightbulb size={14} class="shrink-0" />
        Brainstorm first
      </span>
    </button>
    <button
      type="button"
      class="rounded-xl border px-3 py-2.5 text-left text-xs font-medium text-foreground hover:bg-elevated disabled:opacity-50"
      disabled={busy}
      onclick={() => void onJumpIn()}
    >
      <span class="flex items-center gap-2">
        <PenLine size={14} class="shrink-0" />
        {target === 'prd' ? 'Start PRD' : 'Jump into Spec'}
      </span>
    </button>
  </div>
  <p class="mt-3 flex items-center gap-1.5 text-[11px] text-muted">
    <FileText size={12} class="shrink-0" />
    Jumping in still lets the Sr. Engineer ask alignment questions — it just skips the Brainstorm document.
  </p>
</section>
