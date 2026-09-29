<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import {
    ArrowLeft,
    ArrowRight,
    Download,
    RotateCw,
    SquareDashedMousePointer,
    SquareTerminal,
    X
  } from '@lucide/svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import BrowserAddressBar from './BrowserAddressBar.svelte'
  import BrowserCompositionTransport from './BrowserCompositionTransport.svelte'
  import BrowserCommentEditor from './BrowserCommentEditor.svelte'
  import BrowserFindBar from './BrowserFindBar.svelte'
  import BrowserLoadErrorView from './BrowserLoadErrorView.svelte'
  import { browserDownloads } from '$lib/stores/browser-downloads.svelte'
  import { browserFindState } from '$lib/stores/browser-find.svelte'
  import { browserVisibility, type BrowserSurface } from '$lib/stores/browser-visibility.svelte'
  import { browserAddressFocus } from '$lib/stores/browser-address-focus'
  import { browserKeyboardFocus } from '$lib/stores/browser-keyboard-focus'
  import { browserInspector } from '$lib/stores/browser-inspector.svelte'
  import {
    browserSiteHost,
    openBrowserDownloadsMenu,
    openBrowserPageMenu,
    openBrowserPageMenuAt,
    openBrowserSiteMenu
  } from './browser-chrome-menus'
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

  /** This page's entry in the store's list of native rectangles on screen. Keyed
   *  by surface as well as tab: the full screen dialog and a sidebar panel can
   *  both be mounted for one tab, and only the one allowed to show it publishes. */
  const nativeFrameKey = `native-${surface}-${tabId}`

  function initialPageState(): BrowserPageState {
    return {
      tabId,
      projectId: tabProjectId,
      threadId: tabThreadId,
      url: tabInitialUrl,
      title: tabInitialTitle,
      favicon: null,
      // A blank tab has no address yet and loads nothing, so it does not start
      // in the loading state; every real address does until main reports back.
      loading: tabInitialUrl !== '',
      loadError: null,
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
  let address = $state(initialPageState().url)
  /** The address bar, which is the field the user types an address in. It is
   *  taken imperatively because taking the keyboard for a tab the user just
   *  opened is a gesture, not a state this panel holds. */
  let addressBar = $state<BrowserAddressBar | undefined>(undefined)
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
  /** How many of this tab's project's downloads are unfinished: still running, or
   *  stopped with bytes on disk waiting for a resume. */
  const unfinishedDownloadCount = $derived(browserDownloads.unfinishedCount(tabProjectId))
  /** Whether this tab's find bar is up. The bar itself is one row of this column,
   *  and the store is its authority because the global Browser view shows a tab's
   *  page too. */
  const findOpen = $derived(browserFindState.stateFor(tabId).open)

  /** Open the native downloads menu anchored under the download button. The
   *  OS popup composites above the page view, so the panel's layout never has
   *  to move for it (the previous in-flow list pushed the page down). */
  function openDownloadsMenu(event: MouseEvent): void {
    const button = event.currentTarget
    if (!(button instanceof HTMLElement)) return
    openBrowserDownloadsMenu(tabProjectId, button)
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
    openBrowserPageMenu(tabId, button)
  }

  let siteHost = $derived(browserSiteHost(pageState.url))

  /** Open the native site-settings menu anchored at the lock button. The main
   *  process builds an OS context menu (with native destructive-action
   *  confirmation dialogs) that composites above the page view, so the view
   *  never detaches for this interaction. */
  function openSiteMenu(event: MouseEvent): void {
    const button = event.currentTarget
    if (!(button instanceof HTMLElement)) return
    siteMenuOpen = true
    void openBrowserSiteMenu(tabProjectId, siteHost, button).then((opened) => {
      if (!opened) siteMenuOpen = false
    })
  }

  /**
   * Take the keyboard for the address bar of the tab the user just opened, with
   * the address on screen selected, which is the new tab's gesture: nothing loads
   * until an address is typed, so the field is where the user is about to be.
   *
   * The request is made where the tab is created, and it is honored here the
   * moment this panel owns the visible view AND has an address bar to give it to:
   * a panel that is mounted but not on screen (the sidebar while the full screen
   * browser is up) leaves the request alone, because taking focus behind another
   * surface is exactly what it must not do, and the request is still waiting when
   * the user sees the tab.
   */
  $effect(() => {
    const bar = addressBar
    if (!bar) return
    if (!panelVisible) return
    if (!browserAddressFocus.take(tabId)) return
    bar.focusAndSelect()
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
   *
   * Find is the same shape of answer   the bar is this column's own row, so the
   * request is honoured by the instance that is on screen and the other one leaves
   * it alone   and its state is the shared one, so the surface that does answer
   * opens the bar the user last left.
   */
  function onPanelShortcut(eventTabId: string, action: BrowserPanelShortcutAction): void {
    if (eventTabId !== tabId) return
    if (!panelVisible) return
    if (action === 'focus-address') {
      addressBar?.focusAndSelect()
      return
    }
    if (action === 'find') {
      browserFindState.open(tabId)
      return
    }
    if (action === 'find-next') {
      browserFindState.step(tabId, 'next')
      return
    }
    if (action === 'find-previous') browserFindState.step(tabId, 'previous')
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

  /**
   * Report this page's rectangle while it is really on screen, which is what lets
   * the toaster's corner check see that a page covers it. A panel the store is not
   * showing publishes nothing, so the two instances of one tab can never both
   * claim the same screen space.
   */
  $effect(() => {
    const frame = panelVisible && !pageState.loadError ? contentRect : null
    if (!frame) {
      browserVisibility.clearNativeFrame(nativeFrameKey)
      return
    }
    browserVisibility.publishNativeFrame(nativeFrameKey, frame)
    return () => browserVisibility.clearNativeFrame(nativeFrameKey)
  })

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
    // A tab showing the error card has no page to place. The attachment is not
    // applied on that edge, but the resize observer and the sidebar's entry
    // animation keep calling here, so this guard is what stops them putting the
    // empty native view back over the card.
    if (pageState.loadError) return
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

  /** Open a resolved address in this tab. */
  function navigate(url: string): void {
    address = url
    contextSidebarState.updateBrowserTab(tabId, url)
    void invoke('browser:navigate', tabId, tabProjectId, tabThreadId, url).catch(() => {})
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
    // Downloads outlive the run that started them, so the project's records are
    // read back when the panel appears: the badge and the menu are how a download
    // the app stopped on its way out becomes visible again rather than silent.
    void browserDownloads.load(tabProjectId)
    const unsubscribeSiteMenu = subscribe('browser:siteMenuClosed', () => {
      siteMenuOpen = false
    })
    let destroyed = false
    const unsubscribeState = subscribe('browser:state', applyPageState)
    const unsubscribeDevTools = subscribe('browser:devToolsChanged', applyDevToolsState)
    const unsubscribePanelShortcut = subscribe('browser:panelShortcut', onPanelShortcut)
    // Only the sidebar report is focus-driven: a single panel decides it for the
    // whole sidebar, so one listener is enough. The full screen overlay claims
    // the keyboard for as long as it is mounted instead
    // (WorkspaceFullscreenBrowser), and the Browser view claims it while its page
    // is the surface on screen (BrowserWorkspace), so a press anywhere in those
    // views is the browser's.
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
      // The bar is gone with this column, so its search ends with it: the page is
      // parked rather than destroyed, and a highlight left on it would still be
      // painted when the user comes back.
      browserFindState.forget(tabId)
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

<div
  {@attach panelVisible && !pageState.loadError && manageNativeBrowserView}
  class="flex h-full min-h-0 flex-col bg-app"
>
  <div class="flex h-10 shrink-0 items-center gap-1.5 border-b border-border bg-surface px-2">
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
    <!-- Reload is shown only when there is a page to act on: an empty tab has
         nothing to reload, and the button becomes the stop affordance while a
         load is in flight. -->
    {#if pageState.loading || pageState.url !== ''}
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
    {/if}
    <BrowserAddressBar
      bind:this={addressBar}
      url={pageState.url}
      projectId={tabProjectId}
      threadId={tabThreadId}
      {secure}
      loading={pageState.loading}
      {siteMenuOpen}
      onOpenSiteMenu={openSiteMenu}
      onNavigate={navigate}
    />
    <button
      type="button"
      class="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      aria-label="Browser downloads"
      title="Browser downloads"
      onclick={openDownloadsMenu}
    >
      <Download size={13} />
      {#if unfinishedDownloadCount > 0}
        <span
          class="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 text-[0.5625rem] font-semibold tabular-nums text-on-accent"
        >
          {unfinishedDownloadCount}
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
  </div>
  {#if findOpen && panelVisible}
    <!-- The bar is a row of this column rather than an overlay: the page is a
         native view composited above the DOM, so a row above it shrinks the
         content rect and the observers place the page under the bar.

         Gated on `panelVisible` as well as on the shared open state, because a
         full screen and a sidebar panel can both be mounted for one tab: the
         state is one, so both would draw the bar and the one behind the other
         surface would take the keyboard for a field nobody can see. -->
    <div class="flex shrink-0 justify-center px-2 py-1.5">
      <div class="w-full max-w-xl">
        <BrowserFindBar {tabId} />
      </div>
    </div>
  {/if}
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
  <div
    {@attach attachContentElement}
    data-native-browser-content
    class="min-h-0 min-w-0 flex-1 bg-surface"
    role={pageState.loadError ? undefined : 'document'}
    aria-label={pageState.loadError
      ? undefined
      : `Browser content for ${pageState.title || address}`}
    oncontextmenu={(event) => {
      // The page itself renders in a native view above this host, so a click it
      // does not take (the load-error card, a blank frame) lands here. Main
      // builds the same page-level menu the page's own right-click does.
      event.preventDefault()
      openBrowserPageMenuAt(tabId, event.clientX, event.clientY)
    }}
  >
    {#if pageState.loadError}
      <BrowserLoadErrorView
        error={pageState.loadError}
        url={pageState.url}
        loading={pageState.loading}
        canGoBack={pageState.canGoBack}
        onRetry={() => void invoke('browser:reload', tabId).catch(() => {})}
        onGoBack={() => void invoke('browser:goBack', tabId).catch(() => {})}
      />
    {/if}
  </div>
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
