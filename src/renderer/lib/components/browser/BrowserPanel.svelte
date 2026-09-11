<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import {
    ArrowLeft,
    ArrowRight,
    Cookie,
    Database,
    Eraser,
    Lock,
    LockOpen,
    LoaderCircle,
    RotateCw,
    ShieldOff,
    SquareTerminal,
    X
  } from '@lucide/svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { normalizeBrowserUrl } from '$shared/local-development-url'
  import { contextSidebarState, type BrowserContextTab } from '$lib/stores/context-sidebar.svelte'
  import type {
    BrowserSiteDataScope,
    BrowserConsoleEntry,
    BrowserPageState,
    BrowserViewBounds
  } from '$shared/ipc-contract'
  import Modal from '../ui/Modal.svelte'

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
      (fullscreen ||
        (contextSidebarState.sidebarVisible &&
          contextSidebarState.sidebarActiveTab?.id === tabId))
  )
  let consoleEntries = $state<BrowserConsoleEntry[]>([])
  let errorCount = $derived(consoleEntries.filter((entry) => entry.level === 'error').length)
  let devToolsOpen = $state(false)
  /** Show a closed padlock for https origins; open padlock for everything else. */
  let secure = $derived(pageState.url.startsWith('https:'))
  /** The site menu and its confirmation modal are DOM, while the page itself is a
   *  native WebContentsView that floats above every DOM surface — the view must
   *  stay hidden whenever either layer is open. */
  let siteMenuOpen = $state(false)
  let pendingClearScope = $state<BrowserSiteDataScope | null>(null)
  let clearingSiteData = $state(false)
  let siteDataError = $state('')

  let siteHost = $derived.by(() => {
    try {
      return new URL(pageState.url).host
    } catch {
      return ''
    }
  })

  interface ClearAction {
    scope: BrowserSiteDataScope
    label: string
    icon: typeof Lock
    detail: string
  }

  const clearActions: readonly ClearAction[] = [
    {
      scope: 'cookies',
      label: 'Clear cookies',
      icon: Cookie,
      detail: 'Cookies for sites visited in this browser will be deleted. You may be signed out.'
    },
    {
      scope: 'site-data',
      label: 'Clear site data',
      icon: Database,
      detail:
        'Storage, service workers and sessions for sites visited in this browser will be deleted.'
    },
    {
      scope: 'cache',
      label: 'Clear cache',
      icon: Eraser,
      detail: 'Cached files for sites visited in this browser will be deleted.'
    },
    {
      scope: 'permissions',
      label: 'Reset permissions',
      icon: ShieldOff,
      detail: 'Remembered camera, microphone and other permission choices for sites visited in this browser will be forgotten.'
    }
  ]
  let pendingClearAction = $derived(
    clearActions.find((action) => action.scope === pendingClearScope) ?? null
  )

  async function openSiteMenu(): Promise<void> {
    siteDataError = ''
    siteMenuOpen = true
    try {
      await invoke('browser:hide', tabId)
    } catch {
      // Tab already destroyed.
    }
  }

  async function restoreNativeView(): Promise<void> {
    if (siteMenuOpen || pendingClearScope !== null) return
    await tick()
    await showAtCurrentBounds().catch(() => {})
  }

  function closeSiteMenu(): void {
    siteMenuOpen = false
    void restoreNativeView()
  }

  function chooseClear(scope: BrowserSiteDataScope): void {
    siteDataError = ''
    siteMenuOpen = false
    pendingClearScope = scope
  }

  function cancelClear(): void {
    if (clearingSiteData) return
    pendingClearScope = null
    void restoreNativeView()
  }

  async function runClear(): Promise<void> {
    const scope = pendingClearScope
    if (!scope || clearingSiteData) return
    clearingSiteData = true
    try {
      await invoke('browser:clearSiteData', tabProjectId, [scope])
      pendingClearScope = null
      await restoreNativeView()
    } catch (error) {
      siteDataError =
        error instanceof Error && error.message
          ? error.message
          : 'Browser site data could not be cleared.'
      void restoreNativeView()
    } finally {
      clearingSiteData = false
    }
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

  function mergeConsoleEntries(entries: BrowserConsoleEntry[]): void {
    const merged = [...consoleEntries]
    for (const entry of entries) {
      if (entry.tabId !== tabId) continue
      const index = merged.findIndex((candidate) => candidate.id === entry.id)
      if (index >= 0) merged[index] = entry
      else merged.push(entry)
    }
    consoleEntries = merged.sort((left, right) => left.timestamp - right.timestamp).slice(-500)
  }

  function applyConsoleEntry(entry: BrowserConsoleEntry): void {
    if (entry.tabId !== tabId) return
    mergeConsoleEntries([entry])
  }

  async function toggleDevTools(): Promise<void> {
    try {
      devToolsOpen = await invoke('browser:toggleDevTools', tabId)
    } catch {
      // Tab already destroyed.
    }
  }

  onMount(() => {
    let destroyed = false
    const unsubscribeState = subscribe('browser:state', applyPageState)
    const unsubscribeConsole = subscribe('browser:console', applyConsoleEntry)
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
    void invoke('browser:getConsole', tabId).then(mergeConsoleEntries).catch(() => {})

    return () => {
      destroyed = true
      cancelAnimationFrame(animationFrame)
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
      unsubscribeState()
      unsubscribeConsole()
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
      onclick={() => void invoke(pageState.loading ? 'browser:stop' : 'browser:reload', tabId).catch(() => {})}
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
        onclick={() => (siteMenuOpen ? closeSiteMenu() : void openSiteMenu())}
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
      {#if siteMenuOpen}
        <button
          type="button"
          class="fixed inset-0 z-30 cursor-default"
          title="Close site settings"
          aria-label="Close site settings"
          onclick={closeSiteMenu}
        ></button>
        <div
          class="absolute left-0 top-full z-40 mt-1 w-64 rounded-lg border bg-surface p-1 shadow-lg"
          role="menu"
          aria-label="Site settings"
        >
          <p class="truncate px-2.5 py-1.5 font-medium text-foreground" title={siteHost}>
            {siteHost || 'This page'}
          </p>
          {#each clearActions as action (action.scope)}
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-foreground transition-colors hover:bg-elevated"
              role="menuitem"
              title={action.label}
              onclick={() => chooseClear(action.scope)}
            >
              <action.icon size={14} class="shrink-0 text-dimmed" />
              <span class="flex-1">{action.label}</span>
            </button>
          {/each}
        </div>
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
        {#if errorCount > 0}
          <span class="rounded-full bg-danger/15 px-1.5 text-[0.5625rem] font-semibold text-danger">
            {errorCount}
          </span>
        {/if}
      {:else if errorCount > 0}
        <span class="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-danger" aria-hidden="true"
        ></span>
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
  {:else if siteDataError}
    <p
      class="shrink-0 border-b border-danger/20 bg-danger/10 px-3 py-1 text-[0.6875rem] text-danger"
      role="alert"
    >
      {siteDataError}
    </p>
  {/if}
  <div
    {@attach attachContentElement}
    data-native-browser-content
    class="min-h-0 flex-1 bg-surface"
    role="document"
    aria-label={`Browser content for ${pageState.title || address}`}
  ></div>
</div>

<Modal
  open={pendingClearAction !== null}
  title={pendingClearAction ? `${pendingClearAction.label}?` : ''}
  onClose={cancelClear}
  closeOnBackdrop={!clearingSiteData}
>
  {#if pendingClearAction}
    <p class="text-sm leading-relaxed text-muted">{pendingClearAction.detail}</p>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated disabled:opacity-50"
      title="Keep site data"
      disabled={clearingSiteData}
      onclick={cancelClear}
    >
      Cancel
    </button>
    <button
      type="button"
      class="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-on-danger transition-colors hover:bg-danger-hover disabled:opacity-50"
      title={pendingClearAction ? pendingClearAction.label : ''}
      disabled={clearingSiteData}
      onclick={() => void runClear()}
    >
      {clearingSiteData ? 'Clearing…' : pendingClearAction ? pendingClearAction.label : ''}
    </button>
  {/snippet}
</Modal>
