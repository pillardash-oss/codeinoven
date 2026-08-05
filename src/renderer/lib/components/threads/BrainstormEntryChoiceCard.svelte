<script lang="ts">
  import { FileText, Lightbulb, Sparkles } from '@lucide/svelte'

  interface Props {
    busy?: boolean
    retryChoice?: 'brainstorm' | 'spec'
    onStartBrainstorm: () => void | Promise<void>
    onJumpToSpec: () => void | Promise<void>
  }

  let { busy = false, retryChoice, onStartBrainstorm, onJumpToSpec }: Props = $props()
</script>

<section
  class="overflow-hidden rounded-xl border bg-surface shadow-sm"
  aria-label="Choose planning path"
>
  <div class="flex items-center gap-2 border-b px-4 py-2.5">
    <Sparkles size={15} class="shrink-0 text-accent" />
    <p class="truncate text-xs font-semibold uppercase tracking-wide text-muted">Plan your work</p>
  </div>

  <div class="space-y-1.5 p-4">
    <p class="text-sm font-semibold text-foreground">
      {retryChoice ? 'Planning paused' : 'How do you want to begin?'}
    </p>
    <p class="text-xs leading-relaxed text-muted">
      {retryChoice
        ? 'The saved planning choice is safe. Retry generation without choosing the path again.'
        : 'Brainstorm with the Sr. Engineer to gather prerequisites, or move directly to a specification.'}
    </p>
  </div>

  <div class="grid gap-2 border-t p-3 {retryChoice ? '' : 'sm:grid-cols-2'}">
    {#if !retryChoice || retryChoice === 'brainstorm'}
      <button
        class="flex min-h-14 items-start gap-2.5 rounded-lg border bg-elevated px-3 py-2.5 text-left transition-colors hover:bg-overlay disabled:opacity-40"
        disabled={busy}
        onclick={onStartBrainstorm}
      >
        <Lightbulb size={15} class="mt-0.5 shrink-0 text-accent" />
        <span class="min-w-0">
          <span class="block text-xs font-semibold text-foreground">
            {retryChoice ? 'Retry brainstorm' : 'Start brainstorm'}
          </span>
          <span class="mt-0.5 block text-[11px] leading-relaxed text-muted">
            Gather context, decisions, constraints, and open questions before the spec.
          </span>
        </span>
      </button>
    {/if}
    {#if !retryChoice || retryChoice === 'spec'}
      <button
        class="flex min-h-14 items-start gap-2.5 rounded-lg border bg-elevated px-3 py-2.5 text-left transition-colors hover:bg-overlay disabled:opacity-40"
        disabled={busy}
        onclick={onJumpToSpec}
      >
        <FileText size={15} class="mt-0.5 shrink-0 text-primary" />
        <span class="min-w-0">
          <span class="block text-xs font-semibold text-foreground">
            {retryChoice ? 'Retry specification' : 'Jump into spec'}
          </span>
          <span class="mt-0.5 block text-[11px] leading-relaxed text-muted">
            Skip brainstorming and ask the Sr. Engineer to prepare the specification now.
          </span>
        </span>
      </button>
    {/if}
  </div>
</section>
