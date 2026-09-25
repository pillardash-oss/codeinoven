<script lang="ts">
  import { Loader2, Search } from '@lucide/svelte'
  import type { GitCommitInfo } from '$shared/types'
  import FindInBar from '../files/FindInBar.svelte'
  import { relativeTime } from './git-status-panel-format'

  interface Props {
    open: boolean
    query: string
    activeIndex: number
    focusTrigger: number
    loading: boolean
    results: GitCommitInfo[]
    onQueryChange: (query: string) => void | Promise<void>
    onNext: () => void
    onPrev: () => void
    onSubmit: () => void
    onClose: () => void
    onSelectResult: (commit: GitCommitInfo) => void
  }

  let {
    open,
    query,
    activeIndex = $bindable(),
    focusTrigger,
    loading,
    results,
    onQueryChange,
    onNext,
    onPrev,
    onSubmit,
    onClose,
    onSelectResult
  }: Props = $props()
</script>

{#if open}
  <div data-find-exclude class="absolute right-3 top-3 z-30 w-[min(26rem,calc(100%-1.5rem))]">
    <FindInBar
      {query}
      matches={results.length}
      {activeIndex}
      placeholder="Search commit title or hash…"
      label="Search commits"
      {focusTrigger}
      {onQueryChange}
      {onNext}
      {onPrev}
      {onSubmit}
      {onClose}
    />
    {#if query}
      <div
        class="mt-1 max-h-80 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-xl"
        aria-live="polite"
      >
        {#if loading}
          <div class="flex items-center justify-center gap-2 px-3 py-6 text-xs text-dimmed">
            <Loader2 size={13} class="animate-spin" aria-hidden="true" />
            Searching commits…
          </div>
        {:else if results.length === 0}
          <p class="px-3 py-6 text-center text-xs text-dimmed">No matching commits</p>
        {:else}
          {#each results as commit, index (commit.hash)}
            <button
              type="button"
              class={[
                'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                index === activeIndex
                  ? 'bg-primary/10 text-foreground'
                  : 'text-muted hover:bg-elevated'
              ]}
              aria-current={index === activeIndex ? 'true' : undefined}
              onclick={() => onSelectResult(commit)}
              onmouseenter={() => (activeIndex = index)}
            >
              <Search size={12} class="mt-0.5 shrink-0 text-dimmed" aria-hidden="true" />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[0.6875rem] leading-snug">
                  {commit.message.split('\n')[0]}
                </span>
                <span class="mt-0.5 flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
                  <span class="font-mono">{commit.shortHash}</span>
                  <span>·</span>
                  <span class="truncate">{commit.author}</span>
                  <span>·</span>
                  <span class="shrink-0">{relativeTime(commit.date)}</span>
                </span>
              </span>
            </button>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
{/if}
