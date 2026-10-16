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
  }

  let { tab, active = true }: Props = $props()

  const surface = 'panel' as const
  // The tab identity is snapshotted at construction: the key is this stage's entry
  // in the store's frame list, and a re-keyed tab builds a new stage.
  // svelte-ignore state_referenced_locally
  const nativeFrameKey = `native-panel-${tab.tabId}`

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
    const declaredWidth = tab.width > 0 ? tab.width : 16
    const declaredHeight = tab.height > 0 ? tab.height : 9
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

  let placed = $derived(browserVisibility.isVisible(tab.tabId, pageRect))

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
    if (!browserVisibility.isVisible(tab.tabId, frame)) return
    try {
      await invoke(
        'browser:show',
        tab.tabId,
        tab.projectId,
        tab.threadId,
        tab.url,
        frame,
        tab.boxId
      )
      // The store's answer can change while that call is in flight: another
      // surface may claim the view, or an overlay may appear. Only one native
      // view can exist at a time, so a stale attach would leave the page over
      // the surface that now owns it.
      const current = fittedBounds(measurePane())
      if (!current || !browserVisibility.isVisible(tab.tabId, current)) {
        void invoke('browser:hide', tab.tabId).catch(() => {})
      }
    } catch {
      // The tab can be destroyed between the visibility check and the call.
    }
  }

  /** The single native rectangle this stage owns while it is really on screen. */
  $effect(() => {
    const frame = pageRect
    if (frame) browserVisibility.publishPageFrame(nativeFrameKey, tab.tabId, frame)
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
   * Put the page back on this frame when this surface owns the view again.
   *
   * Another surface can hold the single native view for a while: the full screen
   * composition is this very tab shown bigger, and it hides the view as it
   * unmounts. The store decides who owns the view, so the answer coming back here
   * has to re-place the page rather than leave the pane empty until the next
   * resize happens to fire.
   */
  $effect(() => {
    if (!placed) return
    void showAtCurrentBounds().catch(() => {})
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
      void invoke('browser:hide', tab.tabId).catch(() => {})
    }
  }

  onMount(() => {
    // Claim the native view for this tab while the stage is mounted. The claim is
    // released with the component, so a torn-down board can never keep the view.
    return browserVisibility.claimTab(tab.tabId, surface)
  })
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden border border-border bg-surface">
  <BrowserCompositionTransport tabId={tab.tabId} composition={tab} active={active && placed} />
  <div
    {@attach attachHost}
    data-native-composition-stage
    class="min-h-0 flex-1 bg-app"
    aria-label={`Live composition ${tab.directory}`}
  ></div>
</div>
