<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import {
    ArrowLeft,
    ArrowRight,
    Download,
    LoaderCircle,
    Lock,
    LockOpen,
    RotateCw,
    SquareDashedMousePointer,
    SquareTerminal,
    X
  } from '@lucide/svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { normalizeBrowserUrl } from '$shared/local-development-url'
  import BrowserCompositionTransport from './BrowserCompositionTransport.svelte'
  import BrowserCommentEditor from './BrowserCommentEditor.svelte'
  import { browserDownloads } from '$lib/stores/browser-downloads.svelte'
  import { browserVisibility, type BrowserSurface } from '$lib/stores/browser-visibility.svelte'
  import { browserAddressFocus } from '$lib/stores/browser-address-focus'
  import { browserKeyboardFocus } from '$lib/stores/browser-keyboard-focus'
  import { browserInspector } from '$lib/stores/browser-inspector.svelte'
  import { contextSidebarState, type BrowserContextTab } from '$lib/stores/context-sidebar.svelte'
  import { responseReferencesState } from '$lib/stores/response-references.svelte'
  import type {
    BrowserDevToolsState,
    BrowserPageState,
    BrowserPanelShortcutAction,
    BrowserViewBounds
  } from '$shared/ipc-contract'

  /**
   * The sidebar's own region, which the browser panel shares with the strip that
   * selects it. Read from the DOM contract every surface already agrees on, so
   * the panel never has to be handed the sidebar by its parent.
   *
   * The bottom dock carries the same marker with a different placement, and a
   * terminal docked there owns its own keys (on Windows and Linux Ctrl+W is the
   * shell's delete-word binding), so the dock is excluded rather than claimed.
   */
  const SIDEBAR_REGION_SELECTOR = '[data-region="context-sidebar"]:not([data-placement="bottom"])'

  interface Props {
    tab: BrowserContextTab
    fullscreen?: boolean
  }

  let { tab, fullscreen = false }: Props = $props()

  /** The surface this instance renders on. A fullscreen instance outranks every
   *  sidebar instance, so the store resolves which one owns the single native
   *  view and no suppression prop has to be threaded in from the parent. */
  // svelte-ignore state_referenced_locally
  const surface: BrowserSurface = fullscreen ? 'fullscreen' : 'sidebar'

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
      // A blank tab has no address yet and loads nothing, so it does not start
      // in the loading state; every real address does until main reports back.
      loading: tabInitialUrl !== '',
      canGoBack: false,
      canGoForward: false,
      audible: false,
      muted: false,
      capturing: false,
      design: null,
      composition: null
    }
  }

  let contentElement = $state<HTMLDivElement>()
  let addressInput = $state<HTMLInputElement>()
  let address = $state(initialPageState().url)
  let addressError = $state('')
  let pageState = $state<BrowserPageState>(initialPageState())
  /** The panel's current on-screen content rectangle, refreshed by the same
   *  observers that align the native view. */
  let contentRect = $state<BrowserViewBounds | null>(null)
  /** Whether the browser's native view may be on screen for this tab right now.
   *  The store owns the entire decision   published blocks (a full-window DOM
   *  surface, an inactive workspace, the thread switcher), which surface owns
   *  the single native view, and whether a floating DOM overlay covers this
   *  frame   so this panel never has to combine them itself. */
  let panelVisible = $derived(browserVisibility.isVisible(tabId, contentRect))
  let devToolsOpen = $state(false)
  /**
   * Whether element inspection is armed on this tab.
   *
   * Read from the shared session, not owned here: the mode belongs to the tab,
   * so the sidebar and the full screen surface show and keep the same state, and
   * moving between them neither drops the mode nor disarms the page.
   */
  let inspectArmed = $derived(browserInspector.isArmed(tabId))
  /** The comment currently open for editing on this tab, in composer order. */
  let editingComment = $derived.by(() => {
    const referenceId = browserInspector.editingId(tabId)
    if (!referenceId) return null
    const references = responseReferencesState.forThread(tabProjectId, tabThreadId)
    const index = references.findIndex((reference) => reference.id === referenceId)
    const reference = index < 0 ? null : references[index]
    return reference ? { reference, number: index + 1 } : null
  })
  /** Show a closed padlock for https origins; open padlock for everything else. */
  let secure = $derived(pageState.url.startsWith('https:'))
  /** The site menu is a native OS popup composited above the page view, so
   *  the view never has to detach for it; the open flag only tracks the
   *  expanded state of the anchor button. The downloads and page menus follow
   *  the same native-popup pattern. */
  let siteMenuOpen = $state(false)
  const activeDownloadCount = $derived(browserDownloads.activeCount(tabProjectId))

  /** Open the native downloads menu anchored under the download button. The
   *  OS popup composites above the page view, so the panel's layout never has
   *  to move for it (the previous in-flow list pushed the page down). */
  function openDownloadsMenu(event: MouseEvent): void {
    const button = event.currentTarget
    if (!(button instanceof HTMLElement)) return
    const rect = button.getBoundingClientRect()
    void invoke(
      'browser:downloadsMenu',
      tabProjectId,
      Math.max(0, Math.round(rect.left)),
      Math.max(0, Math.round(rect.bottom + 4))
    ).catch(() => {})
  }

  /** Left click reloads, or aborts the in-flight navigation while loading. */
  function onReloadButton(): void {
    void invoke(pageState.loading ? 'browser:stop' : 'browser:reload', tabId).catch(() => {})
  }

  /** Right click offers the soft/hard reload choice the page area also offers. */
  function onReloadContextMenu(event: MouseEvent): void {
    event.preventDefault()
    const button = event.currentTarget
    if (!(button instanceof HTMLElement)) return
    const rect = button.getBoundingClientRect()
    void invoke(
      'browser:pageMenu',
      tabId,
      Math.max(0, Math.round(rect.left)),
      Math.max(0, Math.round(rect.bottom + 4))
    ).catch(() => {})
  }

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

  /**
   * Move focus to the address bar and select what is there, which is what
   * Cmd/Ctrl+L does in a browser. Main asks for it because the chord is claimed
   * in the main process, where a page-focused key is visible before the
   * application menu acts on it.
   */
  function focusAddress(): void {
    addressInput?.focus()
    addressInput?.select()
  }

  /**
   * Take the keyboard for the address bar of a tab the user just opened.
   *
   * The request is made where the tab is created, and it is honored here the
   * moment this panel owns the visible view: a panel that is mounted but not on
   * screen (the sidebar while the full screen browser is up) leaves the request
   * alone, because taking focus behind another surface is exactly what it must
   * not do, and the request is still waiting when the user sees the tab.
   */
  $effect(() => {
    if (!panelVisible) return
    if (!browserAddressFocus.take(tabId)) return
    focusAddress()
  })

  /**
   * Tell the keyboard owner whether the focus that just moved belongs to this
   * browser.
   *
   * The claim follows the *sidebar*, not just this panel: the strip that
   * selects this tab is the sidebar's own chrome, so a key pressed while that
   * button holds focus still belongs to the browser being shown. Anything that
   * takes focus outside the sidebar hands the keyboard back to the app.
   */
  function onSidebarFocusIn(event: FocusEvent): void {
    if (!panelVisible) return
    const target = event.target
    if (!(target instanceof Element) || !target.closest(SIDEBAR_REGION_SELECTOR)) return
    browserKeyboardFocus.setClaim('sidebar', tabId)
  }

  function onSidebarFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget
    if (next instanceof Element && next.closest(SIDEBAR_REGION_SELECTOR)) return
    browserKeyboardFocus.setClaim('sidebar', null)
  }

  /**
   * The focus a keyboard-driven shortcut lands on. Only the instance that owns
   * the native view may take it: a full screen and a sidebar panel can both be
   * mounted for one tab, and the hidden one has no visible address bar.
   */
  function onPanelShortcut(eventTabId: string, action: BrowserPanelShortcutAction): void {
    if (eventTabId !== tabId || action !== 'focus-address') return
    if (!panelVisible) return
    focusAddress()
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
    const bounds = contentBounds()
    // Publish the frame before the visibility check: the store needs the current
    // rectangle even while the native view is detached, so the panel notices as
    // soon as an overlay stops covering it.
    contentRect = bounds
    // Ask the store directly instead of reading the template's `panelVisible`
    // derived: this also runs from ResizeObserver/rAF continuations, after the
    // effect that owns a component derived may have been torn down.
    if (!browserVisibility.isVisible(tabId, bounds)) return
    if (!bounds) return
    try {
      const currentUrl = untrack(() => (tab as BrowserContextTab | null)?.url ?? tabInitialUrl)
      pageState = await invoke('browser:show', tabId, tabProjectId, tabThreadId, currentUrl, bounds)
      // The store's answer can change while that call is in flight: another
      // surface may claim the view, an overlay may appear, or the sidebar may
      // move on. Only one native view can exist at a time, so a stale attach
      // would leave the wrong tab on screen on top of the surface that now owns
      // it. Re-asking the store keeps the decision authoritative at the moment
      // the attach lands. A redundant hide is a no-op in the main process when
      // this tab is not the one attached.
      if (!browserVisibility.isVisible(tabId, contentBounds())) {
        void invoke('browser:hide', tabId).catch(() => {})
      }
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
    // Also routes the audio and capture state into the tab strip, so the tab's
    // indicator is correct even for the first report of a tab main kept alive
    // across a renderer reload.
    contextSidebarState.applyBrowserPageState(next)
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

  /** Arm or disarm element inspection for this tab, through the shared session. */
  function toggleInspect(): void {
    if (!inspectArmed && !pageState.design) return
    browserInspector.toggle(tabId)
  }

  /** Save the comment on the element being edited, and close its editor. */
  function saveComment(referenceId: string, comment: string): void {
    responseReferencesState.updateComment(tabProjectId, tabThreadId, referenceId, comment)
    browserInspector.closeComment(tabId)
  }

  function persistCommentDraft(referenceId: string, comment: string): void {
    responseReferencesState.updateCommentDraft(tabProjectId, tabThreadId, referenceId, comment)
  }

  /** Remove a picked element from the chat, pins and all. */
  function removeComment(referenceId: string): void {
    responseReferencesState.setForThread(
      tabProjectId,
      tabThreadId,
      responseReferencesState
        .forThread(tabProjectId, tabThreadId)
        .filter((reference) => reference.id !== referenceId)
    )
    browserInspector.closeComment(tabId)
  }

  // Publish the pin set whenever the reference list changes, so a pick, a
  // finished comment, or a removal made from the composer moves the pins on the
  // page. The store notifies on every write rather than an effect watching it:
  // the pins are elements drawn by an injected script, not a render of state, so
  // the write has to be told to happen, not derived.
  onMount(() => {
    // Claim the native view for this tab while this panel is mounted. The claim
    // is released with the component, so a destroyed panel can never keep the view.
    const releaseBrowserClaim = browserVisibility.claimTab(tabId, surface)
    const unsubscribeSiteMenu = subscribe('browser:siteMenuClosed', () => {
      siteMenuOpen = false
    })
    let destroyed = false
    const unsubscribeState = subscribe('browser:state', applyPageState)
    const unsubscribeDevTools = subscribe('browser:devToolsChanged', applyDevToolsState)
    const unsubscribePanelShortcut = subscribe('browser:panelShortcut', onPanelShortcut)
    // Only the sidebar report is focus-driven: a single panel decides it for the
    // whole sidebar, so one listener is enough. The full screen overlay claims
    // the keyboard for as long as it is mounted instead (WorkspaceFullscreenBrowser).
    if (surface === 'sidebar') {
      document.addEventListener('focusin', onSidebarFocusIn)
      document.addEventListener('focusout', onSidebarFocusOut)
    }
    const observer = new ResizeObserver(() => {
      if (!destroyed) void showAtCurrentBounds().catch(() => {})
    })
    if (contentElement) observer.observe(contentElement)
    const onWindowResize = (): void => {
      if (!destroyed) void showAtCurrentBounds().catch(() => {})
    }
    window.addEventListener('resize', onWindowResize)

    // The sidebar enters with a short transform, so its rectangle keeps moving
    // for the length of that transition and the native content has to follow it
    // until it settles. The full screen panel has no such transform: it is fixed
    // to the window and its frame is already final by the first layout, so the
    // attachment's `tick` and the observer below own every change it can have.
    // Running the loop there was a `browser:show` per animation frame for a
    // rectangle that never moved, which is the switch cost the entry animation
    // was paying for on a surface that never animates.
    let animationFrame = 0
    if (surface === 'sidebar') {
      const startedAt = performance.now()
      const followTransition = (now: number): void => {
        if (destroyed) return
        void showAtCurrentBounds().catch(() => {})
        if (now - startedAt < 260) animationFrame = requestAnimationFrame(followTransition)
      }
      animationFrame = requestAnimationFrame(followTransition)
    }
    return () => {
      destroyed = true
      cancelAnimationFrame(animationFrame)
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
      releaseBrowserClaim()
      unsubscribeSiteMenu()
      unsubscribeState()
      unsubscribeDevTools()
      unsubscribePanelShortcut()
      // The inspection session outlives this panel on purpose: the mode, the
      // pins and the open comment belong to the tab, and the other surface (the
      // full screen dialog, or the sidebar it is returning to) keeps them. Only
      // the user, the page, or the tab leaving its design ends the session.
      if (surface === 'sidebar') {
        document.removeEventListener('focusin', onSidebarFocusIn)
        document.removeEventListener('focusout', onSidebarFocusOut)
        browserKeyboardFocus.setClaim('sidebar', null)
      }
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
      onclick={onReloadButton}
      oncontextmenu={onReloadContextMenu}
    >
      {#if pageState.loading}
        <X size={14} />
      {:else}
        <RotateCw size={13} />
      {/if}
    </button>
    <div class="relative min-w-0 flex-1">
      <span class="sr-only">Browser address</span>
      {#if pageState.url !== ''}
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
      {/if}
      <input
        class="h-7 w-full rounded-lg border border-border bg-elevated pl-8 pr-8 text-xs text-foreground outline-none transition-colors placeholder:text-dimmed focus:border-primary"
        class:border-danger={addressError !== ''}
        bind:this={addressInput}
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
      class="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      aria-label="Browser downloads"
      title="Browser downloads"
      onclick={openDownloadsMenu}
    >
      <Download size={13} />
      {#if activeDownloadCount > 0}
        <span
          class="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 text-[0.5625rem] font-semibold tabular-nums text-on-accent"
        >
          {activeDownloadCount}
        </span>
      {/if}
    </button>
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
    {#if pageState.design}
      <button
        type="button"
        class={[
          'relative flex h-7 shrink-0 items-center justify-center rounded-md transition-colors',
          fullscreen ? 'gap-1.5 px-2 text-[0.6875rem] font-medium' : 'w-7',
          inspectArmed
            ? 'bg-accent/15 text-accent'
            : 'text-dimmed hover:bg-elevated hover:text-foreground'
        ]}
        aria-label={inspectArmed ? 'Stop inspecting elements' : 'Pick an element to comment on'}
        aria-pressed={inspectArmed}
        title={inspectArmed
          ? 'Stop inspecting: hover an element and click to comment, Escape to exit'
          : 'Pick an element in this design to comment on'}
        onclick={toggleInspect}
      >
        <SquareDashedMousePointer size={13} />
        {#if fullscreen}
          <span>Inspect</span>
        {/if}
      </button>
    {/if}
  </form>
  {#if pageState.composition}
    <BrowserCompositionTransport
      {tabId}
      composition={pageState.composition}
      active={panelVisible}
    />
  {/if}
  {#if inspectArmed}
    <p
      class="shrink-0 border-b border-accent/20 bg-accent/10 px-3 py-1 text-[0.6875rem] text-foreground"
      role="status"
    >
      Hover an element and click to comment on it. Escape exits.
    </p>
  {/if}
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
    oncontextmenu={(event) => {
      // The page itself never sees DOM context menus (it is a native view),
      // so the host offers the browser-level menu: soft and hard reload.
      event.preventDefault()
      void invoke(
        'browser:pageMenu',
        tabId,
        Math.max(0, Math.round(event.clientX)),
        Math.max(0, Math.round(event.clientY))
      ).catch(() => {})
    }}
  ></div>
  {#if panelVisible && editingComment}
    <BrowserCommentEditor
      reference={editingComment.reference}
      number={editingComment.number}
      projectId={tabProjectId}
      threadId={tabThreadId}
      onDraftChange={(comment) => persistCommentDraft(editingComment.reference.id, comment)}
      onDone={(comment) => saveComment(editingComment.reference.id, comment)}
      onRemove={() => removeComment(editingComment.reference.id)}
      onClose={() => browserInspector.closeComment(tabId)}
    />
  {/if}
</div>
