<script lang="ts">
  import { onMount } from 'svelte'
  import { Puzzle, X } from '@lucide/svelte'
  import type { BrowserViewBounds } from '$shared/ipc-contract'
  import { browserExtensionSidePanels } from '$lib/stores/browser-extension-side-panels.svelte'

  /**
   * One extension's own side panel, filling the rail.
   *
   * The extension's document is not rendered here. Electron compiles
   * `chrome.sidePanel` out, so main hosts the document in a native
   * `WebContentsView` and composites it over the rectangle this component
   * measures, exactly as it hosts a tab's page and an extension's action popup.
   * This component renders the frame, the header that names the extension and the
   * close control, and nothing else, so no extension markup ever enters the app's
   * document.
   *
   * The panel belongs to the tab on screen: the rail only offers this tool while
   * the active tab holds a panel, and the store's report is what opens and closes
   * it. The frame below is what main aims the document at; when the rail leaves,
   * the panel is parked rather than ended, so an extension mid-request comes back
   * where it was.
   */

  interface Props {
    /**
     * The extension whose panel is shown. Main keys one panel per extension, and
     * the rail resolves the active tab's panel to this id, so the panel's own name
     * is read back from the store rather than passed in beside it.
     */
    extensionId: string
  }

  let { extensionId }: Props = $props()

  /** The panel record, for the header's name, or null for the frame or two before
   *  the store's read lands. */
  const panel = $derived(browserExtensionSidePanels.find(extensionId))

  /**
   * The frame the native document is placed over.
   *
   * Not a `$state`: nothing renders from it, only the measurements below read it,
   * so making it reactive would schedule an update for a value the document never
   * shows.
   */
  let frameElement: HTMLDivElement | undefined

  /** Whether this mount has already handed the panel the keyboard. Reset only by a
   *  new mount, so the rail's entry animation and a resize do not pull focus again
   *  on every placement. */
  let focused = $state(false)

  /** The frame's on-screen rectangle, rounded into the view's own pixel space and
   *  floored at one pixel so a frame mid-collapse never asks for a zero-size
   *  document. */
  function frameBounds(): BrowserViewBounds | null {
    if (!frameElement) return null
    const rect = frameElement.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    return {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height))
    }
  }

  /** Place the panel over the frame it just measured, and hand it the keyboard the
   *  first time it lands. */
  function place(): void {
    const bounds = frameBounds()
    if (!bounds) return
    browserExtensionSidePanels.show(extensionId, bounds)
    if (!focused) {
      focused = true
      browserExtensionSidePanels.focus(extensionId)
    }
  }

  /**
   * Everything that watches the frame belongs to the frame's own life, so it lives
   * in the attachment and ends in the teardown it returns rather than in a mount
   * hook beside it.
   */
  const measureFrame = (element: HTMLDivElement) => {
    frameElement = element
    let stopped = false
    const report = (): void => {
      if (!stopped) place()
    }
    // The frame is a rectangle of the rail, so every change to the rail's width is
    // a change to it. The observer reports the new rectangle as it settles.
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener('resize', report)
    // The rail enters with a short transform, so its rectangle keeps moving for
    // the length of that transition and the document has to follow it until it
    // settles. The observer covers each size change; this bounded loop covers the
    // frames a transition produces between them, the same tail the browser panel
    // runs while its own rail enters.
    let animationFrame = 0
    const startedAt = performance.now()
    const followTransition = (now: number): void => {
      if (stopped) return
      place()
      if (now - startedAt < 260) animationFrame = requestAnimationFrame(followTransition)
    }
    animationFrame = requestAnimationFrame(followTransition)
    return () => {
      stopped = true
      cancelAnimationFrame(animationFrame)
      observer.disconnect()
      window.removeEventListener('resize', report)
      // Leaving the frame parks the panel rather than ending it: main keeps the
      // extension's document running, so it is still there when the rail returns.
      browserExtensionSidePanels.hide(extensionId)
    }
  }

  onMount(() => {
    // The store owns the runtime wiring, so a rail opened before the browser
    // runtime seam ran still subscribes and reads the panel list here, the way the
    // history and bookmarks panels start their own stores on mount.
    browserExtensionSidePanels.start()
  })
</script>

<div class="flex h-full min-h-0 flex-col bg-app" data-region="browser-extension-side-panel">
  <div class="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
    <Puzzle size={13} class="shrink-0 text-muted" />
    <span class="min-w-0 flex-1 truncate text-[0.6875rem] font-medium text-foreground">
      {panel?.extensionName ?? 'Extension panel'}
    </span>
    <button
      type="button"
      class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      aria-label="Close extension panel"
      title="Close extension panel"
      onclick={() => browserExtensionSidePanels.close(extensionId)}
    >
      <X size={12} />
    </button>
  </div>
  <!-- `.native-rail-gutter` keeps the frame clear of the rail's resize band: the
       document is a native view composited above the DOM, so a frame reaching the
       band would swallow the drag that adjusts the rail. -->
  <div {@attach measureFrame} class="native-rail-gutter relative min-h-0 flex-1 bg-app"></div>
</div>
