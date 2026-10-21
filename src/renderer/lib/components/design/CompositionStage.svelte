<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { invoke } from '$lib/ipc.svelte'
  import { loadBrowser } from '$lib/stores/browser-access.svelte'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import type { VideoCompositionTab } from '$lib/stores/video-timeline.svelte'
  import type { BrowserViewBounds } from '$shared/ipc-contract'
  import BrowserCompositionTransport from '$lib/components/browser/BrowserCompositionTransport.svelte'

  /**
   * The live composition, played inside the board.
   *
   * A composition is a page served on a loopback origin, and the app plays it in
   * a native `WebContentsView` that the compositor draws above every DOM node.
   * This stage is the board's own frame for that view: it measures its pane,
   * fits the composition's own aspect ratio inside it, and tells main where to
   * place the page, exactly the way the browser panel does for the sidebar.
   *
   * The frame is fitted here rather than by CSS because the view is native. A
   * native view cannot be clipped by `overflow`, so a stage that filled the pane
   * would draw over the panel at the sizes where the composition is taller than
   * the visible area, and the composition's ratio would be whatever the panel
   * happened to be. Fitting the rectangle is what makes every panel size show the
   * whole frame, with the pane's own background as the letterbox.
   *
   * The app shows one native view at a time, so the store resolves this claim
   * against every other surface: while the board is on screen it owns the view,
   * and the in-app browser keeps working for any other page.
   */
  interface Props {
    tab: VideoCompositionTab
    active?: boolean
    /**
     * Whether one of the board's own menus is open over this pane.
     *
     * A menu cannot be raised above a native view, so the page has to step aside
     * for it. Only the pane is published, because the store's answer is per
     * surface: there is nothing finer to hide than the whole page.
     */
    covered?: boolean
  }

  let { tab, active = true, covered = false }: Props = $props()

  const surface = 'panel' as const
  // The tab identity is snapshotted at construction: the key is this stage's entry
  // in the store's frame list, and a re-keyed tab builds a new stage.
  // svelte-ignore state_referenced_locally
  const nativeFrameKey = `native-panel-${tab.tabId}`
  /** This pane's entry in the store's list of floating overlays, for as long as
   *  one of the board's menus is over it. Snapshotted with the frame key above. */
  // svelte-ignore state_referenced_locally
  const occlusionKey = `composition-pane-${tab.tabId}`

  /**
   * The tab this pane places: the live one while it is there, and the one this
   * stage was built for once the board's answer goes null.
   *
   * The board hands the stage `liveTab`, which turns null the moment the folder in
   * front stops being the one its view plays. A child's props are getters that
   * re-read their source for as long as the child is mounted, so every read below
   *   the observers' placements, the effect cleanups, the unmount   has to answer
   * on that frame too. Reading a null there threw out of the board's own cleanup
   * and aborted the render behind it, which is what left the pane blank. Keeping
   * the tab the stage was built for as the floor of every read leaves the live one
   * in charge while it is there, so a state report still reaches the transport.
   */
  // svelte-ignore state_referenced_locally
  const mountedTab = tab
  let placedTab = $derived(tab ?? mountedTab)

  let host = $state<HTMLDivElement>()
  /** The pane's on-screen rectangle, which is the area the frame is fitted into. */
  let paneRect = $state<BrowserViewBounds | null>(null)

  /**
   * The composition's rectangle: its own ratio, contained in the pane, centred.
   *
   * Contain rather than fill, so a panel narrower or wider than the composition
   * letterboxes instead of stretching or cutting it. A composition that declares
   * no size falls back to 16:9, which is the ratio the export uses when the
   * manifest names none.
   */
  function fittedBounds(pane: BrowserViewBounds | null): BrowserViewBounds | null {
    if (!pane) return null
    const declaredWidth = placedTab.width > 0 ? placedTab.width : 16
    const declaredHeight = placedTab.height > 0 ? placedTab.height : 9
    const ratio = declaredWidth / declaredHeight
    const paneRatio = pane.width / pane.height
    const fittedWidth = ratio > paneRatio ? pane.width : Math.round(pane.height * ratio)
    const fittedHeight = ratio > paneRatio ? Math.round(pane.width / ratio) : pane.height
    return {
      x: pane.x + Math.floor((pane.width - fittedWidth) / 2),
      y: pane.y + Math.floor((pane.height - fittedHeight) / 2),
      width: Math.max(1, fittedWidth),
      height: Math.max(1, fittedHeight)
    }
  }

  /** The frame the page occupies, derived from the pane it is fitted into. */
  let pageRect = $derived(fittedBounds(paneRect))

  let placed = $derived(browserVisibility.isVisible(placedTab.tabId, pageRect))

  function measurePane(): BrowserViewBounds | null {
    if (!host) return null
    // A mounted panel is not automatically a painted one: the rail keeps its
    // panels alive across view switches, so an element that is laid out but
    // hidden must place nothing, or the page would sit over a surface nobody
    // can see.
    if (
      typeof host.checkVisibility === 'function' &&
      !host.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
        contentVisibilityAuto: true
      })
    )
      return null
    const rect = host.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    return {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height))
    }
  }

  async function showAtCurrentBounds(): Promise<void> {
    await loadBrowser()
    const pane = measurePane()
    // Publish the pane before the visibility check: the store needs the current
    // rectangle even while the view is detached, so this stage notices as soon as
    // an overlay stops covering it.
    paneRect = pane
    if (!pane) return
    const frame = fittedBounds(pane)
    if (!frame) return
    // Ask the store directly instead of reading `placed`: this also runs from
    // observers and continuations, after the effect that owns a derived may have
    // been torn down.
    if (!browserVisibility.isVisible(placedTab.tabId, frame)) return
    try {
      await invoke(
        'browser:show',
        placedTab.tabId,
        placedTab.projectId,
        placedTab.threadId,
        placedTab.url,
        frame,
        placedTab.boxId
      )
      // The store's answer can change while that call is in flight: another
      // surface may claim the view, or an overlay may appear. Only one native
      // view can exist at a time, so a stale attach would leave the page over
      // the surface that now owns it.
      const current = fittedBounds(measurePane())
      if (!current || !browserVisibility.isVisible(placedTab.tabId, current)) {
        browserVisibility.detachUnlessAnotherSurfaceDisplays(placedTab.tabId, surface)
      }
    } catch {
      // The tab can be destroyed between the visibility check and the call.
    }
  }

  /** The single native rectangle this stage owns while it is really on screen. */
  $effect(() => {
    const frame = pageRect
    if (frame) browserVisibility.publishPageFrame(nativeFrameKey, placedTab.tabId, frame)
    else browserVisibility.clearPageFrame(nativeFrameKey)
    return () => browserVisibility.clearPageFrame(nativeFrameKey)
  })

  $effect(() => {
    const frame = placed && pageRect ? pageRect : null
    if (!frame) {
      browserVisibility.clearNativeFrame(nativeFrameKey)
      return
    }
    browserVisibility.publishNativeFrame(nativeFrameKey, frame)
    return () => browserVisibility.clearNativeFrame(nativeFrameKey)
  })

  /**
   * Put the page back on this frame when this surface owns the view again, and
   * take it off screen when it does not.
   *
   * Placing is not enough on its own. A native view composites above every DOM
   * node, so a page left attached draws over whatever covered it: a board menu, a
   * modal, or the full screen surface. Hiding it here is also what makes the pane
   * recover, because the same effect places it again the moment the store hands
   * the view back rather than waiting for a resize that may never come.
   */
  $effect(() => {
    if (!placed) {
      browserVisibility.detachUnlessAnotherSurfaceDisplays(placedTab.tabId, surface)
      return
    }
    void showAtCurrentBounds().catch(() => {})
  })

  /**
   * Publish this pane as covered while one of the board's menus is open.
   *
   * The rectangle is only what the store measures with: its answer is whether the
   * surface may show its page at all, so any overlap takes the whole pane off
   * screen, which is what makes the menu readable.
   */
  $effect(() => {
    if (!covered || !paneRect) return
    browserVisibility.publishOcclusion(occlusionKey, paneRect)
    return () => browserVisibility.clearOcclusion(occlusionKey)
  })

  /**
   * The pane's frame, and the observers that keep the native view on it.
   *
   * The measurement follows the rectangle rather than a single placement: the
   * board scrolls, the rail resizes and the window moves, and the page has to
   * land on the frame that exists at the moment the attach happens.
   */
  const attachHost: Attachment<HTMLDivElement> = (element) => {
    host = element
    let destroyed = false
    const place = (): void => {
      if (!destroyed) void showAtCurrentBounds().catch(() => {})
    }
    const observer = new ResizeObserver(place)
    observer.observe(element)
    // A panel that becomes visible without resizing (a rail switching to this
    // board) fires no ResizeObserver, so the intersection is what re-places the
    // page once the frame is genuinely on screen.
    const intersection = new IntersectionObserver(place, { threshold: 0 })
    intersection.observe(element)
    window.addEventListener('resize', place)
    void tick().then(place)
    return () => {
      destroyed = true
      observer.disconnect()
      intersection.disconnect()
      window.removeEventListener('resize', place)
      if (host === element) host = undefined
      browserVisibility.detachUnlessAnotherSurfaceDisplays(placedTab.tabId, surface)
    }
  }

  onMount(() => {
    // Claim the native view for this tab while the stage is mounted. The claim is
    // released with the component, so a torn-down board can never keep the view.
    const releaseClaim = browserVisibility.claimTab(placedTab.tabId, surface)
    return () => {
      releaseClaim()
      browserVisibility.detachReleasedTab(placedTab.tabId)
    }
  })
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden border border-border bg-surface">
  <BrowserCompositionTransport
    tabId={placedTab.tabId}
    composition={placedTab}
    active={active && placed}
  />
  <div
    {@attach attachHost}
    data-native-composition-stage
    class="min-h-0 flex-1 bg-app"
    aria-label={`Live composition ${placedTab.directory}`}
  ></div>
</div>
