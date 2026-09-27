<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { invoke } from '$lib/ipc.svelte'
  import type { BrowserViewBounds } from '$shared/ipc-contract'
  import { GLOBAL_BROWSER_CONTEXT } from '$lib/stores/global-browser.svelte'
  import type { GlobalBrowserTab } from '$lib/stores/global-browser-types'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'

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
        bounds
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

  onMount(() => {
    // Claim the single native view for this tab while this surface is mounted.
    // The claim is released with the component, so a destroyed surface can never
    // keep the view. Publishing it also flips `pageVisible`, which is what
    // attaches the page on the first paint.
    const releaseClaim = browserVisibility.claimTab(tabId, 'workspace')
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
      releaseClaim()
    }
  })
</script>

<div class="relative min-h-0 min-w-0 flex-1 bg-surface" data-region="browser-workspace">
  <div
    {@attach attachContentElement}
    {@attach pageVisible && manageNativeView}
    class="absolute inset-0"
  ></div>
</div>
