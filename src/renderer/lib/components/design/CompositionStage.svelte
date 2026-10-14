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
   * This stage is the board's own frame for that view: it measures its rectangle,
   * claims the tab for the `panel` surface, and tells main where to place the
   * page, exactly the way the browser panel does for the sidebar. The board then
   * has the real composition above its timeline, so scrubbing, stepping and the
   * controls edit what the user is watching rather than a still of it.
   *
   * The app shows one native view at a time, so the store resolves this claim
   * against every other surface: while the board is on screen it owns the view,
   * and the in-app browser keeps working for any other page.
   */
  interface Props {
    tab: VideoCompositionTab
  }

  let { tab }: Props = $props()

  const surface = 'panel' as const
  // The tab identity is snapshotted at construction: the key is this stage's entry
  // in the store's frame list, and a re-keyed tab builds a new stage.
  // svelte-ignore state_referenced_locally
  const nativeFrameKey = `native-panel-${tab.tabId}`

  let host = $state<HTMLDivElement>()
  /** The stage's current on-screen rectangle, refreshed by the same observers
   *  that align the native view. */
  let contentRect = $state<BrowserViewBounds | null>(null)

  let placed = $derived(browserVisibility.isVisible(tab.tabId, contentRect))

  function contentBounds(): BrowserViewBounds | null {
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
    const bounds = contentBounds()
    // Publish the frame before the visibility check: the store needs the current
    // rectangle even while the view is detached, so this stage notices as soon as
    // an overlay stops covering it.
    contentRect = bounds
    if (!bounds) return
    // Ask the store directly instead of reading `placed`: this also runs from
    // observers and continuations, after the effect that owns a derived may have
    // been torn down.
    if (!browserVisibility.isVisible(tab.tabId, bounds)) return
    try {
      await invoke(
        'browser:show',
        tab.tabId,
        tab.projectId,
        tab.threadId,
        tab.url,
        bounds,
        tab.boxId
      )
      // The store's answer can change while that call is in flight: another
      // surface may claim the view, or an overlay may appear. Only one native
      // view can exist at a time, so a stale attach would leave the page over
      // the surface that now owns it.
      if (!browserVisibility.isVisible(tab.tabId, contentBounds())) {
        void invoke('browser:hide', tab.tabId).catch(() => {})
      }
    } catch {
      // The tab can be destroyed between the visibility check and the call.
    }
  }

  /** The single native rectangle this stage owns while it is really on screen. */
  $effect(() => {
    const bounds = contentRect
    if (bounds) browserVisibility.publishPageFrame(nativeFrameKey, tab.tabId, bounds)
    else browserVisibility.clearPageFrame(nativeFrameKey)
    return () => browserVisibility.clearPageFrame(nativeFrameKey)
  })

  $effect(() => {
    const frame = placed && contentRect ? contentRect : null
    if (!frame) {
      browserVisibility.clearNativeFrame(nativeFrameKey)
      return
    }
    browserVisibility.publishNativeFrame(nativeFrameKey, frame)
    return () => browserVisibility.clearNativeFrame(nativeFrameKey)
  })

  /**
   * The page's frame, and the observers that keep the native view on it.
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

<div
  class="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface"
>
  <BrowserCompositionTransport tabId={tab.tabId} composition={tab} active={placed} />
  <div
    {@attach attachHost}
    data-native-composition-stage
    class="min-h-0 flex-1 bg-surface"
    aria-label={`Live composition ${tab.directory}`}
  ></div>
</div>
