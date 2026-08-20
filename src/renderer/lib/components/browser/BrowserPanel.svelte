<script lang="ts">
  import { onMount, tick } from 'svelte'
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
  }

  let { tab, fullscreen = false }: Props = $props()

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
  let activeSurface = $derived(tab.surface)
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
    if (activeSurface !== 'page') return
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

  function mergeConsoleEntries(entries: BrowserConsoleEntry[]): void {
    const merged = [...consoleEntries]
    for (const entry of entries) {
      if (entry.tabId !== tab.id) continue
      const index = merged.findIndex((candidate) => candidate.id === entry.id)
      if (index >= 0) merged[index] = entry
      else merged.push(entry)
    }
    consoleEntries = merged.sort((left, right) => left.timestamp - right.timestamp).slice(-500)
  }

  function applyConsoleEntry(entry: BrowserConsoleEntry): void {
    if (entry.tabId !== tab.id) return
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
    contextSidebarState.updateBrowserSurface(tab.id, surface)
    if (surface === 'console') {
      await invoke('browser:hide', tab.id)
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
    const unsubscribeState = subscribe('browser:state', applyPageState)
    const unsubscribeConsole = subscribe('browser:console', applyConsoleEntry)
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
    void showAtCurrentBounds().then(async () => {
      mergeConsoleEntries(await invoke('browser:getConsole', tab.id))
    })

    return () => {
      cancelAnimationFrame(animationFrame)
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
      unsubscribeState()
      unsubscribeConsole()
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
    <button
      type="button"
      class={[
        'relative flex h-7 shrink-0 items-center justify-center rounded-md transition-colors',
        fullscreen ? 'gap-1.5 px-2 text-[11px] font-medium' : 'w-7',
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
          <span class="rounded-full bg-danger/15 px-1.5 text-[9px] font-semibold text-danger">
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
      class="shrink-0 border-b border-danger/20 bg-danger/10 px-3 py-1 text-[11px] text-danger"
      role="alert"
    >
      {addressError}
    </p>
  {/if}
  <div
    {@attach attachContentElement}
    class={['min-h-0 flex-1 bg-surface', activeSurface !== 'page' && 'hidden']}
    role="document"
    aria-label={`Browser content for ${pageState.title || address}`}
  ></div>
  <div
    {@attach attachConsoleElement}
    class={[
      'min-h-0 flex-1 overflow-auto bg-app font-mono text-[11px]',
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
            <p class="mt-0.5 truncate text-[10px] opacity-55" title={sourceLabel(entry)}>
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
