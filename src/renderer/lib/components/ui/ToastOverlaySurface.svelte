<script lang="ts">
  import { toast } from 'svelte-sonner'
  import type { ExternalToast } from 'svelte-sonner'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { onMount, tick } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import { logRendererDev } from '$lib/system/renderer-logger'
  import {
    TOAST_OVERLAY_INNER_TOP,
    type ToastOverlayInteraction,
    type ToastOverlayRequestStack,
    type ToastOverlayToast
  } from '$shared/toast-overlay'
  import ToastStack from './ToastStack.svelte'

  /**
   * The toast overlay's document: the app's toaster, drawn in a window of its
   * own over a browser page.
   *
   * The stack is owned by the app renderer, so this document holds no state of
   * its own beyond what it is drawing. It rebuilds the cards in its own
   * svelte-sonner instance from the projected stack, and every interaction is
   * reported back rather than handled here: the handlers belong to toasts this
   * window cannot see. Reporting back is also what the app renderer waits to
   * hear before it trusts this window with the stack at all, so the confirmation
   * below is sent once the cards are actually in the DOM.
   *
   * Cards are only re-applied when they actually changed. svelte-sonner resets a
   * card's auto-close timer on every update, so replaying the whole stack on each
   * publish would keep extending the life of the cards that did not change.
   */

  let theme = $state<'light' | 'dark'>('light')

  /** What this document is drawing: the toast's own id, and a signature of the
   *  card as it was drawn, so an unchanged card is never re-applied. */
  const drawn = new SvelteMap<string, { id: number | string; signature: string }>()

  let pointerOverCard = false
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

  function keyOf(id: number | string): string {
    return String(id)
  }

  function signatureOf(entry: ToastOverlayToast): string {
    return [
      entry.kind,
      entry.title,
      entry.description ?? '',
      entry.duration ?? '',
      entry.style ?? '',
      entry.closeButton === true ? '1' : '0',
      entry.dismissible === false ? '0' : '1',
      entry.action?.label ?? '',
      entry.cancel?.label ?? ''
    ].join('\u0000')
  }

  function report(id: number | string, interaction: ToastOverlayInteraction): void {
    // A press is logged on its way out, and only a press: whether it reached this
    // document at all is the one fact nothing else here can answer, and a card
    // whose button seems to do nothing is exactly the case where that matters.
    // Dismissals and auto-closes stay silent, because they are not user
    // intentions and there is one of them per toast either way.
    if (interaction === 'action' || interaction === 'cancel') {
      logRendererDev(`The toast overlay reported a ${interaction} press on card ${String(id)}`)
    }
    void invoke('browser:toastOverlayInteract', { id, interaction }).catch(() => {})
  }

  /**
   * Confirm that a stack is drawn, naming the revision it was published under.
   *
   * A card here has no handler of its own: pressing one only works while this
   * window can reach the app renderer that owns it. This is that proof, and the
   * app renderer holds the cards in its own toaster until it arrives, so it is
   * sent after the draw rather than with the request.
   */
  function reportDrawn(stack: ToastOverlayRequestStack): void {
    const ack = { revision: stack.revision, drawn: [...drawn.values()].map((entry) => entry.id) }
    if (ack.drawn.length === 0) return
    void invoke('browser:toastOverlayDrawn', ack).catch(() => {})
  }

  function optionsFor(entry: ToastOverlayToast): ExternalToast {
    return {
      id: entry.id,
      description: entry.description,
      duration: entry.duration,
      style: entry.style,
      closeButton: entry.closeButton,
      dismissible: entry.dismissible,
      action: entry.action
        ? { label: entry.action.label, onClick: () => report(entry.id, 'action') }
        : undefined,
      cancel: entry.cancel
        ? { label: entry.cancel.label, onClick: () => report(entry.id, 'cancel') }
        : undefined,
      onDismiss: () => report(entry.id, 'dismiss'),
      onAutoClose: () => report(entry.id, 'autoclose')
    }
  }

  /** Raise (or update) one card in this document's own toaster. */
  function draw(entry: ToastOverlayToast): void {
    const options = optionsFor(entry)
    switch (entry.kind) {
      case 'success':
        toast.success(entry.title, options)
        break
      case 'error':
        toast.error(entry.title, options)
        break
      case 'warning':
        toast.warning(entry.title, options)
        break
      case 'info':
        toast.info(entry.title, options)
        break
      case 'loading':
        toast.loading(entry.title, options)
        break
      default:
        toast.message(entry.title, options)
    }
    drawn.set(keyOf(entry.id), { id: entry.id, signature: signatureOf(entry) })
  }

  function applyStack(stack: ToastOverlayRequestStack): void {
    theme = stack.theme
    document.documentElement.classList.toggle('dark', stack.theme === 'dark')
    const incoming = new Set(stack.toasts.map((entry) => keyOf(entry.id)))
    for (const [key, entry] of drawn) {
      if (incoming.has(key)) continue
      drawn.delete(key)
      toast.dismiss(entry.id)
    }
    // Oldest first: svelte-sonner unshifts every new toast to the front, so
    // replaying the stack backwards lands the newest card on top of the stack,
    // in the order the app window has it.
    for (const entry of [...stack.toasts].reverse()) {
      const existing = drawn.get(keyOf(entry.id))
      if (existing?.signature === signatureOf(entry)) continue
      draw(entry)
    }
    // A card can appear or leave under a stationary pointer, which decides
    // whether this window may keep swallowing clicks where it now sits. The app
    // window also resets its own copy of that answer every time it shows this
    // window, so this document forgets its copy with it and asserts the truth
    // again; otherwise a belief that still holds here would be left unreported
    // and the card would be unpressable.
    void tick().then(() => {
      pointerOverCard = false
      setPointerWatch(stack.toasts.length > 0)
      syncPointerFromCursor(true)
      reportDrawn(stack)
    })
  }

  /** Whether a point is inside a card, measured rather than hit-tested: the
   *  toaster's own box does not take pointer events, so `elementFromPoint` would
   *  report the page beneath a card. */
  function overCard(x: number, y: number): boolean {
    for (const card of document.querySelectorAll('[data-sonner-toast]')) {
      const rect = card.getBoundingClientRect()
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true
    }
    return false
  }

  function reportPointer(force = false): void {
    if (!pointer.known) return
    const over = overCard(pointer.x, pointer.y)
    if (!force && over === pointerOverCard) return
    pointerOverCard = over
    void invoke('browser:toastOverlayPointer', over).catch(() => {})
  }

  /**
   * How often the hover state is re-derived from the cursor while cards are on
   * screen.
   *
   * The safety net under every other input to it. A card enters with a
   * transition, so its rectangle is still moving when it is first drawn and a
   * check made at that instant reads the card as somewhere else; the window
   * server re-evaluates the window under the pointer every time the click-through
   * state changes and answers with an event that reads as a departure; and a card
   * can appear, leave and be replaced with no pointer event at all. None of that
   * can be reasoned away from the events, and all of it is settled by asking, so
   * it is asked on a slow beat for exactly as long as there is a card to press:
   * which is nothing next to drawing the card itself, and the price of a button
   * that always answers.
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
   * This is the answer to a problem the events cannot solve. A card that appears
   * or leaves under a stationary pointer produces no pointer event at all, and
   * the events this window does get are not trustworthy either: the window
   * ignores the mouse until a card is under the pointer, and lifting that is
   * what makes the window server re-evaluate the window under the pointer and
   * send back a mouseout that reads exactly like the pointer having left. That
   * is what put a card the user was pressing back into click-through, so the
   * press landed on the page underneath and its button did nothing.
   *
   * The report is forced when the stack changes, because the app window resets its
   * own copy of the state whenever it shows or hides this window: a state that did
   * not change from this document's point of view still has to be asserted, or the
   * two sides stay disagreeing and the card stays unpressable. The watch that runs
   * while cards are on screen reports only a change, which is all it can ever have
   * to say.
   */
  function syncPointerFromCursor(force = false): void {
    const epoch = pointerEpoch
    void invoke('browser:toastOverlayCursor')
      .then((cursor) => {
        if (!cursor || epoch !== pointerEpoch) return
        pointer = { x: cursor.x, y: cursor.y, known: true }
        reportPointer(force)
      })
      .catch(() => {})
  }

  function trackPointer(event: MouseEvent): void {
    pointerEpoch += 1
    pointer = { x: event.clientX, y: event.clientY, known: true }
    reportPointer()
  }

  /**
   * A pointer event that claims the pointer left this document.
   *
   * Not believed on its own: every time the app window lifts click-through the
   * window server re-evaluates the window under the pointer and sends a mouseout
   * with no related target, in the middle of a card. The cursor decides instead,
   * so a real departure still arms click-through and a phantom one does not
   * disarm the card the pointer is on.
   */
  function leaveDocument(event: MouseEvent): void {
    if (event.relatedTarget !== null) return
    pointerEpoch += 1
    syncPointerFromCursor()
  }

  onMount(() => {
    const unsubscribe = subscribe('browser:toastOverlay:stack', (stack) => applyStack(stack))
    // First delivery is a pull, exactly as the permission popup does it: a push
    // straight after `loadURL` loses the race against this subscription.
    void invoke('browser:toastOverlayReady')
      .then((stack) => {
        if (stack) applyStack(stack)
      })
      .catch(() => {})
    window.addEventListener('mousemove', trackPointer)
    document.addEventListener('mouseout', leaveDocument)
    return () => {
      setPointerWatch(false)
      unsubscribe()
      window.removeEventListener('mousemove', trackPointer)
      document.removeEventListener('mouseout', leaveDocument)
    }
  })
</script>

<ToastStack {theme} offsetTop={TOAST_OVERLAY_INNER_TOP} />
