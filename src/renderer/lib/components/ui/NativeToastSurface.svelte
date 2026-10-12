<script lang="ts">
  import { toast, type ExternalToast } from 'svelte-sonner'
  import { onMount, tick } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { logRendererDev } from '$lib/system/renderer-logger'
  import type {
    ToastOverlayInteraction,
    ToastOverlayRequestStack,
    ToastOverlayToast
  } from '$shared/browser-overlay'
  import ToastStack from './ToastStack.svelte'
  let theme = $state<'light' | 'dark'>('light')
  let stack: ToastOverlayRequestStack | null = null
  const drawn = new SvelteMap<string, { id: number | string; signature: string }>()
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
    void invoke('browser:overlayInteract', { id, interaction }).catch(() => {})
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
        ? {
            label: entry.action.label,
            onClick: (event) => {
              event.preventDefault()
              report(entry.id, 'action')
            }
          }
        : undefined,
      cancel: entry.cancel
        ? {
            label: entry.cancel.label,
            onClick: (event) => {
              event.preventDefault()
              report(entry.id, 'cancel')
            }
          }
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

  function applyStack(next: ToastOverlayRequestStack | null): void {
    stack = next
    if (next === null) {
      for (const [key, entry] of drawn) {
        drawn.delete(key)
        toast.dismiss(entry.id)
      }
      void tick().then(afterDraw)
      return
    }
    theme = next.theme
    document.documentElement.classList.toggle('dark', next.theme === 'dark')
    if (next.typography) {
      document.documentElement.style.setProperty('--font-app', next.typography.fontFamily)
      document.documentElement.style.fontSize = `${next.typography.fontSize}px`
      document.documentElement.style.fontWeight = String(next.typography.fontWeight)
    }
    const incoming = new Set(next.toasts.map((entry) => keyOf(entry.id)))
    for (const [key, entry] of drawn) {
      if (incoming.has(key)) continue
      drawn.delete(key)
      toast.dismiss(entry.id)
    }
    // Oldest first: svelte-sonner unshifts every new toast to the front, so
    // replaying the stack backwards lands the newest card on top of the stack,
    // in the order the app window has it.
    for (const entry of [...next.toasts].reverse()) {
      const existing = drawn.get(keyOf(entry.id))
      if (existing?.signature === signatureOf(entry)) continue
      draw(entry)
    }
    void tick().then(afterDraw)
  }

  let frame = 0
  let previousHeight = -1
  function measure(): void {
    frame = 0
    const cards = [
      ...document.querySelectorAll<HTMLElement>('[data-sonner-toast][data-visible="true"]')
    ]
    const height = cards.length
      ? Math.ceil(cards.reduce((sum, card) => sum + card.offsetHeight + 14, 0) + 32)
      : 0
    if (height === previousHeight) return
    previousHeight = height
    void invoke('browser:toastOverlayHeight', height).catch(() => {})
  }
  function scheduleMeasure(): void {
    if (!frame) frame = requestAnimationFrame(measure)
  }
  function afterDraw(): void {
    cancelAnimationFrame(frame)
    measure()
    if (stack)
      void invoke('browser:overlayDrawn', {
        revision: stack.revision,
        drawn: [...drawn.values()].map((entry) => entry.id)
      }).catch(() => {})
  }
  onMount(() => {
    const off = subscribe('browser:overlay:stack', applyStack)
    const resize = new ResizeObserver(scheduleMeasure)
    const observeCards = (): void => {
      resize.disconnect()
      for (const card of document.querySelectorAll('[data-sonner-toast]')) resize.observe(card)
      scheduleMeasure()
    }
    const changes = new MutationObserver(observeCards)
    changes.observe(document.body, { childList: true, subtree: true })
    void invoke('browser:overlayReady')
      .then((snapshot) => applyStack(snapshot.stack))
      .catch(() => {})
    return () => {
      off()
      resize.disconnect()
      changes.disconnect()
      cancelAnimationFrame(frame)
    }
  })
</script>

<ToastStack {theme} offsetTop={16} native />
