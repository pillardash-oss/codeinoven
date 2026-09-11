<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import {
    ArrowLeft,
    ArrowRight,
    LoaderCircle,
    Lock,
    LockOpen,
    RotateCw,
    SquareTerminal,
    X
  } from '@lucide/svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { normalizeBrowserUrl } from '$shared/local-development-url'
  import { contextSidebarState, type BrowserContextTab } from '$lib/stores/context-sidebar.svelte'
  import type {
    BrowserDevToolsState,
    BrowserPageState,
    BrowserViewBounds
  } from '$shared/ipc-contract'

  interface Props {
    tab: BrowserContextTab
    fullscreen?: boolean
    /** True while this tab's native view is shown by another instance (e.g. the
     *  fullscreen dialog). Forces the native view hidden so two instances never
     *  fight over the same WebContentsView. */
    suppressed?: boolean
  }

  let { tab, fullscreen = false, suppressed = false }: Props = $props()

  // Capture stable tab identity at construction — `tab` is a prop object that
  // Svelte may detach during keyed destroy, so every async callback and
  // teardown must read from this snapshot instead of `tab.id` directly.
  // svelte-ignore state_referenced_locally
  const tabId = tab.id
  // svelte-ignore state_referenced_locally
  const tabProjectId = tab.projectId
  // svelte-ignore state_referenced_locally
  const tabThreadId = tab.threadId
  // svelte-ignore state_referenced_locally
  const tabInitialUrl = tab.url
  // svelte-ignore state_referenced_locally
  const tabInitialTitle = tab.title

  function initialPageState(): BrowserPageState {
    return {
      tabId,
      url: tabInitialUrl,
      title: tabInitialTitle,
      favicon: null,
      loading: true,
      canGoBack: false,
      canGoForward: false
    }
  }

  let contentElement = $state<HTMLDivElement>()
  let address = $state(initialPageState().url)
  let addressError = $state('')
  let pageState = $state<BrowserPageState>(initialPageState())
  let panelVisible = $derived(
    !suppressed &&
      !contextSidebarState.fullscreenSuppression &&
      !contextSidebarState.browserSwitcherSuspendsView &&
      (fullscreen ||
        (contextSidebarState.sidebarVisible && contextSidebarState.sidebarActiveTab?.id === tabId))
  )
  let devToolsOpen = $state(false)
  /** Show a closed padlock for https origins; open padlock for everything else. */
  let secure = $derived(pageState.url.startsWith('https:'))
  /** The site menu is a native OS popup composited above the page view, so
   *  the view never has to detach for it; the open flag only tracks the
   *  expanded state of the anchor button. */
  let siteMenuOpen = $state(false)

  let siteHost = $derived.by(() => {
    try {
      return new URL(pageState.url).host
    } catch {
      return ''
    }
  })

  /** Open the native site-settings menu anchored at the lock button. The main
   *  process builds an OS context menu (with native destructive-action
   *  confirmation dialogs) that composites above the page view, so the view
   *  never detaches for this interaction. */
  function openSiteMenu(event: MouseEvent): void {
    const button = event.currentTarget
    if (!(button instanceof HTMLElement)) return
    const rect = button.getBoundingClientRect()
    siteMenuOpen = true
    void invoke(
      'browser:siteMenu',
      tabProjectId,
      siteHost,
      Math.max(0, Math.round(rect.left)),
      Math.max(0, Math.round(rect.bottom + 4))
    ).catch(() => {
      siteMenuOpen = false
    })
  }

  const attachContentElement: Attachment<HTMLDivElement> = (element) => {
    contentElement = element
    return () => {
      if (contentElement === element) contentElement = undefined
    }
  }

  const manageNativeBrowserView: Attachment<HTMLDivElement> = () => {
    void tick().then(() => {
      showAtCurrentBounds().catch(() => {})
    })
    return () => {
      void invoke('browser:hide', tabId).catch(() => {})
    }
  }

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
    // Read deriveds outside the async continuation so Svelte doesn't flag
    // `derived_inert` when this is called from ResizeObserver/rAF after
    // the owning render effect has been torn down.
    const visible = untrack(() => panelVisible)
    if (!visible) return
    const bounds = contentBounds()
    if (!bounds) return
    try {
      const currentUrl = untrack(() => (tab as BrowserContextTab | null)?.url ?? tabInitialUrl)
      pageState = await invoke('browser:show', tabId, tabProjectId, tabThreadId, currentUrl, bounds)
    } catch {
      // Tab may have been destroyed between the visibility check and the IPC.
    }
  }

  function navigate(): void {
    const url = normalizeBrowserUrl(address)
    if (!url) {
      addressError = 'Enter an http or https address'
      return
    }
    addressError = ''
    address = url
    contextSidebarState.updateBrowserTab(tabId, url)
    void invoke('browser:navigate', tabId, url).catch(() => {})
  }

  function applyPageState(next: BrowserPageState): void {
    if (next.tabId !== tabId) return
    pageState = next
    if (next.url) address = next.url
    contextSidebarState.updateBrowserTab(
      tabId,
      next.url || untrack(() => (tab as BrowserContextTab | null)?.url ?? tabInitialUrl),
      next.title,
      next.favicon
    )
  }

  async function toggleDevTools(): Promise<void> {
    try {
      devToolsOpen = await invoke('browser:toggleDevTools', tabId)
    } catch {
      // Tab already destroyed.
    }
  }

  function applyDevToolsState(state: BrowserDevToolsState): void {
    if (state.tabId !== tabId) return
    devToolsOpen = state.open
  }

  onMount(() => {
    const unsubscribeSiteMenu = subscribe('browser:siteMenuClosed', () => {
      siteMenuOpen = false
    })
    let destroyed = false
    const unsubscribeState = subscribe('browser:state', applyPageState)
    const unsubscribeDevTools = subscribe('browser:devToolsChanged', applyDevToolsState)
    const observer = new ResizeObserver(() => {
      if (!destroyed) void showAtCurrentBounds().catch(() => {})
    })
    if (contentElement) observer.observe(contentElement)
    const onWindowResize = (): void => {
      if (!destroyed) void showAtCurrentBounds().catch(() => {})
    }
    window.addEventListener('resize', onWindowResize)

    // The sidebar enters with a short transform. Follow its rectangle until the
    // transition settles so native content remains aligned with the Svelte frame.
    const startedAt = performance.now()
    let animationFrame = 0
    const followTransition = (now: number): void => {
      if (destroyed) return
      void showAtCurrentBounds().catch(() => {})
      if (now - startedAt < 260) animationFrame = requestAnimationFrame(followTransition)
    }
    animationFrame = requestAnimationFrame(followTransition)
    return () => {
      destroyed = true
      cancelAnimationFrame(animationFrame)
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
      unsubscribeSiteMenu()
      unsubscribeState()
      unsubscribeDevTools()
      void invoke('browser:hide', tabId).catch(() => {})
    }
  })
</script>

<div {@attach panelVisible && manageNativeBrowserView} class="flex h-full min-h-0 flex-col bg-app">
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
      onclick={() => void invoke('browser:goBack', tabId).catch(() => {})}
    >
      <ArrowLeft size={14} />
    </button>
    <button
      type="button"
      class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-35"
      disabled={!pageState.canGoForward}
      aria-label="Go forward"
      title="Go forward"
      onclick={() => void invoke('browser:goForward', tabId).catch(() => {})}
    >
      <ArrowRight size={14} />
    </button>
    <button
      type="button"
      class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      aria-label={pageState.loading ? 'Stop loading' : 'Reload page'}
      title={pageState.loading ? 'Stop loading' : 'Reload page'}
      onclick={() =>
        void invoke(pageState.loading ? 'browser:stop' : 'browser:reload', tabId).catch(() => {})}
    >
      {#if pageState.loading}
        <X size={14} />
      {:else}
        <RotateCw size={13} />
      {/if}
    </button>
    <div class="relative min-w-0 flex-1">
      <span class="sr-only">Browser address</span>
      <button
        type="button"
        class="absolute left-1.5 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title={secure ? 'Site settings' : 'Connection is not secure'}
        aria-label={secure ? 'Site settings' : 'Connection is not secure'}
        aria-haspopup="menu"
        aria-expanded={siteMenuOpen}
        onclick={openSiteMenu}
      >
        {#if secure}
          <Lock size={13} />
        {:else}
          <LockOpen size={13} />
        {/if}
      </button>
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
    </div>
    <button
      type="button"
      class={[
        'relative flex h-7 shrink-0 items-center justify-center rounded-md transition-colors',
        fullscreen ? 'gap-1.5 px-2 text-[0.6875rem] font-medium' : 'w-7',
        devToolsOpen
          ? 'bg-elevated text-foreground'
          : 'text-dimmed hover:bg-elevated hover:text-foreground'
      ]}
      aria-label="Toggle browser DevTools"
      aria-pressed={devToolsOpen}
      title="Toggle browser DevTools"
      onclick={() => void toggleDevTools()}
    >
      <SquareTerminal size={13} />
      {#if fullscreen}
        <span>Console</span>
      {/if}
    </button>
  </form>
  {#if addressError}
    <p
      class="shrink-0 border-b border-danger/20 bg-danger/10 px-3 py-1 text-[0.6875rem] text-danger"
      role="alert"
    >
      {addressError}
    </p>
  {/if}
  <div
    {@attach attachContentElement}
    data-native-browser-content
    class="min-h-0 min-w-0 flex-1 bg-surface"
    role="document"
    aria-label={`Browser content for ${pageState.title || address}`}
  ></div>
</div>
