<script lang="ts">
  import { onMount } from 'svelte'
  import { ArrowLeft, ArrowRight, Globe2, LoaderCircle, RotateCw, X } from '@lucide/svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { normalizeBrowserUrl } from '$shared/local-development-url'
  import { contextSidebarState, type BrowserContextTab } from '$lib/stores/context-sidebar.svelte'
  import type { BrowserPageState, BrowserViewBounds } from '$shared/ipc-contract'

  interface Props {
    tab: BrowserContextTab
  }

  let { tab }: Props = $props()

  function initialPageState(): BrowserPageState {
    return {
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      loading: true,
      canGoBack: false,
      canGoForward: false
    }
  }

  let contentElement = $state<HTMLDivElement>()
  let address = $state(initialPageState().url)
  let addressError = $state('')
  let pageState = $state<BrowserPageState>(initialPageState())

  function contentBounds(): BrowserViewBounds | null {
    if (!contentElement) return null
    const rect = contentElement.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    return {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height))
    }
  }

  async function showAtCurrentBounds(): Promise<void> {
    const bounds = contentBounds()
    if (!bounds) return
    pageState = await invoke('browser:show', tab.id, tab.url, bounds)
  }

  function navigate(): void {
    const url = normalizeBrowserUrl(address)
    if (!url) {
      addressError = 'Enter an http or https address'
      return
    }
    addressError = ''
    address = url
    contextSidebarState.updateBrowserTab(tab.id, url)
    void invoke('browser:navigate', tab.id, url)
  }

  function applyPageState(next: BrowserPageState): void {
    if (next.tabId !== tab.id) return
    pageState = next
    if (next.url) address = next.url
    contextSidebarState.updateBrowserTab(tab.id, next.url || tab.url, next.title)
  }

  onMount(() => {
    const unsubscribeState = subscribe('browser:state', applyPageState)
    const observer = new ResizeObserver(() => void showAtCurrentBounds())
    if (contentElement) observer.observe(contentElement)
    const onWindowResize = (): void => void showAtCurrentBounds()
    window.addEventListener('resize', onWindowResize)

    // The sidebar enters with a short transform. Follow its rectangle until the
    // transition settles so native content remains aligned with the Svelte frame.
    const startedAt = performance.now()
    let animationFrame = 0
    const followTransition = (now: number): void => {
      void showAtCurrentBounds()
      if (now - startedAt < 260) animationFrame = requestAnimationFrame(followTransition)
    }
    animationFrame = requestAnimationFrame(followTransition)

    return () => {
      cancelAnimationFrame(animationFrame)
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
      unsubscribeState()
      void invoke('browser:hide', tab.id)
    }
  })
</script>

<div class="flex h-full min-h-0 flex-col bg-app">
  <form
    class="flex h-10 shrink-0 items-center gap-1.5 border-b border-border bg-surface px-2"
    onsubmit={(event) => {
      event.preventDefault()
      navigate()
    }}
  >
    <button
      type="button"
      class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-35"
      disabled={!pageState.canGoBack}
      aria-label="Go back"
      title="Go back"
      onclick={() => void invoke('browser:goBack', tab.id)}
    >
      <ArrowLeft size={14} />
    </button>
    <button
      type="button"
      class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-35"
      disabled={!pageState.canGoForward}
      aria-label="Go forward"
      title="Go forward"
      onclick={() => void invoke('browser:goForward', tab.id)}
    >
      <ArrowRight size={14} />
    </button>
    <button
      type="button"
      class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      aria-label={pageState.loading ? 'Stop loading' : 'Reload page'}
      title={pageState.loading ? 'Stop loading' : 'Reload page'}
      onclick={() => void invoke(pageState.loading ? 'browser:stop' : 'browser:reload', tab.id)}
    >
      {#if pageState.loading}
        <X size={14} />
      {:else}
        <RotateCw size={13} />
      {/if}
    </button>
    <label class="relative min-w-0 flex-1">
      <span class="sr-only">Browser address</span>
      <Globe2
        size={13}
        class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dimmed"
      />
      <input
        class="h-7 w-full rounded-lg border border-border bg-elevated pl-8 pr-8 text-xs text-foreground outline-none transition-colors placeholder:text-dimmed focus:border-primary"
        class:border-danger={addressError !== ''}
        bind:value={address}
        spellcheck="false"
        autocomplete="url"
        placeholder="localhost:3000"
        aria-invalid={addressError ? 'true' : undefined}
      />
      {#if pageState.loading}
        <LoaderCircle
          size={13}
          class="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-primary"
        />
      {/if}
    </label>
  </form>
  {#if addressError}
    <p
      class="shrink-0 border-b border-danger/20 bg-danger/10 px-3 py-1 text-[11px] text-danger"
      role="alert"
    >
      {addressError}
    </p>
  {/if}
  <div
    bind:this={contentElement}
    class="min-h-0 flex-1 bg-surface"
    role="document"
    aria-label={`Browser content for ${pageState.title || address}`}
  ></div>
</div>
