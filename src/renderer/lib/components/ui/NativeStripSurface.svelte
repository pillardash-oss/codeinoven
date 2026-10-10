<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { fly } from 'svelte/transition'
  import { prefersReducedMotion } from 'svelte/motion'
  import type { NativeDockRequest } from '$shared/native-dock'
  import BrowserOverlayDock from './BrowserOverlayDock.svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import type { BrowserStripOverlayRequest } from '$shared/browser-overlay'
  import BrowserOverlayStrip from './BrowserOverlayStrip.svelte'
  import TooltipHost from './TooltipHost.svelte'

  let strip = $state.raw<BrowserStripOverlayRequest | null>(null)
  /** The strip's top edge in the app window's own content space. This view is a
   *  bounded window already parked at that edge, so the panel draws from zero and
   *  only the control points it reports back need the original offset. */
  let stripOrigin = 0
  function apply(next: BrowserStripOverlayRequest | null): void {
    if (next?.revision === strip?.revision) return
    stripOrigin = next?.top ?? 0
    strip = next ? { ...next, top: 0 } : null
    if (!next) return
    document.documentElement.classList.toggle('dark', next.theme === 'dark')
    void tick().then(() => {
      if (strip?.revision === next.revision)
        void invoke('browser:overlayDrawn', { stripRevision: next.revision }).catch(() => {})
    })
  }
  let dock = $state.raw<NativeDockRequest | null>(null)
  function applyDocks(next: NativeDockRequest[]): void {
    const incoming = next[0]
    if (!incoming) {
      dock = null
      return
    }
    if (incoming.revision === dock?.revision) return
    const typography = incoming.typography
    const root = document.documentElement
    root.classList.toggle('dark', incoming.theme === 'dark')
    if (typography) {
      root.style.setProperty('--font-app', typography.fontFamily)
      root.style.fontSize = `${typography.fontSize}px`
      root.style.fontWeight = String(typography.fontWeight)
    }
    // Only the outer coordinate space changes. Every group, row, control and
    // scroll container below it comes from the canonical sidebar unchanged.
    const nodes = incoming.nodes.map((node, index) =>
      typeof node === 'string' || index !== 0
        ? node
        : {
            ...node,
            attributes: {
              ...node.attributes,
              class: 'flex h-full w-full flex-col bg-surface shadow-2xl',
              style: `width: ${incoming.bounds.width}px; height: ${incoming.bounds.height}px`
            }
          }
    )
    dock = { ...incoming, nodes, bounds: { ...incoming.bounds, x: 0, y: 0 } }
  }
  onMount(() => {
    const off = subscribe('browser:overlay:strip', apply)
    const offDocks = subscribe('browser:overlay:docks', applyDocks)
    void invoke('browser:overlayReady')
      .then((snapshot) => {
        apply(snapshot.strip)
        applyDocks(snapshot.docks)
      })
      .catch(() => {})
    return () => {
      off()
      offDocks()
    }
  })
</script>

<!--
  The pointer is measured in the main process against this host's own rectangle,
  not reported from here. A view attached under a cursor that never moved gets no
  enter event, and the leave Chromium synthesises for the surface it replaced
  reads as the pointer walking away, which closed the panel the moment it
  arrived. `NativeStripView.reportPointer` owns that answer now.
-->
{#if dock}
  <div
    data-overlay-strip
    class="absolute inset-0"
    transition:fly={{ x: -16, duration: prefersReducedMotion.current ? 0 : 140 }}
  >
    <BrowserOverlayDock {dock} onDragging={() => {}} />
  </div>
{:else if strip}
  <BrowserOverlayStrip
    {strip}
    onSelect={(tabId) => {
      void invoke('browser:overlayStripInteract', { kind: 'select', tabId })
    }}
    onClose={(tabId) => {
      void invoke('browser:overlayStripInteract', { kind: 'close', tabId })
    }}
    onAction={(action, x, y) => {
      void invoke('browser:overlayStripInteract', {
        kind: 'action',
        action,
        x,
        y: y + stripOrigin
      })
    }}
  />
{/if}
<TooltipHost nativeOverlay={false} />
