<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import type { BrowserPanelShortcutAction, BrowserViewBounds } from '$shared/ipc-contract'
  import { GLOBAL_BROWSER_CONTEXT, globalBrowser } from '$lib/stores/global-browser.svelte'
  import type { GlobalBrowserTab } from '$lib/stores/global-browser-types'
  import { browserFindState } from '$lib/stores/browser-find.svelte'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import { browserKeyboardFocus } from '$lib/stores/browser-keyboard-focus'
  import BrowserFindBar from './BrowserFindBar.svelte'
  import BrowserLoadErrorView from './BrowserLoadErrorView.svelte'
  import { openBrowserPageMenuAt } from './browser-chrome-menus'

  interface Props {
    tab: GlobalBrowserTab
  }

  let { tab }: Props = $props()

  /**
   * The page frame.
   *
   * The browser's chrome lives in the left sidebar, so this surface is only the
   * rectangle the page occupies. The page itself is an Electron
   * `WebContentsView` owned by the main process and composited above every DOM
   * node, so this component never renders it: it measures the frame, claims the
   * single native view for this tab through `browserVisibility`, and tells main
   * where to put it. It is keyed by tab id, so switching tabs tears one instance
   * down and builds the next, which is the whole tab-switch protocol.
   */

  // Stable identity: the prop object is replaced by the store, so every async
  // callback and teardown reads this snapshot rather than the live prop.
  // svelte-ignore state_referenced_locally
  const tabId = tab.id

  /** This page's entry in the store's list of native rectangles on screen. */
  const nativeFrameKey = `native-workspace-${tabId}`

  let contentElement = $state<HTMLDivElement>()
  /** This frame's current on-screen rectangle, refreshed by the same observers
   *  that align the native view. It is state, not a plain local, because the
   *  visibility decision below has to re-read it: the store needs the current
   *  rectangle even while the page is detached, so this surface notices as soon
   *  as an overlay stops covering it. */
  let contentRect = $state<BrowserViewBounds | null>(null)

  /** Whether the native page may be on screen for this tab right now. The store
   *  owns the entire decision   published blocks (a full-window DOM surface, the
   *  hidden workspace shell, a modal), which surface owns the single native view,
   *  and whether a floating overlay covers this frame   so this surface never
   *  combines them itself. */
  let pageVisible = $derived(browserVisibility.isVisible(tabId, contentRect))

  /** Live state of this tab: the loading flag and progress and the failure that
   *  left it with nothing to show. */
  const runtime = $derived(globalBrowser.runtimeFor(tabId))
  /** The failure that replaced this tab's page, or null while it has one. The
   *  native view is detached while it is set, so the error card is what the user
   *  sees where the page would be. */
  const loadError = $derived(runtime.loadError)
  /** Whether this tab's find bar is up. It is a row of this frame, and the store
   *  is its authority because the sidebar panel shows a tab's page too. */
  const findOpen = $derived(browserFindState.stateFor(tabId).open)

  /**
   * Carry out a browser shortcut that belongs to this frame's tab.
   *
   * Main decides the key (the page is a native view, so a key pressed in it never
   * reaches this renderer) and this surface answers it, because it is the one
   * showing the page and therefore the one holding the find bar. The address bar
   * and the tab strip are the sidebar's, so those actions are not answered here.
   */
  function onPanelShortcut(eventTabId: string, action: BrowserPanelShortcutAction): void {
    if (eventTabId !== tabId) return
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

  /**
   * Place the native page over the current frame, or detach it when the
   * visibility store says another surface owns the view right now.
   *
   * Every input is re-read here rather than once at mount: the page can be
   * re-shown after an overlay closes, and a stale placement would leave the page
   * floating over the wrong rectangle.
   */
  async function showAtCurrentBounds(): Promise<void> {
    const bounds = contentBounds()
    // Publish the frame before the visibility check, so the derived above sees
    // the rectangle the store has to test an overlay against.
    contentRect = bounds
    if (!bounds) return
    // A tab showing the error card has no page to place. The attachment is not
    // applied on this edge, but the resize observer and the window listener are
    // live the whole time, so this guard is what keeps them from putting the
    // empty native view back over the card.
    if (loadError) return
    // Ask the store directly instead of reading the template's `pageVisible`
    // derived: this also runs from ResizeObserver and attachment continuations.
    if (!browserVisibility.isVisible(tabId, bounds)) return
    try {
      await invoke(
        'browser:show',
        tabId,
        GLOBAL_BROWSER_CONTEXT.projectId,
        GLOBAL_BROWSER_CONTEXT.threadId,
        tab.url,
        bounds,
        // The tab's jar, so main builds (or reattaches) this page in the box it
        // was created in rather than the context's default partition.
        tab.boxId
      )
      // The store's answer can change while that call is in flight: another
      // surface may claim the view, or an overlay may appear. Only one native
      // view can exist at a time, so a stale attach would leave the page on
      // screen on top of the surface that now owns it.
      if (!browserVisibility.isVisible(tabId, contentBounds())) {
        void invoke('browser:hide', tabId).catch(() => {})
      }
    } catch {
      // The tab can be destroyed between the visibility check and the call.
    }
  }

  const attachContentElement: Attachment<HTMLDivElement> = (element) => {
    contentElement = element
    return () => {
      if (contentElement === element) contentElement = undefined
    }
  }

  /**
   * Attach the page while this frame is the one allowed to show it, and detach
   * it the moment that stops being true.
   *
   * Applied conditionally (`pageVisible && manageNativeView`) on purpose: a
   * block published by a modal, or by the workspace shell going hidden, has to
   * both detach the page now and re-attach it when it clears, and only a
   * conditional attachment re-runs on that edge. The observers in `onMount`
   * only ever follow movement while the page is already up.
   */
  const manageNativeView: Attachment<HTMLDivElement> = () => {
    void tick().then(() => showAtCurrentBounds().catch(() => {}))
    return () => {
      void invoke('browser:hide', tabId).catch(() => {})
    }
  }

  /**
   * Report this page's rectangle while it is really on screen.
   *
   * The visibility store owns the opposite question ("may this page be shown"),
   * which is what hides it; this is the answer anything that has to ask whether a
   * page covers it needs, and the toaster's corner check is the only reader
   * today. A page behind a modal, or one parked for any other reason, publishes
   * nothing, so the stack is never handed to the overlay for a view nobody can
   * see.
   */
  $effect(() => {
    const frame = pageVisible && !loadError ? contentRect : null
    if (!frame) {
      browserVisibility.clearNativeFrame(nativeFrameKey)
      return
    }
    browserVisibility.publishNativeFrame(nativeFrameKey, frame)
    return () => browserVisibility.clearNativeFrame(nativeFrameKey)
  })

  /**
   * The browser owns the keyboard for as long as its page is the surface on
   * screen.
   *
   * Focus is deliberately not part of this. The Browser view *is* the browser, so
   * Cmd/Ctrl+L belongs to it wherever the keyboard sits inside the view: in the
   * page, in the tab strip, in the rail, or in the app header and the nav sidebar
   * the view shares with the rest of the app. What is part of it is whether the
   * page is on screen at all, because a full-window DOM surface over it (a modal,
   * the address spotlight, the command palette) takes the keys along with the
   * screen   the same answer that detaches the native view. So the claim follows
   * `pageVisible` rather than focus, and a page that failed to load keeps it: its
   * card is what is on screen, and reload is what the browser's keys are for
   * there.
   *
   * One browser tab at a time holds it, and the component is keyed by tab, so a
   * tab switch hands the claim over with the page.
   */
  $effect(() => {
    if (!pageVisible) return
    browserKeyboardFocus.setClaim('workspace', tabId)
    return () => browserKeyboardFocus.setClaim('workspace', null)
  })

  onMount(() => {
    // Claim the single native view for this tab while this surface is mounted.
    // The claim is released with the component, so a destroyed surface can never
    // keep the view. Publishing it also flips `pageVisible`, which is what
    // attaches the page on the first paint.
    const releaseClaim = browserVisibility.claimTab(tabId, 'workspace')
    const unsubscribePanelShortcut = subscribe('browser:panelShortcut', onPanelShortcut)
    let destroyed = false
    const observer = new ResizeObserver(() => {
      if (!destroyed) void showAtCurrentBounds().catch(() => {})
    })
    if (contentElement) observer.observe(contentElement)
    const onWindowResize = (): void => {
      if (!destroyed) void showAtCurrentBounds().catch(() => {})
    }
    window.addEventListener('resize', onWindowResize)
    return () => {
      destroyed = true
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
      unsubscribePanelShortcut()
      // The bar is gone with this frame, so its search ends with it: the page is
      // parked rather than destroyed, and a highlight left on it would still be
      // painted when the user comes back to this tab.
      browserFindState.forget(tabId)
      releaseClaim()
    }
  })
</script>

<div class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-app" data-region="browser-workspace">
  {#if findOpen}
    <!-- The bar is a row of this frame rather than an overlay: the page is a native
         view composited above the DOM, so a row above it shrinks the content rect
         and the observers place the page under the bar. -->
    <div class="flex shrink-0 justify-center px-2 py-1.5">
      <div class="w-full max-w-xl">
        <BrowserFindBar {tabId} />
      </div>
    </div>
  {/if}
  <div
    {@attach attachContentElement}
    {@attach pageVisible && !loadError && manageNativeView}
    class="relative min-h-0 flex-1"
    role="presentation"
    oncontextmenu={(event) => {
      // The page itself renders in a native view above this host, so a click it
      // does not take (the load-error card, a blank frame) lands here. Main
      // builds the same page-level menu the page's own right-click does.
      event.preventDefault()
      openBrowserPageMenuAt(tabId, event.clientX, event.clientY)
    }}
  >
    {#if loadError}
      <BrowserLoadErrorView
        error={loadError}
        url={tab.url}
        loading={runtime.loading}
        canGoBack={runtime.canGoBack}
        onRetry={() => void invoke('browser:reload', tabId).catch(() => {})}
        onGoBack={() => void invoke('browser:goBack', tabId).catch(() => {})}
      />
    {/if}
  </div>
</div>
