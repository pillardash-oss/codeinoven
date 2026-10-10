<script lang="ts">
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { onMount, tick } from 'svelte'
  import { logRendererDev } from '$lib/system/renderer-logger'
  import {
    type BrowserStatusOverlay,
    type BrowserStripOverlayInteraction,
    type BrowserStripOverlayRequest
  } from '$shared/browser-overlay'
  import type { NativeDockRequest } from '$shared/native-dock'
  import BrowserOverlayDock from './BrowserOverlayDock.svelte'
  import TooltipHost from './TooltipHost.svelte'
  import BrowserOverlayStrip from './BrowserOverlayStrip.svelte'
  import BrowserOverlayStatus from './BrowserOverlayStatus.svelte'

  /**
   * The browser overlay's document: the app's toaster, and the browser's floating
   * tab strip, drawn in a window of their own over a browser page.
   *
   * Both regions are owned by the app renderer, so this document holds no state
   * of its own beyond what it is drawing. It rebuilds the cards in its own
   * svelte-sonner instance from the projected stack, draws the strip from the
   * projected tabs, and every interaction is reported back rather than handled
   * here: the handlers belong to state this window cannot see. Reporting back is
   * also what the app renderer waits to hear before it trusts this window with
   * either region at all, so the confirmation below is sent once what it drew is
   * actually in the DOM.
   *
   * Cards are only re-applied when they actually changed. svelte-sonner resets a
   * card's auto-close timer on every update, so replaying the whole stack on each
   * publish would keep extending the life of the cards that did not change.
   */

  let docks = $state.raw<NativeDockRequest[]>([])
  let dockDragging = false

  function applyDocks(next: NativeDockRequest[]): void {
    docks = next.map(
      (incoming) =>
        docks.find(
          (current) => current.id === incoming.id && current.revision === incoming.revision
        ) ?? incoming
    )
    const theme = next.at(-1)?.theme
    if (theme) document.documentElement.classList.toggle('dark', theme === 'dark')
    const typography = next.at(-1)?.typography
    if (typography) {
      const root = document.documentElement
      root.style.setProperty('--font-app', typography.fontFamily)
      root.style.fontSize = `${typography.fontSize}px`
      root.style.fontWeight = String(typography.fontWeight)
    }
    void tick().then(afterDraw)
  }

  /** The floating tab strip on display, or null while none is. */
  let strip = $state<BrowserStripOverlayRequest | null>(null)

  /** The link preview on display, or null while none is. */
  let status = $state<BrowserStatusOverlay | null>(null)

  /** Whether the pointer is inside anything this window draws, which is what
   *  decides whether it swallows a click or passes it to the page below. */
  let pointerOverContent = false
  /** Whether the pointer is inside the strip's own rectangle. Reported to the app
   *  renderer on its own, because that is what opens and closes the floating
   *  panel while this window is the one drawing it. */
  let pointerOverStrip = false
  let pointer = { x: 0, y: 0, known: false }

  /**
   * Bumped by every pointer event this document sees.
   *
   * The cursor position is read from the window server through an IPC round
   * trip, so an answer can land after a newer pointer event has already been
   * processed. One that was overtaken is dropped: the newer event describes a
   * later moment than the answer does.
   */
  let pointerEpoch = 0

  /** Report one thing the user did to the strip, or where the pointer is in it. */
  function reportStrip(interaction: BrowserStripOverlayInteraction): void {
    // Presses are logged for the same reason the cards' presses are: a row or a
    // control that seems to do nothing is the case worth having a record of.
    if (interaction.kind === 'select' || interaction.kind === 'close') {
      logRendererDev(
        `The browser overlay reported a ${interaction.kind} press on tab ${interaction.tabId}`
      )
    } else if (interaction.kind === 'action') {
      logRendererDev(`The browser overlay reported a ${interaction.action} press`)
    }
    void invoke('browser:overlayStripInteract', interaction).catch(() => {})
  }

  function applyStatus(next: BrowserStatusOverlay | null): void {
    status = next
  }

  function applyStrip(next: BrowserStripOverlayRequest | null): void {
    // Re-applying the revision already on screen says nothing new, and redrawing
    // the same rows would only churn the panel the pointer is standing in.
    if (next !== null && strip !== null && strip.revision === next.revision) return
    strip = next
    if (next !== null) {
      document.documentElement.classList.toggle('dark', next.theme === 'dark')
    }
    void tick().then(afterDraw)
  }

  /**
   * Settle everything that follows a change to what this document draws.
   *
   * A region can appear or leave under a stationary pointer, which decides
   * whether this window may keep swallowing clicks where it now sits. The app
   * window also resets its own copy of that answer every time it shows this
   * window, so this document forgets its copy with it and asserts the truth
   * again; otherwise a belief that still holds here would be left unreported and
   * the content would be unpressable.
   */
  function afterDraw(): void {
    pointerOverContent = false
    setPointerWatch(strip !== null || docks.some((dock) => !dock.passive))
    syncPointerFromCursor(true)
  }

  /** Whether a point is inside the strip's own rectangle. The strip is one opaque
   *  panel, so its whole box swallows clicks, padding included. */
  function overStrip(x: number, y: number): boolean {
    const element = document.querySelector('[data-overlay-strip]')
    if (!element) return false
    const rect = element.getBoundingClientRect()
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  }

  function reportPointer(force = false): void {
    if (!pointer.known) return
    const overDock = [
      ...document.querySelectorAll('[data-native-overlay-dock]:not([data-native-overlay-passive])')
    ].some((element) => {
      const rect = element.getBoundingClientRect()
      return (
        pointer.x >= rect.left &&
        pointer.x <= rect.right &&
        pointer.y >= rect.top &&
        pointer.y <= rect.bottom
      )
    })
    const over = dockDragging || overDock || overStrip(pointer.x, pointer.y)
    if (!force && over === pointerOverContent) return
    pointerOverContent = over
    void invoke('browser:overlayPointer', over).catch(() => {})
  }

  /** Report the pointer entering or leaving the strip, but only on a change: the
   *  app renderer closes the floating panel when it leaves. */
  function reportStripPointer(force = false): void {
    if (!pointer.known) return
    const over = strip !== null && overStrip(pointer.x, pointer.y)
    if (!force && over === pointerOverStrip) return
    pointerOverStrip = over
    reportStrip({ kind: 'pointer', over })
  }

  /**
   * How often the hover state is re-derived from the cursor while there is
   * something to press.
   *
   * The safety net under every other input to it. Content enters with a
   * transition, so its rectangle is still moving when it is first drawn and a
   * check made at that instant reads it as somewhere else; the window server
   * re-evaluates the window under the pointer every time the click-through state
   * changes and answers with an event that reads as a departure; and a card or a
   * panel can appear, leave and be replaced with no pointer event at all. None of
   * that can be reasoned away from the events, and all of it is settled by
   * asking, so it is asked on a slow beat for exactly as long as there is
   * something to press: which is nothing next to drawing it, and the price of a
   * control that always answers.
   */
  const POINTER_WATCH_INTERVAL_MS = 120

  let pointerWatch: ReturnType<typeof setInterval> | undefined

  /** Watch the pointer while there is something to press, and only then. */
  function setPointerWatch(active: boolean): void {
    if (active) {
      pointerWatch ??= setInterval(syncPointerFromCursor, POINTER_WATCH_INTERVAL_MS)
      return
    }
    if (pointerWatch !== undefined) clearInterval(pointerWatch)
    pointerWatch = undefined
  }

  /**
   * Settle the hover state from where the window server says the pointer is.
   *
   * This is the answer to a problem the events cannot solve. Content that appears
   * or leaves under a stationary pointer produces no pointer event at all, and
   * the events this window does get are not trustworthy either: the window
   * ignores the mouse until something is under the pointer, and lifting that is
   * what makes the window server re-evaluate the window under the pointer and
   * send back a mouseout that reads exactly like the pointer having left. That is
   * what put a card the user was pressing back into click-through, so the press
   * landed on the page underneath and its button did nothing.
   *
   * The report is forced when what is drawn changes, because the app window
   * resets its own copies of both answers whenever it shows or hides this window:
   * a state that did not change from this document's point of view still has to
   * be asserted, or the two sides stay disagreeing and the control stays
   * unpressable. The watch that runs while content is on screen reports only a
   * change, which is all it can ever have to say.
   */
  function syncPointerFromCursor(force = false): void {
    const epoch = pointerEpoch
    void invoke('browser:overlayCursor')
      .then((cursor) => {
        if (!cursor || epoch !== pointerEpoch) return
        pointer = { x: cursor.x, y: cursor.y, known: true }
        reportPointer(force)
        reportStripPointer(force)
      })
      .catch(() => {})
  }

  function trackPointer(event: MouseEvent): void {
    pointerEpoch += 1
    pointer = { x: event.clientX, y: event.clientY, known: true }
    reportPointer()
    reportStripPointer()
  }

  /**
   * A pointer event that claims the pointer left this document.
   *
   * Not believed on its own: every time the app window lifts click-through the
   * window server re-evaluates the window under the pointer and sends a mouseout
   * with no related target, in the middle of what is being pressed. The cursor
   * decides instead, so a real departure still arms click-through and a phantom
   * one does not disarm the control the pointer is on.
   */
  function leaveDocument(event: MouseEvent): void {
    if (event.relatedTarget !== null) return
    pointerEpoch += 1
    syncPointerFromCursor()
  }

  onMount(() => {
    const unsubscribeDocks = subscribe('browser:overlay:docks', applyDocks)
    const unsubscribeStrip = subscribe('browser:overlay:strip', (next) => applyStrip(next))
    const unsubscribeStatus = subscribe('browser:overlay:status', (next) => applyStatus(next))
    // First delivery is a pull, exactly as the permission popup does it: a push
    // straight after `loadURL` loses the race against these subscriptions.
    void invoke('browser:overlayReady')
      .then((snapshot) => {
        applyDocks(snapshot.docks)
        if (snapshot.strip) applyStrip(snapshot.strip)
        applyStatus(snapshot.status)
      })
      .catch(() => {})
    window.addEventListener('mousemove', trackPointer)
    document.addEventListener('mouseout', leaveDocument)
    return () => {
      setPointerWatch(false)
      unsubscribeDocks()
      unsubscribeStrip()
      unsubscribeStatus()
      window.removeEventListener('mousemove', trackPointer)
      document.removeEventListener('mouseout', leaveDocument)
    }
  })
</script>

{#if status}
  <BrowserOverlayStatus {status} />
{/if}

{#if strip}
  <BrowserOverlayStrip
    {strip}
    onSelect={(tabId) => reportStrip({ kind: 'select', tabId })}
    onClose={(tabId) => reportStrip({ kind: 'close', tabId })}
    onAction={(action, x, y) => reportStrip({ kind: 'action', action, x, y })}
  />
{/if}

{#each docks as dock (dock.id)}
  <BrowserOverlayDock
    {dock}
    onDragging={(active) => {
      dockDragging = active
      reportPointer(true)
    }}
  />
{/each}

<TooltipHost nativeOverlay={false} />
