<script lang="ts">
  import CioArchive from '@pdslng/cio-icon/CioArchive.svelte'
  import CioCommit from '@pdslng/cio-icon/CioCommit.svelte'
  import CioDot from '@pdslng/cio-icon/CioDot.svelte'
  import CioNetwork from '@pdslng/cio-icon/CioNetwork.svelte'
  import CioNotifications from '@pdslng/cio-icon/CioNotifications.svelte'
  import CioPlay from '@pdslng/cio-icon/CioPlay.svelte'
  import CioPullRequest from '@pdslng/cio-icon/CioPullRequest.svelte'
  import CioRocket from '@pdslng/cio-icon/CioRocket.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import FindInBar from '../files/FindInBar.svelte'
  import { GIT_FIND_WORDS, type GitFindRow, type GitFindScope } from './git-panel-find'

  interface Props {
    open: boolean
    /** What the bar searches, which the open view decides. */
    scope: GitFindScope
    query: string
    activeIndex: number
    focusTrigger: number
    loading: boolean
    rows: GitFindRow[]
    /** Why the last search could not be answered, when it could not. */
    error?: string | null
    onQueryChange: (query: string) => void | Promise<void>
    onNext: () => void
    onPrev: () => void
    onSubmit: () => void
    onClose: () => void
    onSelectResult: (row: GitFindRow) => void
  }

  let {
    open,
    scope,
    query,
    activeIndex = $bindable(),
    focusTrigger,
    loading,
    rows,
    error = null,
    onQueryChange,
    onNext,
    onPrev,
    onSubmit,
    onClose,
    onSelectResult
  }: Props = $props()

  /**
   * The glyph a row is drawn with: the same icon the view uses for that kind of
   * thing, so a branch found by search looks like the branch rows it came from.
   */
  function glyphFor(kind: GitFindRow['kind']): typeof CioCommit {
    switch (kind) {
      case 'commit':
        return CioCommit
      case 'branch':
        return CioNetwork
      case 'pull':
        return CioPullRequest
      case 'issue':
        return CioDot
      case 'notification':
        return CioNotifications
      case 'run':
        return CioPlay
      case 'deployment':
        return CioRocket
      case 'stash':
        return CioArchive
    }
  }

  const words = $derived(GIT_FIND_WORDS[scope])
</script>

{#if open}
  <div data-find-exclude class="absolute right-3 top-3 z-30 w-[min(26rem,calc(100%-1.5rem))]">
    <FindInBar
      {query}
      matches={rows.length}
      {activeIndex}
      placeholder={words.placeholder}
      label={words.label}
      {focusTrigger}
      {onQueryChange}
      {onNext}
      {onPrev}
      {onSubmit}
      {onClose}
    />
    {#if query}
      <div
        class="mt-1 max-h-80 overflow-y-auto border border-border bg-surface p-1 shadow-xl"
        aria-live="polite"
      >
        {#if loading}
          <div class="flex items-center justify-center gap-2 px-3 py-6 text-xs text-dimmed">
            <CioSpinner size={13} class="animate-spin" aria-hidden="true" />
            {words.busy}
          </div>
        {:else if error}
          <p class="px-3 py-6 text-center text-xs text-warning" role="status">{error}</p>
        {:else if rows.length === 0}
          <p class="px-3 py-6 text-center text-xs text-dimmed">{words.empty}</p>
        {:else}
          {#each rows as row, index (row.key)}
            {@const Glyph = glyphFor(row.kind)}
            <button
              type="button"
              class={[
                'flex w-full items-start gap-2 px-2.5 py-2 text-left transition-colors',
                index === activeIndex
                  ? 'bg-primary/10 text-foreground'
                  : 'text-muted hover:bg-elevated'
              ]}
              aria-current={index === activeIndex ? 'true' : undefined}
              onclick={() => onSelectResult(row)}
              onmouseenter={() => (activeIndex = index)}
            >
              <Glyph size={12} class="mt-0.5 shrink-0 text-dimmed" aria-hidden="true" />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[0.6875rem] leading-snug">{row.title}</span>
                <span class="mt-0.5 flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
                  <span class="min-w-0 truncate">{row.detail}</span>
                </span>
              </span>
              {#if row.badge}
                <span class="shrink-0 text-[0.5625rem] uppercase tracking-wide text-dimmed">
                  {row.badge}
                </span>
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
{/if}
