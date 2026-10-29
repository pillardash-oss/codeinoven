<script lang="ts">
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'
  import CioArrowLeft from '@pdslng/cio-icon/CioArrowLeft.svelte'
  import CioArrowRight from '@pdslng/cio-icon/CioArrowRight.svelte'
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
  import CioMarquee from '@pdslng/cio-icon/CioMarquee.svelte'
  import CioMinimize from '@pdslng/cio-icon/CioMinimize.svelte'
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioTabExtensions from '@pdslng/cio-icon/CioTabExtensions.svelte'
  import { onMount, tick } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { designElementChatContext, openAnnotationChat } from '$lib/annotation-chat'
  import { loadBrowser } from '$lib/stores/browser-access.svelte'
  import DesignScreenHistoryControls from '../design/DesignScreenHistoryControls.svelte'
  import { designScreenEntryFromUrl } from '$shared/design/screens'
  import BrowserAddressBar from './BrowserAddressBar.svelte'
  import BrowserBlankTab from './BrowserBlankTab.svelte'
  import BrowserBoxButton from './BrowserBoxButton.svelte'
  import BrowserCompositionTransport from './BrowserCompositionTransport.svelte'
  import BrowserExtensionDropdown from './BrowserExtensionDropdown.svelte'
  import { openThreadBrowserExtensionMenu } from './browser-extension-bar-menus'
  import BrowserFindBar from './BrowserFindBar.svelte'
  import BrowserLoadErrorView from './BrowserLoadErrorView.svelte'
  import DesignElementCommentPopover from './DesignElementCommentPopover.svelte'
  import { browserDownloads } from '$lib/stores/browser-downloads.svelte'
  import { browserExtensionDropdown } from '$lib/stores/browser-extension-dropdown.svelte'
  import { browserExtensions } from '$lib/stores/browser-extensions.svelte'
  import { storeExtensionOfferForPage } from '$lib/stores/browser-extension-store-offer'
  import { browserFindState } from '$lib/stores/browser-find.svelte'
  import { browserVisibility, type BrowserSurface } from '$lib/stores/browser-visibility.svelte'
  import { browserBlankDraft } from '$lib/stores/browser-blank-draft.svelte'
  import { browserAddressFocus } from '$lib/stores/browser-address-focus'
  import { browserKeyboardFocus } from '$lib/stores/browser-keyboard-focus'
  import { browserInspector } from '$lib/stores/browser-inspector.svelte'
  import { responseReferencesState } from '$lib/stores/response-references.svelte'
  import {
    browserSiteHost,
    browserSiteOrigin,
    openBrowserDownloadsMenu,
    openBrowserPageMenu,
    openBrowserPageMenuAt,
    openBrowserSiteMenu
  } from './browser-chrome-menus'
  import { contextSidebarState, type BrowserContextTab } from '$lib/stores/context-sidebar.svelte'
  import type {
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
    /**
     * Reported with the replacement tab id when this tab is reopened in another
     * box. A surface that tracks the tab by its own id (the full screen overlay)
     * follows it here; the sidebar needs no callback because the store already
     * moved its active tab.
     */
    onTabReplaced?: (tabId: string) => void
    /**
     * The way out of this surface, when the surface draws no strip of its own.
     *
     * A composition opened full screen is watched, not browsed: it carries the
     * playback controls where a browser would carry its address bar, so the
     * minimize button has to sit on that row, and only the caller owns the
     * surface that closes.
     */
    onMinimize?: () => void
    playerInEditor?: boolean
    onExpandVideo?: () => void
    minimizeTitle?: string
  }

  let {
    tab,
    fullscreen = false,
    onTabReplaced,
    onMinimize,
    playerInEditor = false,
    onExpandVideo,
    minimizeTitle = 'Leave full screen'
  }: Props = $props()

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
  // svelte-ignore state_referenced_locally
  const tabBoxId = tab.boxId

  /** This page's entry in the store's list of native rectangles on screen. Keyed
   *  by surface as well as tab: the full screen dialog and a sidebar panel can
   *  both be mounted for one tab, and only the one allowed to show it publishes. */
  const nativeFrameKey = `native-${surface}-${tabId}`

  function initialPageState(): BrowserPageState {
    return {
      tabId,
      projectId: tabProjectId,
      threadId: tabThreadId,
      boxId: tabBoxId,
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
  /** The chrome's current address, updated immediately on submit and reconciled
   *  when the page reports its committed URL. */
  let address = $state(initialPageState().url)
  /** The address bar, which is the field the user types an address in. It is
   *  taken imperatively because taking the keyboard for a tab the user just
   *  opened is a gesture, not a state this panel holds. */
  let addressBar = $state<BrowserAddressBar | undefined>(undefined)
  let pageState = $state<BrowserPageState>(initialPageState())
  /**
   * A composition watched full screen is a player, not a browser.
   *
   * The surface then carries the playback row where an address bar would sit and
   * nothing else: no back/forward, no reload, no address field, no find bar. The
   * user came here to watch and to place notes on frames, and every browser control
   * around the picture is one more thing between them and the film.
   */
  let compositionPlayer = $derived(fullscreen && pageState.composition !== null)
  let stateRevision = 0
  /** The panel's current on-screen content rectangle, refreshed by the same
   *  observers that align the native view. */
  let contentRect = $state<BrowserViewBounds | null>(null)
  /** Whether the browser's native view may be on screen for this tab right now.
   *  The store owns the entire decision   published blocks (a full-window DOM
   *  surface, an inactive workspace, the thread switcher), which surface owns
   *  the single native view, and whether a floating DOM overlay covers this
   *  frame   so this panel never has to combine them itself. */
  function synchronizePageFrame() {
    const bounds = contentRect
    if (bounds) browserVisibility.publishPageFrame(nativeFrameKey, tabId, bounds)
    else browserVisibility.clearPageFrame(nativeFrameKey)
    return () => browserVisibility.clearPageFrame(nativeFrameKey)
  }
  $effect(synchronizePageFrame)

  let panelVisible = $derived(browserVisibility.isVisible(tabId, contentRect))
  /** The extension button tucked under the toolbar's own row, which the dropdown
   *  card hangs from. */
  let extensionButton = $state<HTMLButtonElement>()
  /** The Web Store offer this tab's page makes, or null when it makes none. */
  const storeOffer = $derived(
    storeExtensionOfferForPage({
      projectId: tabProjectId,
      url: pageState.url,
      title: pageState.title,
      boxId: tabBoxId
    })
  )
  const installableOffer = $derived(storeOffer !== null && storeOffer.installed === null)
  /** Whether an extension install is in flight, so the button says so instead of
   *  quietly accepting a second click. */
  const installingExtensions = $derived(browserExtensions.installs.length > 0)
  /**
   * The tab, in the shape the extension menu and its popups act on.
   *
   * Read from the live page state rather than the tab captured at construction, so
   * the offer and the jar always describe what the toolbar is showing now.
   */
  const extensionTab = $derived({
    tabId,
    projectId: tabProjectId,
    threadId: tabThreadId,
    boxId: tabBoxId,
    url: pageState.url,
    title: pageState.title
  })
  /** A blank tab has no address yet: show the empty state instead of a native page. */
  let isBlank = $derived(pageState.url === '' && !pageState.loading && !pageState.loadError)
  /**
   * Whether element inspection is armed on this tab.
   *
   * Read from the shared session, not owned here: the mode belongs to the tab,
   * so the sidebar and the full screen surface show and keep the same state, and
   * moving between them neither drops the mode nor disarms the page.
   */
  const authoredWork = $derived(pageState.design ?? pageState.composition)
  const screenEntry = $derived(
    authoredWork ? designScreenEntryFromUrl(pageState.url, authoredWork.origin) : null
  )
  let inspectArmed = $derived(browserInspector.isArmed(tabId))
  /**
   * The comment bubble this tab has open, and what it takes to draw it.
   *
   * The bubble is the app's own component, placed beside the element in the app
   * window's coordinates, so this is the element's short name (the first line of
   * its descriptor) together with the place main resolved for the element and
   * the comment already written.
   */
  const designComment = $derived.by(() => {
    const editing = browserInspector.editingFor(tabId)
    if (!editing) return null
    const reference = responseReferencesState
      .forThread(tabProjectId, tabThreadId)
      .find((candidate) => candidate.id === editing.referenceId)
    if (!reference) return null
    const named = (reference.text.split('\n')[0] ?? '').replace(/^Design element:\s*/u, '')
    return {
      referenceId: reference.id,
      anchor: editing.anchor,
      elementName: named || reference.label,
      comment: reference.comment ?? ''
    }
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
  let siteOrigin = $derived(browserSiteOrigin(pageState.url))

  /** Open the native site-settings menu anchored at the lock button. The main
   *  process builds an OS context menu (manual per-site permissions, with
   *  native destructive-action confirmation dialogs) that composites above
   *  the page view, so the view never detaches for this interaction. The
   *  tab's box travels with it so both halves act on the jar the page
   *  actually runs in rather than the scope's own jar. */
  function openSiteMenu(event: MouseEvent): void {
    const button = event.currentTarget
    if (!(button instanceof HTMLElement)) return
    siteMenuOpen = true
    void openBrowserSiteMenu(tabProjectId, siteHost, siteOrigin, button, tabBoxId, '').then(
      (opened) => {
        if (!opened) siteMenuOpen = false
      }
    )
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
  function claimRequestedAddressFocus() {
    const bar = addressBar
    if (!bar) return
    if (!panelVisible) return
    if (!browserAddressFocus.take(tabId)) return
    // A request belongs to the moment a blank tab opens. By the time this panel
    // is the one on screen the user may already have given the tab an address,
    // and selecting the address of a page they already navigated would take the
    // keyboard for a field they are done with: the request is spent either way.
    if (!isBlank) return
    bar.focusAndSelect()
  }
  $effect(claimRequestedAddressFocus)

  /**
   * Continue typing started in the empty state when the fullscreen surface
   * mounts: the bar already mirrors the shared draft, so only the caret has
   * to be placed where typing stopped. Runs once per fullscreen mount while
   * the tab is still blank and a draft exists; the sidebar instance behind it
   * is not visible and leaves focus alone.
   */
  let continuedBlankDraft = $state(false)
  $effect(() => {
    if (!fullscreen) return
    if (continuedBlankDraft) return
    if (!panelVisible) return
    const bar = addressBar
    if (!bar) return
    if (!isBlank) return
    const stored = browserBlankDraft.get(tabId)
    if (!stored) return
    continuedBlankDraft = true
    void tick().then(() => {
      try {
        bar.focusWithCaret(stored.caret ?? stored.text.length)
      } catch {
        // Focus alone is the fallback.
      }
    })
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
    if (eventTabId !== tabId) return
    if (!panelVisible) return
    if (action === 'focus-address') {
      addressBar?.focusAndSelect()
      return
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
      browserVisibility.detachUnlessAnotherSurfaceDisplays(tabId, surface)
    }
  }

  /**
   * Report this page's rectangle while it is really on screen, which is what lets
   * the toaster's corner check see that a page covers it. A panel the store is not
   * showing publishes nothing, so the two instances of one tab can never both
   * claim the same screen space.
   */
  function synchronizeNativeFrame() {
    const frame = panelVisible && !pageState.loadError && !isBlank ? contentRect : null
    if (!frame) {
      browserVisibility.clearNativeFrame(nativeFrameKey)
      return
    }
    browserVisibility.publishNativeFrame(nativeFrameKey, frame)
    return () => browserVisibility.clearNativeFrame(nativeFrameKey)
  }
  $effect(synchronizeNativeFrame)

  function contentBounds(): BrowserViewBounds | null {
    if (!contentElement) return null
    const rect = contentElement.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    // A composition draws at the size its manifest declares, so it is fitted into
    // the content box at that aspect and centred, exactly as the board's own stage
    // fits it. Handing a 16:9 page a window-shaped view made the picture arrive
    // stretched or cropped, and the page's `100vw` sizing then drew it at the wrong
    // shape rather than merely at the wrong scale.
    const composition = pageState.composition
    if (composition && composition.width > 0 && composition.height > 0) {
      const ratio = composition.width / composition.height
      const boxRatio = rect.width / rect.height
      const width = ratio > boxRatio ? rect.width : rect.height * ratio
      const height = ratio > boxRatio ? rect.width / ratio : rect.height
      return {
        x: Math.max(0, Math.round(rect.x + (rect.width - width) / 2)),
        y: Math.max(0, Math.round(rect.y + (rect.height - height) / 2)),
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height))
      }
    }
    return {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height))
    }
  }

  async function showAtCurrentBounds(): Promise<void> {
    // Thread/design panels can be the first browser opened, without ever
    // visiting the global Browser view. Wire the shared runtime before main
    // publishes page state or inspector events for this surface.
    await loadBrowser()
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
    // empty native view back over the card. A blank tab is the same: its empty
    // state is DOM, so no native page may cover it.
    if (pageState.loadError || isBlank) return
    try {
      const currentUrl = (tab as BrowserContextTab | null)?.url ?? tabInitialUrl
      const revision = stateRevision
      const snapshot = await invoke(
        'browser:show',
        tabId,
        tabProjectId,
        tabThreadId,
        currentUrl,
        bounds,
        // The tab's box, so a page the user opened in a shared box runs against
        // that jar rather than the scope's own.
        tabBoxId
      )
      if (stateRevision === revision) applyPageState(snapshot)
      // The store's answer can change while that call is in flight: another
      // surface may claim the view, an overlay may appear, or the sidebar may
      // move on. Only one native view can exist at a time, so a stale attach
      // would leave the wrong tab on screen on top of the surface that now owns
      // it. Re-asking the store keeps the decision authoritative at the moment
      // the attach lands. A redundant hide is a no-op in the main process when
      // this tab is not the one attached.
      if (!browserVisibility.isVisible(tabId, contentBounds())) {
        browserVisibility.detachUnlessAnotherSurfaceDisplays(tabId, surface)
      }
    } catch {
      // Tab may have been destroyed between the visibility check and the IPC.
    }
  }

  /** Open a resolved address in this tab. */
  function navigate(url: string): void {
    const previous = pageState
    address = url
    browserBlankDraft.clear(tabId)
    contextSidebarState.updateBrowserTab(tabId, url)
    // The tab is on the address from the moment it is submitted, not from the
    // first report main sends back. Without this the panel keeps the empty state
    // (or the previous page's state) for the whole handover, and returning to a
    // tab that is only just loading looks like a tab that was never given an
    // address. The snapshot is replaced as soon as a real report lands.
    const optimistic = { ...previous, url, loading: true, loadError: null }
    pageState = optimistic
    void invoke('browser:navigate', tabId, tabProjectId, tabThreadId, url, tabBoxId).catch(() => {
      // The tab can be destroyed between the submit and the call. Put the page
      // the tab is really on back rather than leaving an address that never
      // loaded on screen.
      if (pageState !== optimistic) return
      pageState = previous
      address = previous.url
      contextSidebarState.updateBrowserTab(tabId, previous.url)
    })
  }

  function applyPageState(next: BrowserPageState): void {
    if (next.tabId !== tabId) return
    stateRevision++
    pageState = next
    if (next.url) address = next.url
    // Also routes the audio and capture state into the tab strip, so the tab's
    // indicator is correct even for the first report of a tab main kept alive
    // across a renderer reload.
    contextSidebarState.applyBrowserPageState(next)
  }

  /**
   * Open the extensions menu under the button.
   *
   * A left-click lists the box's extensions and heads the list with the Web Store
   * offer the page is making; a right-click adds the two ways to install. Both go
   * through one native menu, because the page on screen is a native view above the
   * renderer and a document dropdown would be drawn behind it.
   */
  function openExtensionMenu(installDoors: boolean): void {
    const anchor = extensionButton
    if (!anchor) return
    void openThreadBrowserExtensionMenu(extensionTab, anchor, installDoors)
  }

  /** Arm or disarm element inspection for this tab, through the shared session. */
  function toggleInspect(): void {
    if (!inspectArmed && !pageState.design) return
    browserInspector.toggle(tabId)
  }

  /** Persist the in-progress text, so a closed bubble cannot discard a draft. */
  function draftDesignComment(referenceId: string, comment: string): void {
    responseReferencesState.updateCommentDraft(tabProjectId, tabThreadId, referenceId, comment)
  }

  /** Land the comment on the element it was written for, and close the bubble. */
  function commitDesignComment(referenceId: string, comment: string): void {
    responseReferencesState.updateComment(tabProjectId, tabThreadId, referenceId, comment)
    browserInspector.closeComment(tabId)
  }

  /** Detach the element, and the comment it carries, from the conversation. */
  function removeDesignComment(referenceId: string): void {
    responseReferencesState.setForThread(
      tabProjectId,
      tabThreadId,
      responseReferencesState
        .forThread(tabProjectId, tabThreadId)
        .filter((reference) => reference.id !== referenceId)
    )
    browserInspector.closeComment(tabId)
  }

  /**
   * Ask about the element whose comment is open, before writing the comment.
   *
   * The one comment bubble carries the read-only chat pair every annotation
   * offers, so the user can question an element they already picked. The
   * element's own descriptor is the selection, and the design folder it was
   * picked from is the context the answer is read from; the bubble then closes
   * the way its Cancel does, keeping the reference and its draft.
   */
  function openDesignElementChat(mode: 'elaborate' | 'quick'): void {
    const open = designComment
    if (!open) return
    const reference = responseReferencesState
      .forThread(tabProjectId, tabThreadId)
      .find((candidate) => candidate.id === open.referenceId)
    if (!reference) return
    openAnnotationChat({
      projectId: tabProjectId,
      threadId: tabThreadId,
      mode,
      selection: reference.text,
      context: designElementChatContext(reference.directory, reference.designEntry)
    })
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
      browserVisibility.detachReleasedTab(tabId)
    }
  })
</script>

<div
  {@attach panelVisible && !pageState.loadError && !isBlank && manageNativeBrowserView}
  class="flex h-full min-h-0 flex-col bg-app"
>
  {#if !compositionPlayer}
    <div class="flex h-10 shrink-0 items-center gap-1.5 border-b border-border bg-surface px-2">
      <button
        type="button"
        class="flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-35"
        disabled={!pageState.canGoBack}
        aria-label="Go back"
        title="Go back"
        onclick={() => void invoke('browser:goBack', tabId).catch(() => {})}
      >
        <CioArrowLeft size={14} />
      </button>
      <button
        type="button"
        class="flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-35"
        disabled={!pageState.canGoForward}
        aria-label="Go forward"
        title="Go forward"
        onclick={() => void invoke('browser:goForward', tabId).catch(() => {})}
      >
        <CioArrowRight size={14} />
      </button>
      <!-- Reload is shown only when there is a page to act on: an empty tab has
         nothing to reload, and the button becomes the stop affordance while a
         load is in flight. -->
      {#if pageState.loading || pageState.url !== ''}
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          aria-label={pageState.loading ? 'Stop loading' : 'Reload page'}
          title={pageState.loading ? 'Stop loading' : 'Reload page'}
          onclick={onReloadButton}
          oncontextmenu={onReloadContextMenu}
        >
          {#if pageState.loading}
            <CioClose size={14} />
          {:else}
            <CioRefresh size={13} />
          {/if}
        </button>
      {/if}
      <BrowserAddressBar
        bind:this={addressBar}
        {tabId}
        url={address}
        projectId={tabProjectId}
        threadId={tabThreadId}
        boxId={tabBoxId}
        {secure}
        loading={pageState.loading}
        {siteMenuOpen}
        onOpenSiteMenu={openSiteMenu}
        onNavigate={navigate}
      />
      <BrowserBoxButton
        projectId={tabProjectId}
        threadId={tabThreadId}
        boxId={tabBoxId}
        labelled={fullscreen}
        onChange={(boxId) => {
          const replacementId = contextSidebarState.setBrowserTabBox(tabId, boxId)
          if (replacementId) onTabReplaced?.(replacementId)
        }}
      />
      <button
        type="button"
        class="relative flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Browser downloads"
        title="Browser downloads"
        onclick={openDownloadsMenu}
      >
        <CioDownload size={13} />
        {#if unfinishedDownloadCount > 0}
          <span
            class="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center bg-accent px-1 text-[0.5625rem] font-semibold tabular-nums text-on-accent"
          >
            {unfinishedDownloadCount}
          </span>
        {/if}
      </button>
      <!-- The extension button, where a browser puts it: the last chrome before the
           page, and the anchor for the dropdown an extension's own popup drops
           into. DevTools is not a toolbar button any more (right-clicking a page
           offers Inspect Element, and the keymap still has its chord), so this is
           the control that belongs here. -->
      <div class="shrink-0">
        <button
          bind:this={extensionButton}
          type="button"
          class={[
            'relative flex h-7 shrink-0 items-center justify-center transition-colors',
            fullscreen ? 'gap-1.5 px-2 text-[0.6875rem] font-medium' : 'w-7',
            browserExtensionDropdown.forTab(tabId)
              ? 'bg-elevated text-foreground'
              : 'text-dimmed hover:bg-elevated hover:text-foreground'
          ]}
          aria-label="Extensions"
          aria-haspopup="menu"
          aria-pressed={browserExtensionDropdown.forTab(tabId) !== null}
          title={installableOffer
            ? `Extensions: ${storeOffer?.name ?? 'one from this store page'} can be installed from here`
            : 'Extensions'}
          onclick={() => openExtensionMenu(false)}
          oncontextmenu={(event) => {
            event.preventDefault()
            openExtensionMenu(true)
          }}
        >
          {#if installingExtensions}
            <CioSpinner size={13} />
          {:else}
            <CioTabExtensions size={14} />
          {/if}
          {#if fullscreen}
            <span>Extensions</span>
          {/if}
          {#if installableOffer}
            <!-- The indicator the store page earns: there is something to install
                 here, and the top row of both menus installs it. -->
            <span class="absolute right-0.5 top-0.5 h-1.5 w-1.5 bg-accent" aria-hidden="true"
            ></span>
          {/if}
        </button>
        {#if panelVisible}
          <BrowserExtensionDropdown {tabId} anchor={extensionButton} />
        {/if}
      </div>
      {#if authoredWork}
        <span class="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden="true"></span>
        {#if screenEntry}
          {#key `${authoredWork.directory}:${screenEntry}`}
            <DesignScreenHistoryControls
              projectId={tabProjectId}
              threadId={tabThreadId}
              {tabId}
              directory={authoredWork.directory}
              entry={screenEntry}
              labelled={fullscreen}
              active={panelVisible}
            />
          {/key}
        {/if}
      {/if}
      {#if pageState.design}
        <button
          type="button"
          class={[
            'relative flex h-7 shrink-0 items-center justify-center transition-colors',
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
          <CioMarquee size={13} />
          {#if fullscreen}
            <span>Inspect</span>
          {/if}
        </button>
      {/if}
    </div>
  {/if}
  {#if findOpen && panelVisible && !compositionPlayer}
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
    <div
      class={[
        'titlebar-no-drag flex shrink-0 items-stretch bg-surface',
        compositionPlayer && !playerInEditor && 'h-10'
      ]}
      style={compositionPlayer && !playerInEditor ? trafficLightInsetStyle() : undefined}
    >
      <div class="min-w-0 flex-1">
        <BrowserCompositionTransport
          {tabId}
          composition={pageState.composition}
          compact={!fullscreen}
          titlebar={compositionPlayer && !playerInEditor}
          projectId={pageState.projectId}
          threadId={pageState.threadId}
          active={panelVisible}
        />
      </div>
      {#if compositionPlayer && onExpandVideo}
        <button
          type="button"
          class="titlebar-no-drag flex w-9 shrink-0 items-center justify-center border-b border-border bg-surface text-dimmed hover:bg-elevated hover:text-foreground"
          title="Watch the video in full screen"
          aria-label="Watch the video in full screen"
          onclick={onExpandVideo}><CioMaximize size={14} /></button
        >
      {:else if compositionPlayer && onMinimize}
        <button
          type="button"
          class="flex w-9 shrink-0 items-center justify-center border-b border-border bg-surface text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          aria-label={minimizeTitle}
          title={minimizeTitle}
          onclick={onMinimize}
        >
          <CioMinimize size={14} />
        </button>
      {/if}
    </div>
  {/if}
  {#if inspectArmed && !compositionPlayer}
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
    class="native-rail-gutter min-h-0 min-w-0 flex-1 bg-surface"
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
        onEditAddress={() => addressBar?.focusAndSelect()}
      />
    {:else if isBlank}
      <BrowserBlankTab
        {tabId}
        projectId={tabProjectId}
        threadId={tabThreadId}
        boxId={tabBoxId}
        scopeLabel={contextSidebarState.browserScopeBoxLabel(tabProjectId, tabThreadId)}
        onNavigate={navigate}
        onSelectBox={(nextBoxId) => {
          const replacementId = contextSidebarState.setBrowserTabBox(tabId, nextBoxId)
          if (replacementId) onTabReplaced?.(replacementId)
        }}
      />
    {/if}
  </div>
  <!--
    The design element's comment bubble, drawn by the app.

    It lives here so one host serves every comment this tab opens, and it is
    positioned in the app window's own coordinates: the same bubble in the same
    place whether the app window draws it or the shared native host moves it above
    the page.
  -->
  <DesignElementCommentPopover
    hostId={`design-comment-${surface}-${tabId}`}
    comment={panelVisible && browserVisibility.ownsSurface(tabId, surface) ? designComment : null}
    targetId={`design-comment-${tabId}-${designComment?.referenceId ?? 'none'}`}
    scope={{ kind: 'project', projectId: tabProjectId }}
    onDraftChange={draftDesignComment}
    onDone={commitDesignComment}
    onRemove={removeDesignComment}
    onClose={() => browserInspector.closeComment(tabId)}
    onExplain={() => openDesignElementChat('elaborate')}
    onQuickChat={() => openDesignElementChat('quick')}
  />
</div>
