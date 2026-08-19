<script lang="ts">
  import { ArrowRight, Lightbulb } from '@lucide/svelte'

  interface Props {
    version: number
    busy?: boolean
    onReview: () => void
    onFinalize: () => void
  }

  let { version, busy = false, onReview, onFinalize }: Props = $props()
</script>

<section
  class="overflow-hidden rounded-xl border bg-surface shadow-sm"
  aria-label="Brainstorm ready"
>
  <div class="flex items-center gap-2 border-b px-4 py-2.5">
    <Lightbulb size={15} class="shrink-0 text-accent" />
    <p class="truncate text-xs font-semibold uppercase tracking-wide text-muted">
      Session report · Version {version}
    </p>
  </div>

  <div class="space-y-1.5 p-4">
    <p class="text-sm font-semibold text-foreground">Your current alignment is captured.</p>
    <p class="text-xs leading-relaxed text-muted">
      Keep talking to refine the direction, review the concise report, or use it to prepare the
      specification.
    </p>
  </div>

  <div class="flex items-center justify-end gap-2 border-t px-4 py-2.5">
    <button
      class="min-h-8 rounded-lg border bg-elevated px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-overlay disabled:opacity-40"
      disabled={busy}
      onclick={onReview}
    >
      Review report
    </button>
    <button
      class="flex min-h-8 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-40"
      disabled={busy}
      onclick={onFinalize}
    >
      Prepare spec
      <ArrowRight size={13} />
    </button>
  </div>
</section>
