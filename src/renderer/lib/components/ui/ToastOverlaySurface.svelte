<script lang="ts">
  import { toast } from 'svelte-sonner'
  import type { ExternalToast } from 'svelte-sonner'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { onMount, tick } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import {
    TOAST_OVERLAY_INNER_TOP,
    type ToastOverlayInteraction,
    type ToastOverlayStack,
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
   * window cannot see.
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
    void invoke('browser:toastOverlayInteract', { id, interaction }).catch(() => {})
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

  function applyStack(stack: ToastOverlayStack): void {
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
    // whether this window may keep swallowing clicks where it now sits.
    void tick().then(() => reportPointer())
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

  function reportPointer(): void {
    if (!pointer.known) return
    const over = overCard(pointer.x, pointer.y)
    if (over === pointerOverCard) return
    pointerOverCard = over
    void invoke('browser:toastOverlayPointer', over).catch(() => {})
  }

  function trackPointer(event: MouseEvent): void {
    pointer = { x: event.clientX, y: event.clientY, known: true }
    reportPointer()
  }

  /** Leaving the document leaves the cards behind, so a click belongs to the
   *  page again even though no further move will arrive inside this window. */
  function leaveDocument(event: MouseEvent): void {
    if (event.relatedTarget !== null) return
    pointer = { x: -1, y: -1, known: true }
    reportPointer()
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
      unsubscribe()
      window.removeEventListener('mousemove', trackPointer)
      document.removeEventListener('mouseout', leaveDocument)
    }
  })
</script>

<ToastStack {theme} offsetTop={TOAST_OVERLAY_INNER_TOP} />
