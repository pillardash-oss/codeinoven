<script lang="ts">
  import CioArrowLeft from '@pdslng/cio-icon/CioArrowLeft.svelte'
  import CioDisplay from '@pdslng/cio-icon/CioDisplay.svelte'
  import CioHome from '@pdslng/cio-icon/CioHome.svelte'
  import CioLayers from '@pdslng/cio-icon/CioLayers.svelte'
  import CioLock from '@pdslng/cio-icon/CioLock.svelte'
  import CioMinimize from '@pdslng/cio-icon/CioMinimize.svelte'
  import CioMoon from '@pdslng/cio-icon/CioMoon.svelte'
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import type { Component } from 'svelte'
  import type { DisplayContextTab } from '$lib/stores/context-sidebar.svelte'
  import { onMount } from 'svelte'
  import type { DisplayControlAction } from '$shared/ipc/display'
  import { DISPLAY_CONTROLS_BY_KIND } from '$shared/ipc/display'
  import { displayPanel } from '$lib/stores/display-panel.svelte'
  import CioVolumeDown from '$lib/components/icons/cio/CioVolumeDown.svelte'
  import CioVolumeUp from '$lib/components/icons/cio/CioVolumeUp.svelte'

  /**
   * One target's live preview, with that target's own controls beside it.
   *
   * Two things matter here and nothing else: the frame fills the space at its own
   * aspect ratio, and the stage tells main how large it is so the capture is sized
   * to what is painted instead of to a guess (the dock is user-resizable).
   *
   * The rail is vertical and sits where a device's buttons sit in the hand: the
   * targets that answer to hardware keys get those keys, and a target with no
   * buttons (a screen, a window) gets only the scale controls. This is what makes
   * the panel a viewer of a running emulator rather than a picture of one.
   */

  interface Props {
    tab: DisplayContextTab
  }

  let { tab }: Props = $props()

  interface RailControl {
    action: DisplayControlAction
    label: string
    icon: Component
  }

  /** Each hardware key the panel offers, drawn from the device's own set. */
  const RAIL_CONTROLS: Record<DisplayControlAction, RailControl> = {
    home: { action: 'home', label: 'Home', icon: CioHome },
    back: { action: 'back', label: 'Back', icon: CioArrowLeft },
    recents: { action: 'recents', label: 'Recent apps', icon: CioLayers },
    'volume-up': { action: 'volume-up', label: 'Volume up', icon: CioVolumeUp },
    'volume-down': { action: 'volume-down', label: 'Volume down', icon: CioVolumeDown },
    power: { action: 'power', label: 'Power', icon: CioLock },
    appearance: { action: 'appearance', label: 'Switch light and dark', icon: CioMoon }
  }

  let stage = $state<HTMLDivElement | null>(null)
  let zoom = $state<'fit' | 'actual'>('fit')

  const kind = $derived(tab.sourceKind)
  const sourceId = $derived(tab.sourceId)
  const session = $derived(displayPanel.sessionFor(tab.id))
  const frame = $derived(session?.frame ?? null)
  const status = $derived(
    session?.phase === 'failed' || session?.phase === 'retrying' ? session.phase : null
  )
  const controls = $derived.by((): RailControl[] =>
    kind ? DISPLAY_CONTROLS_BY_KIND[kind].map((action) => RAIL_CONTROLS[action]) : []
  )

  // A stage owns one capture for exactly as long as it is mounted: mounting starts
  // the target, unmounting (a tab switch, a folded dock, fullscreen taking over)
  // stops it. The body is keyed by the target upstream, so a retarget remounts
  // this component instead of retargeting a running capture in place.
  //
  // Nothing here is an effect: mounting is the event, and the only ongoing work is
  // one ResizeObserver on this stage, which reports the painted size so the
  // capture is never larger than what the panel shows.
  onMount(() => {
    const handle = stage
    if (!handle || !kind || !sourceId) return
    const tabId = tab.id
    // The session this mount owns: a cleanup must never stop the capture that a
    // replacement stage (the dock's, on the way back from fullscreen) just began.
    const sessionId = displayPanel.start(tabId, kind, sourceId)
    displayPanel.setVisibleTab(tabId)
    const report = (): void => {
      const rect = handle.getBoundingClientRect()
      const longest = Math.max(rect.width, rect.height)
      if (longest <= 0) return
      displayPanel.reportStageSize(tabId, Math.round(longest * (window.devicePixelRatio || 1)))
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(handle)
    return () => {
      observer.disconnect()
      displayPanel.releaseVisibleTab(tabId)
      displayPanel.stop(tabId, sessionId)
    }
  })
</script>

<div class="flex h-full min-h-0">
  <div
    bind:this={stage}
    class="relative flex min-w-0 flex-1 items-center justify-center overflow-auto bg-app"
    data-display-stage={kind ?? 'none'}
  >
    {#if frame}
      <img
        src={frame.dataUrl}
        alt={`Live preview of ${tab.title}`}
        class={zoom === 'fit' ? 'max-h-full max-w-full object-contain' : 'max-w-none shrink-0'}
        style={zoom === 'actual' ? `width:${frame.width}px;height:${frame.height}px` : undefined}
      />
    {:else}
      <p class="px-4 text-center text-[0.625rem] leading-relaxed text-dimmed" role="status">
        {session?.phase === 'failed'
          ? 'This target could not be read.'
          : 'Waiting for the first frame…'}
      </p>
    {/if}

    {#if status}
      <div
        class="absolute inset-x-0 bottom-0 flex items-start gap-1.5 bg-surface/95 px-2 py-1"
        role="status"
      >
        <CioDisplay size={12} class="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
        <p class="min-w-0 text-[0.625rem] leading-relaxed text-muted">
          {status === 'failed' ? 'Stopped' : 'Retrying'}{session?.detail
            ? `: ${session.detail}`
            : '.'}
        </p>
      </div>
    {/if}
  </div>

  <div
    class="flex w-8 shrink-0 flex-col items-center gap-0.5 border-l border-border bg-surface py-1"
    role="toolbar"
    aria-label={`${tab.title} controls`}
    aria-orientation="vertical"
  >
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center transition-colors {zoom === 'fit'
        ? 'bg-elevated text-foreground'
        : 'text-dimmed hover:bg-elevated hover:text-foreground'}"
      aria-pressed={zoom === 'fit'}
      aria-label="Fit the preview to the panel"
      title="Fit the preview to the panel"
      onclick={() => (zoom = 'fit')}
    >
      <CioMinimize size={13} />
    </button>
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center transition-colors {zoom === 'actual'
        ? 'bg-elevated text-foreground'
        : 'text-dimmed hover:bg-elevated hover:text-foreground'}"
      aria-pressed={zoom === 'actual'}
      aria-label="Show the preview at its captured size"
      title="Show the preview at its captured size"
      onclick={() => (zoom = 'actual')}
    >
      <CioMaximize size={13} />
    </button>
    {#if controls.length > 0}
      <div class="my-0.5 h-px w-4 bg-border" aria-hidden="true"></div>
      {#each controls as control (control.action)}
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          aria-label={control.label}
          title={control.label}
          onclick={() => displayPanel.control(tab.id, control.action)}
        >
          <control.icon size={13} />
        </button>
      {/each}
    {/if}
  </div>
</div>
