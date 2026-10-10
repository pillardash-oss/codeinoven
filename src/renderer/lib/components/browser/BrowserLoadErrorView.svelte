<script lang="ts">
  import { ArrowLeft, LoaderCircle, RotateCw } from '@lucide/svelte'
  import type { BrowserLoadError } from '$shared/ipc-contract'
  import {
    browserLoadErrorCopy,
    browserLoadErrorDetail,
    browserLoadErrorHost
  } from './browser-load-error'

  /**
   * The stand-in for a browser page that could not load.
   *
   * A failed navigation leaves a native `WebContentsView` with no document, and
   * the page is composited above the DOM, so this card is what the surface shows
   * instead: what failed, the address it failed on, the raw error, and the one
   * action that can fix it. It is the single error surface for both the global
   * browser workspace and the context sidebar's browser panel.
   */
  interface Props {
    error: BrowserLoadError
    /** The address that failed, shown so the user can see and correct it. */
    url: string
    /** Whether the tab is loading again, so the reload action shows progress. */
    loading: boolean
    /** Whether the tab's own history can step back, which is a way out too. */
    canGoBack?: boolean
    onRetry: () => void
    onGoBack?: () => void
    /**
     * Edit the failed address. When provided the address pill becomes a button
     * that opens the surface's own address entry; surfaces without one (the
     * peek window, whose spotlight would edit the wrong tab) leave it static.
     */
    onEditAddress?: () => void
  }

  let { error, url, loading, canGoBack = false, onRetry, onGoBack, onEditAddress }: Props = $props()

  const copy = $derived(browserLoadErrorCopy(error, browserLoadErrorHost(url)))
  const detail = $derived(browserLoadErrorDetail(error))
</script>

<div class="flex h-full min-h-0 w-full items-center justify-center px-6 py-10">
  <div
    class="flex w-full max-w-md flex-col items-center gap-3 text-center"
    role="alert"
    data-region="browser-load-error"
  >
    <div class="flex h-11 w-11 items-center justify-center rounded-full bg-elevated">
      <copy.icon size={20} class="text-dimmed" />
    </div>
    <div class="flex flex-col gap-1">
      <p class="text-sm font-semibold text-foreground">{copy.title}</p>
      <p class="text-xs leading-relaxed text-muted">{copy.description}</p>
    </div>
    {#if url}
      {#if onEditAddress}
        <button
          type="button"
          class="max-w-full cursor-pointer truncate rounded-lg border border-border bg-elevated px-2.5 py-1 font-mono text-xs text-muted outline-none transition-colors hover:bg-overlay hover:text-foreground focus-visible:bg-overlay"
          title={url}
          aria-label={`Edit address ${url}`}
          onclick={onEditAddress}
        >
          {url}
        </button>
      {:else}
        <p
          class="max-w-full truncate rounded-lg border border-border bg-elevated px-2.5 py-1 font-mono text-xs text-muted"
          title={url}
        >
          {url}
        </p>
      {/if}
    {/if}
    <p class="font-mono text-xs text-dimmed" title={detail}>{detail}</p>
    <div class="mt-1 flex items-center gap-2">
      <button
        type="button"
        class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
        title="Reload this page"
        disabled={loading}
        onclick={onRetry}
      >
        {#if loading}
          <LoaderCircle size={13} class="animate-spin" />
          Reloading
        {:else}
          <RotateCw size={13} />
          Reload
        {/if}
      </button>
      {#if canGoBack && onGoBack}
        <button
          type="button"
          class="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-elevated px-3 text-xs font-medium text-foreground transition-colors hover:bg-overlay"
          title="Go back to the previous page"
          onclick={onGoBack}
        >
          <ArrowLeft size={13} />
          Go back
        </button>
      {/if}
    </div>
  </div>
</div>
