<script lang="ts">
  interface Props {
    busy?: boolean
    onReview: () => void
    onFinalize: () => void | Promise<void>
  }
  let { busy = false, onReview, onFinalize }: Props = $props()
</script>

<section
  class="rounded-2xl border border-thread-spec/40 bg-surface p-4 shadow-sm"
  aria-labelledby="prd-ready-title"
>
  <h2 id="prd-ready-title" class="text-sm font-semibold text-foreground">PRD ready for review</h2>
  <p class="mt-1 text-xs leading-5 text-muted">
    Review product requirements before finalizing this lifecycle gate.
  </p>
  <div class="mt-4 flex justify-end gap-2">
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-xs text-muted hover:bg-elevated hover:text-foreground"
      onclick={onReview}
    >
      Review PRD
    </button>
    <button
      type="button"
      class="rounded-lg bg-thread-spec px-3 py-2 text-xs font-medium text-foreground disabled:opacity-50"
      disabled={busy}
      onclick={() => void onFinalize()}
    >
      Finalize PRD
    </button>
  </div>
</section>
