<script lang="ts">
  import { Portal } from 'bits-ui'
  import { onMount, tick } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { Copy, Maximize2, X } from '@lucide/svelte'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { motionDuration } from '$lib/motion'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import BrowserPeekLoading from './BrowserPeekLoading.svelte'
  import BrowserWorkspace from './BrowserWorkspace.svelte'
  import {
    peekFlightFor,
    peekFlightKeyframes,
    peekFlightStartTransform,
    type BrowserPeekPhase,
    type PeekFlight,
    type PeekRect
  } from './browser-peek-transition'

  /**
   * The Peek Window: one ephemeral page, shown over the browser until the user
   * either closes it or gives it a tab of its own.
   *
   * The page is a native `WebContentsView` owned by main and composited above
   * every DOM node, so this component never draws the page itself. What it draws
   * is the surface around it (the panel, its controls, its loading state) and the
   * shell that flies, which is the one thing a native view cannot do: it is placed
   * at a rectangle and stays there, so every transition runs in the DOM beside it,
   * with the view held off screen for as long as one is in the air.
   *
   * The shell is a copy of the surface laid out at the panel's own rectangle, so its
   * first frame is a pixel-exact stand-in for the panel and the swap between the two
   * is invisible. It carries either a picture of the page, taken while the page is
   * still on screen, or the loading state; when there is neither to carry, the panel
   * itself flies instead and the shell is never created.
   *
   * Which flight runs is the store's decision (`peekPhase`), and the store is told
   * when one lands (`peekFlightLanded`), because a close and an expansion are only
   * finished once the user has seen where the page went.
   */

  const tab = $derived(globalBrowser.peekTab)
  const phase = $derived(globalBrowser.peekPhase)
  /** Whether the page is on screen, or would be if nothing was holding it, so the
   *  surface may show it instead of the loading state it draws in the page's place. */
  const pageOnScreen = $derived(globalBrowser.peekPageOnScreen)
  const loadError = $derived(tab ? globalBrowser.runtimeFor(tab.id).loadError : null)

  /** The modal's own panel: what every flight is measured from, and what the shell
   *  stands in for. */
  let panelEl = $state<HTMLElement | null>(null)
  /** The flying shell, or null while the peek is where it belongs. */
  let shell = $state<PeekShell | null>(null)
  let shellEl = $state<HTMLElement | null>(null)
  const attachShell: Attachment<HTMLDivElement> = (element) => {
    shellEl = element
    return () => {
      if (shellEl === element) shellEl = null
    }
  }

  /** One flight's shell: the rectangle it is laid out at, the picture of the page
   *  it carries, and the transform it is drawn with before its animation takes
   *  over. */
  interface PeekShell {
    rect: PeekRect
    picture: string
    from: string
  }

  /** The animation in the air, so a flight that replaces another can tell whether
   *  it is still the one on screen. */
  let animation: Animation | null = null

  /**
   * Whether a flight is holding the page off screen.
   *
   * The surface decides this rather than deriving it from the phase, because the
   * order matters: the picture of the page has to be taken while the page is still
   * on screen, so the page leaves the screen after that, not the moment the user
   * asks for the flight.
   */
  let holdForFlight = $state(false)

  /**
   * Whether the page is held off screen.
   *
   * A page cannot take part in a flight, so it is never on screen while one is
   * happening: the loading state is what the user watches grow out of the link, and
   * a picture of the page is what flies away with it.
   */
  const holdPage = $derived(!pageOnScreen || holdForFlight)

  /** Whether the surface is in the air, as the panel itself or as the shell that
   *  stands in for it. */
  const flying = $derived(shell !== null || (phase !== null && phase !== 'open'))

  const panelClass = $derived(
    `h-full bg-app origin-top-left ${flying ? 'pointer-events-none' : ''} ${shell ? 'invisible' : ''}`
  )

  /** The shell's box and the transform it opens on, in one style. Both are written
   *  as it appears, so its first frame is already the panel's rectangle. */
  const shellStyle = $derived(
    shell
      ? `left: ${shell.rect.x}px; top: ${shell.rect.y}px; width: ${shell.rect.width}px; height: ${shell.rect.height}px; transform: ${shell.from};`
      : ''
  )

  onMount(() =>
    subscribe('browser:panelShortcut', (tabId, action) => {
      if (tabId === globalBrowser.peekTab?.id && action === 'close-tab') globalBrowser.closePeek()
    })
  )
  // Follow the source page layout even while its native page is parked.
  const bounds = $derived(
    browserVisibility.sourceTabId
      ? browserVisibility.pageBoundsFor(browserVisibility.sourceTabId)
      : null
  )

  async function copyAddress(): Promise<void> {
    const url = tab?.url
    if (!url) return
    try {
      await invoke('clipboard:writeText', url)
    } catch (error: unknown) {
      reportError(error, 'Peek address could not be copied.')
    }
  }

  function rectOf(element: Element | null): PeekRect | null {
    if (!(element instanceof HTMLElement)) return null
    const rect = element.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  }

  /**
   * The row an expansion lands on.
   *
   * Queried rather than handed over, because the strip that draws the row is a
   * different component: whichever of the browser's two surfaces is mounted marks
   * each of its rows with the tab it belongs to. A row the user cannot see, since
   * the strip is collapsed or has scrolled past it, is no target at all, and the
   * expansion lands where it is instead of flying at a rectangle nobody can see.
   */
  function tabRowRect(tabId: string): PeekRect | null {
    for (const row of document.querySelectorAll<HTMLElement>('[data-browser-tab-id]')) {
      if (row.dataset['browserTabId'] !== tabId) continue
      if (row.getClientRects().length === 0) continue
      if (typeof row.checkVisibility === 'function' && !row.checkVisibility()) continue
      return rectOf(row)
    }
    return null
  }

  /**
   * A picture of the peek's page, or null when there is nothing on screen worth
   * carrying.
   *
   * A page that has not painted is a blank view, and a blank rectangle flying out
   * of a link says less than the loading state the user is looking at; a page whose
   * load failed, or one that was never uncovered, has nothing to picture either.
   * All of those fly as the panel itself, which is what keeps the swap between the
   * panel and the shell invisible: the shell only ever appears when it has the
   * page's own pixels to stand in with.
   */
  async function peekPictureFor(
    tabId: string,
    flightPhase: BrowserPeekPhase
  ): Promise<string | null> {
    if (flightPhase === 'opening' || loadError !== null || !pageOnScreen) return null
    try {
      return await invoke('browser:peekSnapshot', tabId)
    } catch {
      // A page that cannot be pictured flies as the panel instead.
      return null
    }
  }

  /** Whether this flight is still the one the store is waiting for. */
  function isCurrent(tabId: string, flightPhase: BrowserPeekPhase): boolean {
    return globalBrowser.peekTab?.id === tabId && globalBrowser.peekPhase === flightPhase
  }

  function land(tabId: string, flightPhase: BrowserPeekPhase): void {
    if (!isCurrent(tabId, flightPhase)) return
    globalBrowser.peekFlightLanded()
  }

  /**
   * Fly the surface for the phase it is in.
   *
   * One WAAPI animation on one element, which is what keeps the whole transition
   * off the main thread: the compositor interpolates a transform and nothing here
   * runs per frame.
   */
  async function playFlight(tabId: string, flightPhase: BrowserPeekPhase): Promise<void> {
    // One tick, so whatever the phase arrived with is on screen before the flight
    // measures it: the row an expansion lands on, and the browser's answer to the
    // page being held. The await is also what keeps the reads below honest, since
    // an effect that tracked them would restart this flight the moment the page
    // painted.
    await tick()
    if (!isCurrent(tabId, flightPhase)) return
    // Whatever was in the air goes first, so the panel is measured where it is laid
    // out rather than where a flight has got to, and the shell (if one is still up)
    // is released before this flight decides what it needs.
    stopFlight()
    if (flightPhase === 'opening') holdForFlight = false
    const panel = rectOf(panelEl)
    if (!panel) {
      // A panel that cannot be measured cannot be flown, but the phase still has to
      // finish: an opening parks the peek, a close drops it, an expansion promotes
      // its tab. Leaving the phase in the air would hold the page off screen for
      // good, or leak the tab.
      land(tabId, flightPhase)
      return
    }
    const picture = await peekPictureFor(tabId, flightPhase)
    if (!isCurrent(tabId, flightPhase)) return
    const flight = peekFlightFor({
      phase: flightPhase,
      pictured: picture !== null,
      origin: globalBrowser.peekOrigin,
      panel,
      target: flightPhase === 'expanding' ? tabRowRect(tabId) : null
    })
    if (!flight) {
      land(tabId, flightPhase)
      return
    }
    if (flightPhase !== 'opening') {
      // Every exit takes the page off screen. The hold is what the surface controls
      // rather than the phase change, because the picture above had to be taken
      // first, and the hide is awaited so the order is certain rather than
      // inferred: a native view is composited above every DOM node, so Electron
      // would draw the page over the very shell that is standing in for it.
      holdForFlight = true
      await invoke('browser:hide', tabId).catch(() => {})
      if (!isCurrent(tabId, flightPhase)) return
    }
    if (picture !== null) launch(panel, flight, picture)
    const running = await fly(flight, picture !== null)
    if (!running || animation !== running) return
    animation = null
    shell = null
    land(tabId, flightPhase)
  }

  /**
   * Stop the flight in the air, if there is one.
   *
   * The shell goes with it: it holds the previous page's picture and keeps the
   * panel hidden, so a flight that does not want it (an opening, which carries the
   * loading state) would otherwise animate a panel nobody can see behind it.
   */
  function stopFlight(): void {
    if (animation === null && shell === null) return
    animation?.cancel()
    animation = null
    shell = null
  }

  /** Put the shell on screen at the panel's rectangle, drawn where the flight
   *  starts, so that the frame in which it appears is already the frame the flight
   *  begins on. */
  function launch(panel: PeekRect, flight: PeekFlight, picture: string): void {
    shell = {
      rect: panel,
      picture,
      from: peekFlightStartTransform(flight)
    }
  }

  /**
   * Run a flight on the element that carries it, resolving with the animation that
   * ended up in the air.
   *
   * The shell, when there is one, is created by the same update that decided the
   * flight, so this waits a tick for it to exist before animating. A flight that is
   * replaced while it runs resolves with itself: the caller compares it with the
   * animation in the air, which is how a superseded flight knows to leave the frames
   * to its successor.
   */
  async function fly(flight: PeekFlight, withShell: boolean): Promise<Animation | null> {
    await tick()
    const element = withShell ? shellEl : panelEl
    if (!element) return null
    animation?.cancel()
    const running = element.animate(peekFlightKeyframes(flight), {
      duration: motionDuration(flight.durationMs),
      easing: flight.easing,
      // The landing frame is what hands the surface over, so it is held until the
      // surface decides what happens next: a flight that snapped back to where its
      // element is laid out would show the panel at full size again for the frames
      // between the animation ending and the peek being taken off screen.
      fill: 'forwards'
    })
    animation = running
    // A cancelled animation rejects, which is what a flight replaced by a newer one
    // does; the caller's comparison is what decides who lands.
    await running.finished.catch(() => undefined)
    return running
  }

  $effect(() => {
    // Only the tab and the phase are tracked, on purpose. An effect that also read
    // the page's own state would restart the flight the moment the page painted,
    // which is exactly what the opening flight is waiting for.
    const tabId = tab?.id
    const flightPhase = phase
    if (!tabId || !flightPhase || flightPhase === 'open') return
    void playFlight(tabId, flightPhase)
    return stopFlight
  })
</script>

{#snippet peekControls()}
  <!-- Both buttons are inert in the shell that flies, which is why the markup lives
       in one place: the shell has to stand in for the panel exactly, and two copies
       would be two things to keep in step. -->
  <div class="flex shrink-0 items-center justify-end gap-1 border-b px-2 py-1">
    <span class="min-w-0 flex-1 truncate text-xs text-text-muted" title={tab?.url}>{tab?.url}</span>
    <button
      type="button"
      class="rounded-md p-2 text-text-muted hover:bg-hover hover:text-text"
      title="Copy current Peek address"
      aria-label="Copy current Peek address"
      disabled={!tab?.url}
      onclick={() => void copyAddress()}><Copy size={16} /></button
    >

    <button
      type="button"
      class="rounded-md p-2 text-text-muted hover:bg-hover hover:text-text"
      title="Expand this Peek into a dedicated tab"
      aria-label="Expand this Peek into a dedicated tab"
      data-modal-primary
      onclick={() => void globalBrowser.expandPeek()}><Maximize2 size={16} /></button
    >
    <button
      type="button"
      class="rounded-md p-2 text-text-muted hover:bg-hover hover:text-text"
      title="Close this Peek"
      aria-label="Close this Peek"
      onclick={() => globalBrowser.closePeek()}><X size={16} /></button
    >
  </div>
{/snippet}

{#if tab && bounds}
  {#key tab.id}
    <Modal
      open
      modal={false}
      {bounds}
      scrim={false}
      closeOnBackdrop={false}
      onCloseAutoFocus={(event) => event.preventDefault()}
      title="Take a Peek"
      chrome={false}
      blocksBrowserView={false}
      trapFocus={false}
      size="full"
      panelWidth="max-w-none"
      {panelClass}
      bind:panelEl
      onClose={() => globalBrowser.closePeek()}
    >
      {@render peekControls()}
      <div class="relative flex min-h-0 flex-1 flex-col">
        {#key tab.id}
          <BrowserWorkspace {tab} surface="peek" {holdPage} />
        {/key}
        {#if holdPage && !loadError}
          <!-- The page is a native view above the DOM, so this is what the user sees
             until it has painted: the surface holds the view off screen and draws
             the wait in the rectangle the page is about to take. -->
          <div class="pointer-events-none absolute inset-0">
            <BrowserPeekLoading url={tab.url} />
          </div>
        {/if}
      </div>
    </Modal>
  {/key}
  {#if shell}
    <Portal>
      <!-- Portaled for the same reason the modal is: the shell flies over the modal
           layer, and a stacking context anywhere between here and the body would
           trap it behind the very surface it is replacing. -->
      <div
        {@attach attachShell}
        inert
        aria-hidden="true"
        class="pointer-events-none fixed z-70 flex flex-col origin-top-left overflow-hidden rounded-2xl border bg-app shadow-xl will-change-transform"
        style={shellStyle}
      >
        {@render peekControls()}
        <div class="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <img src={shell.picture} alt="" class="h-full w-full object-cover" draggable="false" />
        </div>
      </div>
    </Portal>
  {/if}
{/if}
