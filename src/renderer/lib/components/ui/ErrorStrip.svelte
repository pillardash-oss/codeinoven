<script lang="ts">
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioDebugger from '@pdslng/cio-icon/CioDebugger.svelte'
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import { onMount, type Snippet } from 'svelte'
  import { fade } from 'svelte/transition'
  import { formatCompactAge } from '$shared/date-time-format'

  /**
   * The one error card: a single row that unfolds for the rest.
   *
   * Folded, it is the plain headline, how long ago it failed, and the fix, so a
   * recoverable failure costs one line wherever it appears (the composer dock, a
   * panel, a terminal). Unfolded, it states the cause in full and offers the
   * secondary actions. Falsy actions (Dismiss, Raw error) sit on the left of the
   * footer and the primary action sits on the right, as in every other card.
   *
   * The headline is always plain language. The raw diagnostic text, with the IPC
   * wrapper and error class, only ever appears behind Raw error.
   */
  interface Props {
    /** Plain headline naming the problem, never the plumbing. */
    title: string
    /** The cause and fix in a sentence or two. Inline when there is room, in full when unfolded. */
    message?: string
    /** Full diagnostic text, shown only on request. */
    rawError?: string
    /** When it failed, as epoch milliseconds. Drives the age beside the headline. */
    failedAt?: number
    tone?: 'danger' | 'warning'
    /** Starts folded; the reader unfolds it. */
    folded?: boolean
    /** The fix. It sits in the row while folded, and moves to the right of the
     *  footer when unfolded so the open card stays balanced. */
    primary?: Snippet
    /** Extra detail for the unfolded body, such as the path that was expected. */
    body?: Snippet
    /** Secondary actions at the right of the unfolded footer. */
    footerEnd?: Snippet
    onDismiss?: () => void
    class?: string
  }

  let {
    title,
    message,
    rawError,
    failedAt,
    tone = 'danger',
    folded = $bindable(true),
    primary,
    body,
    footerEnd,
    onDismiss,
    class: className = ''
  }: Props = $props()

  const bodyId = $props.id()
  const rawId = `${bodyId}-raw`

  let rawOpen = $state(false)

  // The age is only worth redrawing while a failure time is on screen, and a
  // minute is the smallest step it ever shows.
  let now = $state(Date.now())
  let age = $derived(failedAt === undefined ? '' : formatCompactAge(failedAt, now))
  /** "Now" and the compact steps read as a sentence; an older date stands alone. */
  let ageLabel = $derived(age === 'Now' ? 'just now' : /^\d+[mhd]$/u.test(age) ? `${age} ago` : age)

  onMount(() => {
    if (failedAt === undefined) return
    const timer = setInterval(() => (now = Date.now()), 30_000)
    return () => clearInterval(timer)
  })

  let toneBorder = $derived(tone === 'danger' ? 'border-danger/40' : 'border-warning/40')
  let toneWash = $derived(tone === 'danger' ? 'bg-danger/10' : 'bg-warning/10')
  /** Status ink mixed toward the foreground: the raw status colours do not clear
   *  4.5:1 on either surface. */
  let ink = $derived(
    `color-mix(in srgb, var(--color-${tone === 'danger' ? 'danger' : 'warning'}) 62%, var(--color-foreground))`
  )

  const FADE_MS = 120

  const buttonClass =
    'flex h-7 items-center gap-1.5 border border-border-strong bg-surface px-2.5 text-xs transition-colors hover:bg-elevated'
</script>

<article
  class="@container flex min-w-0 flex-col border bg-surface {toneBorder} {className}"
  style:--ink={ink}
  role="alert"
  aria-label="Error: {title}"
>
  <header class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-1.5 {toneWash}">
    <CioAttention size={14} class="shrink-0 text-(--ink)" aria-hidden="true" />
    <h3 class="min-w-0 truncate text-[0.8125rem] font-semibold text-foreground">{title}</h3>
    {#if message}
      <p
        class="hidden min-w-0 flex-1 truncate text-[0.8125rem] text-muted @4xl:block @max-lg:order-3 @max-lg:block @max-lg:basis-full @max-lg:whitespace-normal"
      >
        {message}
      </p>
    {/if}
    <span class="min-w-0 flex-1 @4xl:hidden @max-lg:hidden"></span>
    {#if age}
      <span
        class="shrink-0 text-xs tabular-nums text-muted @max-lg:order-2 @max-lg:basis-full"
        title="Failed {ageLabel}"
      >
        {ageLabel}
      </span>
    {/if}
    {#if primary && folded}
      <div
        class="flex shrink-0 items-center gap-1.5 @max-lg:order-4 @max-lg:basis-full"
        transition:fade={{ duration: FADE_MS }}
      >
        {@render primary()}
      </div>
    {/if}
    <button
      type="button"
      class="flex h-7 w-7 shrink-0 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground @max-lg:order-1 @max-lg:ml-auto"
      aria-expanded={!folded}
      aria-controls={bodyId}
      title={folded ? `Unfold: ${title}` : `Fold: ${title}`}
      aria-label={folded ? `Unfold: ${title}` : `Fold: ${title}`}
      onclick={() => (folded = !folded)}
    >
      {#if folded}
        <CioForward size={14} aria-hidden="true" />
      {:else}
        <CioChevronDown size={14} aria-hidden="true" />
      {/if}
    </button>
  </header>

  <div id={bodyId} class="grid gap-2.5 border-t border-border px-3 py-2.5" hidden={folded}>
    {#if message}
      <p class="text-[0.8125rem] text-muted">{message}</p>
    {/if}
    {@render body?.()}
    {#if rawError}
      <pre
        id={rawId}
        class="m-0 border border-border bg-elevated px-2.5 py-2 font-mono text-xs break-words whitespace-pre-wrap text-muted"
        hidden={!rawOpen}>{rawError}</pre>
    {/if}
  </div>

  {#if onDismiss || rawError || footerEnd || primary}
    <footer
      class="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2"
      hidden={folded}
    >
      <div class="flex items-center gap-1.5">
        {#if onDismiss}
          <button
            type="button"
            class={buttonClass}
            title="Dismiss this error"
            aria-label="Dismiss this error"
            onclick={onDismiss}
          >
            <CioClose size={12} aria-hidden="true" />
            Dismiss
          </button>
        {/if}
        {#if rawError}
          <button
            type="button"
            class={buttonClass}
            aria-expanded={rawOpen}
            aria-controls={rawId}
            title={rawOpen ? 'Hide the raw error' : 'Show the raw error'}
            aria-label={rawOpen ? 'Hide the raw error' : 'Show the raw error'}
            onclick={() => (rawOpen = !rawOpen)}
          >
            <CioDebugger size={12} aria-hidden="true" />
            Raw error
          </button>
        {/if}
      </div>
      {#if footerEnd || primary}
        <div class="ml-auto flex items-center gap-1.5">
          {@render footerEnd?.()}
          {#if primary && !folded}
            <div class="flex items-center gap-1.5" in:fade={{ duration: FADE_MS, delay: FADE_MS }}>
              {@render primary()}
            </div>
          {/if}
        </div>
      {/if}
    </footer>
  {/if}
</article>
