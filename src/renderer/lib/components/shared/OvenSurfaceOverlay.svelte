<script lang="ts">
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import type { Snippet } from 'svelte'
  import ErrorStrip from '$lib/components/ui/ErrorStrip.svelte'

  /**
   * The canonical state layer for a surface whose content lives on an Oven.
   *
   * Reading from an Oven is a round trip to another machine, so every such
   * surface has the same three moments and must present them the same way:
   * what it read last time, dimmed, while the live read is in flight; the live
   * answer once it lands; and, when the Oven cannot answer, the reason with a
   * way to try again. Each surface used to invent its own version of that
   * (a header spinner, an empty tree, a raw error string, a bare button), which
   * is why a panel could look empty rather than busy, or look broken rather
   * than asleep.
   *
   * A local surface passes `active` as false and renders through untouched, so
   * this stays the one implementation of the remote case rather than a second
   * way of drawing states the app already had.
   */
  interface Props {
    /** Whether the surface's content comes from an Oven. False renders children alone. */
    active: boolean
    /** Whether a read is in flight. */
    loading?: boolean
    /** Whether the content on screen is the last-known read, not a live one. */
    showingCached?: boolean
    /** Why the Oven could not answer, or null. Supersedes `loading` when set. */
    error?: string | null
    /** Heading for the error layer, naming the surface that failed. */
    title?: string
    /** What the loading layer says. */
    loadingLabel?: string
    retryLabel?: string
    /** Try the read again. Without it the error layer offers no button. */
    onRetry?: () => void
    children: Snippet
    class?: string
  }

  let {
    active,
    loading = false,
    showingCached = false,
    error = null,
    title = 'The Oven did not answer',
    loadingLabel = 'Reaching the Oven…',
    retryLabel = 'Try again',
    onRetry,
    children,
    class: className = ''
  }: Props = $props()

  let failed = $derived(Boolean(active && error))
  let busy = $derived(Boolean(active && !error && loading))
  let showLayer = $derived(failed || busy)
  /**
   * Content is greyed whenever it is not the live answer: the last-known read
   * while a fresh one is in flight, or while the Oven is refusing to answer.
   * An empty surface has nothing to grey, so the flag is only ever set
   * alongside `showingCached`.
   */
  let dimmed = $derived(Boolean(active && showingCached && (busy || failed)))
</script>

<div class="relative flex min-h-0 flex-1 flex-col {className}">
  <div
    class="flex min-h-0 flex-1 flex-col transition-opacity duration-150 {dimmed
      ? 'pointer-events-none opacity-40 grayscale'
      : ''}"
    aria-busy={busy}
  >
    {@render children()}
  </div>

  {#if showLayer}
    <div
      class="absolute inset-0 z-20 flex items-center justify-center p-4 {failed
        ? 'bg-app/85'
        : 'bg-transparent'}"
    >
      {#if failed}
        <ErrorStrip
          class="w-full max-w-lg shadow-lg"
          {title}
          message={error ?? undefined}
          folded={false}
        >
          {#snippet primary()}
            {#if onRetry}
              <button
                type="button"
                class="flex h-7 items-center gap-1.5 bg-primary px-2.5 text-xs font-semibold text-on-primary transition-colors hover:bg-primary-hover"
                onclick={onRetry}
              >
                <CioRefresh size={12} aria-hidden="true" />
                {retryLabel}
              </button>
            {/if}
          {/snippet}
        </ErrorStrip>
      {:else}
        <div
          class="flex items-center gap-2 border border-border bg-elevated/95 px-3 py-1.5 shadow-sm"
          role="status"
          aria-live="polite"
        >
          <CioSpinner size={13} class="animate-spin text-muted" aria-hidden="true" />
          <span class="text-[0.625rem] font-medium text-muted">{loadingLabel}</span>
        </div>
      {/if}
    </div>
  {/if}
</div>
