<script lang="ts">
  interface Props {
    busy?: boolean
    onBrainstormFirst: () => void | Promise<void>
    onStartPrd: () => void | Promise<void>
  }
  let { busy = false, onBrainstormFirst, onStartPrd }: Props = $props()
</script>

<section class="rounded-2xl border bg-surface p-4 shadow-sm" aria-labelledby="prd-entry-title">
  <h2 id="prd-entry-title" class="text-sm font-semibold text-foreground">Start the PRD</h2>
  <p class="mt-1 text-xs leading-5 text-muted">
    Explore the direction first, or begin requirements directly.
  </p>
  <div class="mt-4 grid gap-2 sm:grid-cols-2">
    <button
      type="button"
      class="rounded-xl bg-thread-spec px-3 py-2.5 text-left text-xs font-medium text-foreground disabled:opacity-50"
      disabled={busy}
      onclick={() => void onBrainstormFirst()}
    >
      Brainstorm first
    </button>
    <button
      type="button"
      class="rounded-xl border px-3 py-2.5 text-left text-xs font-medium text-foreground hover:bg-elevated disabled:opacity-50"
      disabled={busy}
      onclick={() => void onStartPrd()}
    >
      Start PRD
    </button>
  </div>
</section>
