<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import {
    ArrowLeft,
    ArrowRight,
    Globe2,
    LoaderCircle,
    RotateCw,
    SquareTerminal,
    X
  } from '@lucide/svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { normalizeBrowserUrl } from '$shared/local-development-url'
  import { contextSidebarState, type BrowserContextTab } from '$lib/stores/context-sidebar.svelte'
  import type {
    BrowserConsoleEntry,
    BrowserConsoleLevel,
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
      loading: true,
      canGoBack: false,
      canGoForward: false
    }
  }

  let contentElement = $state<HTMLDivElement>()
  let address = $state(initialPageState().url)
  let addressError = $state('')
  let pageState = $state<BrowserPageState>(initialPageState())
  // svelte-ignore state_referenced_locally
  const initialSurface = tab.surface
  let activeSurface = $derived((tab as BrowserContextTab | null)?.surface ?? initialSurface)
  let panelVisible = $derived(
    !suppressed &&
      !contextSidebarState.fullscreenSuppression &&
      (fullscreen ||
        (contextSidebarState.sidebarVisible &&
          contextSidebarState.sidebarActiveTab?.id === tabId))
  )
  let consoleEntries = $state<BrowserConsoleEntry[]>([])
  let consoleElement = $state<HTMLDivElement>()
  let errorCount = $derived(consoleEntries.filter((entry) => entry.level === 'error').length)
  let consoleToggleLabel = $derived(
    activeSurface === 'console' ? 'Show browser page' : 'Show browser console'
  )

  const attachContentElement: Attachment<HTMLDivElement> = (element) => {
    contentElement = element
    return () => {
      if (contentElement === element) contentElement = undefined
    }
  }

  const attachConsoleElement: Attachment<HTMLDivElement> = (element) => {
    consoleElement = element
    return () => {
      if (consoleElement === element) consoleElement = undefined
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
    const surface = untrack(() => activeSurface)
    if (!visible || surface !== 'page') return
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
    contextSidebarState.updateBrowserTab(tabId, next.url || untrack(() => (tab as BrowserContextTab | null)?.url ?? tabInitialUrl), next.title)
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
    if (activeSurface === 'console') {
      requestAnimationFrame(() => {
        const element = consoleElement
        if (element) element.scrollTo({ top: element.scrollHeight })
      })
    }
  }

  async function selectSurface(surface: BrowserContextTab['surface']): Promise<void> {
    if (activeSurface === surface) return
    contextSidebarState.updateBrowserSurface(tabId, surface)
    if (surface === 'console') {
      try {
        await invoke('browser:hide', tabId)
      } catch {
        // Tab already destroyed.
      }
      return
    }
    await tick()
    await showAtCurrentBounds()
  }

  function levelClass(level: BrowserConsoleLevel): string {
    if (level === 'error') return 'border-danger/20 bg-danger/10 text-danger'
    if (level === 'warning') return 'border-warning/20 bg-warning/10 text-warning'
    if (level === 'debug') return 'border-border text-dimmed'
    return 'border-border text-foreground'
  }

  function sourceLabel(entry: BrowserConsoleEntry): string {
    if (!entry.sourceId) return ''
    try {
      const source = new URL(entry.sourceId)
      const path = `${source.pathname}${source.search}`
      return `${source.host}${path === '/' ? '' : path}${entry.lineNumber ? `:${entry.lineNumber}` : ''}`
    } catch {
      return `${entry.sourceId}${entry.lineNumber ? `:${entry.lineNumber}` : ''}`
    }
  }

  function timeLabel(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
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
    <button
      type="button"
      class={[
        'relative flex h-7 shrink-0 items-center justify-center rounded-md transition-colors',
        fullscreen ? 'gap-1.5 px-2 text-[0.6875rem] font-medium' : 'w-7',
        activeSurface === 'console'
          ? 'bg-elevated text-foreground'
          : 'text-dimmed hover:bg-elevated hover:text-foreground'
      ]}
      aria-label={consoleToggleLabel}
      aria-pressed={activeSurface === 'console'}
      title={consoleToggleLabel}
      onclick={() => void selectSurface(activeSurface === 'console' ? 'page' : 'console')}
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
  {/if}
  <div
    {@attach attachContentElement}
    data-native-browser-content
    class={['min-h-0 flex-1 bg-surface', activeSurface !== 'page' && 'hidden']}
    role="document"
    aria-label={`Browser content for ${pageState.title || address}`}
  ></div>
  <div
    {@attach attachConsoleElement}
    class={[
      'min-h-0 flex-1 overflow-auto bg-app font-mono text-[0.6875rem]',
      activeSurface !== 'console' && 'hidden'
    ]}
    role="region"
    aria-label="Browser console"
  >
    {#each consoleEntries as entry (entry.id)}
      <div
        class={['grid grid-cols-[auto_1fr] gap-x-2 border-b px-3 py-2', levelClass(entry.level)]}
      >
        <span class="select-none tabular-nums opacity-60">{timeLabel(entry.timestamp)}</span>
        <div class="min-w-0">
          <p class="whitespace-pre-wrap break-words">{entry.message}</p>
          {#if sourceLabel(entry)}
            <p class="mt-0.5 truncate text-[0.625rem] opacity-55" title={sourceLabel(entry)}>
              {sourceLabel(entry)}
            </p>
          {/if}
        </div>
      </div>
    {:else}
      <div
        class="flex h-full min-h-32 flex-col items-center justify-center gap-2 px-6 text-center text-dimmed"
      >
        <SquareTerminal size={18} strokeWidth={1.5} />
        <p class="font-sans text-xs">No messages from this browser tab.</p>
      </div>
    {/each}
  </div>
</div>
