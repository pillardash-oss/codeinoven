<script lang="ts">
  import CioArrowLeft from '@pdslng/cio-icon/CioArrowLeft.svelte'
  import CioCursor from '@pdslng/cio-icon/CioCursor.svelte'
  import CioDisplay from '@pdslng/cio-icon/CioDisplay.svelte'
  import CioHome from '@pdslng/cio-icon/CioHome.svelte'
  import CioLayers from '@pdslng/cio-icon/CioLayers.svelte'
  import CioLock from '@pdslng/cio-icon/CioLock.svelte'
  import CioMinimize from '@pdslng/cio-icon/CioMinimize.svelte'
  import CioMoon from '@pdslng/cio-icon/CioMoon.svelte'
  import CioSparkles from '@pdslng/cio-icon/CioSparkles.svelte'
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import type { Component } from 'svelte'
  import type { DisplayContextTab } from '$lib/stores/context-sidebar.svelte'
  import { onMount } from 'svelte'
  import type { DisplayControlAction } from '$shared/ipc/display'
  import { DISPLAY_CONTROLS_BY_KIND } from '$shared/ipc/display'
  import { displayPanel } from '$lib/stores/display-panel.svelte'
  import CioVolumeDown from '$lib/components/icons/cio/CioVolumeDown.svelte'
  import CioVolumeUp from '$lib/components/icons/cio/CioVolumeUp.svelte'
  import { StageTouch } from './display-stage-touch.svelte'

  /**
   * One target's live preview, with that target's own controls beside its picture.
   *
   * Two things matter here and nothing else: the frame fills the space at its own
   * aspect ratio, and the stage tells main how large it is so the capture is sized
   * to what is painted instead of to a guess (the dock is user-resizable).
   *
   * The rail sits against the picture rather than against the panel's edge, so a
   * phone-shaped preview keeps its buttons within reach instead of leaving a
   * column of empty space between the two. It is vertical because that is where a
   * device's buttons sit in the hand: the targets that answer to hardware keys get
   * those keys, and the targets that can be touched get a control toggle.
   *
   * Control is a mode, not a default: the panel is a viewer first, and a click on
   * a mirror should not land on a device that an agent is mid-way through driving
   * unless the person asked for the device. With it on, the picture takes the
   * pointer (tap, long press, drag) and the keyboard, and every gesture is sent
   * with its landing mark painted where it happened.
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
    siri: { action: 'siri', label: 'Siri', icon: CioSparkles },
    appearance: { action: 'appearance', label: 'Switch light and dark', icon: CioMoon }
  }

  /** The rail's width in CSS pixels, so the fit calculation leaves room for it. */
  const RAIL_WIDTH = 32

  let area = $state<HTMLDivElement | null>(null)
  let surface = $state<HTMLButtonElement | null>(null)
  let areaSize = $state({ width: 0, height: 0 })
  let zoom = $state<'fit' | 'actual'>('fit')
  let controlling = $state(false)
  /** A sentence shown when the user asks for control this target cannot offer. */
  let notice = $state<string | null>(null)

  const kind = $derived(tab.sourceKind)
  const sourceId = $derived(tab.sourceId)
  const session = $derived(displayPanel.sessionFor(tab.id))
  const frame = $derived(session?.frame ?? null)
  /** The frame's own URL, painted straight from the target's PNG bytes. */
  const url = $derived(session?.url ?? null)
  const status = $derived(
    session?.phase === 'failed' || session?.phase === 'retrying' ? session.phase : null
  )
  const controls = $derived.by((): RailControl[] =>
    kind ? DISPLAY_CONTROLS_BY_KIND[kind].map((action) => RAIL_CONTROLS[action]) : []
  )
  /** Whether this kind has anything to touch at all: a screen or a window does not. */
  const touchable = $derived(controls.length > 0)
  const inputReady = $derived(session?.input === true)
  const inputProblem = $derived(session?.inputProblem ?? 'This target cannot be controlled yet.')

  const touch = new StageTouch((gesture) => displayPanel.sendInput(tab.id, gesture))

  /**
   * The picture's own box, fitted to the stage.
   *
   * Fitted rather than `object-contain` because `actual` zoom has to paint at the
   * captured pixel size, and one explicit box is what lets both modes share the
   * same markup. The scale is `min` of both axes, so the whole screen is always
   * visible: nothing is ever cropped to fill a gap.
   */
  const box = $derived.by((): { width: number; height: number } | null => {
    const image = frame
    if (!image || areaSize.width <= 0 || areaSize.height <= 0) return null
    if (image.width <= 0 || image.height <= 0) return null
    const scale =
      zoom === 'actual' ? 1 : Math.min(areaSize.width / image.width, areaSize.height / image.height)
    return {
      width: Math.max(1, Math.round(image.width * scale)),
      height: Math.max(1, Math.round(image.height * scale))
    }
  })

  // The capture is sized to the space the stage can show, never to the picture it
  // happens to be painting: a frame that is smaller than its box would be
  // upscaled into a blur and, if the demand followed the painted size, would stay
  // small forever. Asking for the area's own longest edge means the next frame is
  // already sharp at the size the panel has. The store dedupes, so an unchanged
  // size costs no IPC.
  $effect(() => {
    const area = areaSize
    if (area.width <= 0 || area.height <= 0) return
    const longest = Math.max(area.width - RAIL_WIDTH, area.height)
    displayPanel.reportStageSize(tab.id, Math.round(longest * (window.devicePixelRatio || 1)))
  })

  function toggleControl(): void {
    if (!inputReady) {
      notice = inputProblem
      return
    }
    notice = null
    controlling = !controlling
    // Typing only reaches the device while the picture holds focus, so asking for
    // control also hands it the keyboard instead of leaving it to a second click.
    if (controlling) surface?.focus()
    else {
      touch.cancel()
      surface?.blur()
    }
  }

  // A stage owns one capture for exactly as long as it is mounted: mounting starts
  // the target, unmounting (a tab switch, a folded dock, fullscreen taking over)
  // stops it. The body is keyed by the target upstream, so a retarget remounts
  // this component instead of retargeting a running capture in place.
  //
  // Nothing here is an effect: mounting is the event, and the only ongoing work is
  // one ResizeObserver on the area the picture is fitted into.
  onMount(() => {
    const handle = area
    if (!handle || !kind || !sourceId) return
    const tabId = tab.id
    // The session this mount owns: a cleanup must never stop the capture that a
    // replacement stage (the dock's, on the way back from fullscreen) just began.
    const sessionId = displayPanel.start(tabId, kind, sourceId)
    displayPanel.setVisibleTab(tabId)
    const measure = (): void => {
      const width = handle.clientWidth
      const height = handle.clientHeight
      if (width === areaSize.width && height === areaSize.height) return
      areaSize = { width, height }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(handle)
    return () => {
      observer.disconnect()
      touch.dispose()
      displayPanel.releaseVisibleTab(tabId)
      displayPanel.stop(tabId, sessionId)
    }
  })
</script>

<div class="relative flex h-full min-h-0 bg-app">
  <div class="relative flex min-w-0 flex-1 overflow-auto" bind:this={area}>
    {#if frame && box && url}
      <button
        type="button"
        class="relative m-auto block shrink-0 select-none p-0 {controlling
          ? 'cursor-crosshair'
          : 'cursor-default'}"
        style="width:{box.width}px;height:{box.height}px"
        bind:this={surface}
        tabindex={controlling ? 0 : -1}
        aria-label={controlling
          ? `Control ${tab.title}: click to tap, drag to swipe, type to enter text`
          : `${tab.title} preview`}
        onpointerdown={(event) => {
          if (!controlling) return
          // The picture holds the keyboard for as long as it is the controlled one,
          // so a tap that re-rendered the panel must not leave typing addressed to
          // the document body.
          event.currentTarget.focus({ preventScroll: true })
          touch.down(event, event.currentTarget)
        }}
        onpointermove={(event) => {
          if (controlling) touch.move(event)
        }}
        onpointerup={(event) => {
          if (controlling) touch.up(event, event.currentTarget)
        }}
        onpointercancel={() => touch.cancel()}
        onkeydown={(event) => {
          if (!controlling) return
          if (touch.key(event)) event.preventDefault()
        }}
      >
        <img
          src={url}
          alt={`Live preview of ${tab.title}`}
          class="block h-full w-full outline-none"
          draggable="false"
        />
        {#if touch.mark}
          {#key touch.mark.id}
            <span
              class="display-tap pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary bg-primary/25"
              style="left:{touch.mark.x * 100}%;top:{touch.mark.y * 100}%"
              aria-hidden="true"
            ></span>
          {/key}
        {/if}
      </button>
    {:else}
      <div class="m-auto flex h-full w-full items-center justify-center">
        <p class="px-4 text-center text-[0.625rem] leading-relaxed text-dimmed" role="status">
          {session?.phase === 'failed'
            ? 'This target could not be read.'
            : 'Waiting for the first frame…'}
        </p>
      </div>
    {/if}

    {#if status || notice}
      <div
        class="absolute inset-x-0 bottom-0 flex items-start gap-1.5 bg-surface/95 px-2 py-1"
        role="status"
      >
        <CioDisplay size={12} class="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
        <p class="min-w-0 text-[0.625rem] leading-relaxed text-muted">
          {#if status}
            {status === 'failed' ? 'Stopped' : 'Retrying'}{session?.detail
              ? `: ${session.detail}`
              : '.'}
          {:else}
            {notice}
          {/if}
        </p>
      </div>
    {/if}
  </div>

  <div
    class="flex w-8 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-l border-border bg-surface py-1"
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
    {#if touchable}
      <div class="my-0.5 h-px w-4 bg-border" aria-hidden="true"></div>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center transition-colors {controlling
          ? 'bg-elevated text-foreground'
          : inputReady
            ? 'text-dimmed hover:bg-elevated hover:text-foreground'
            : 'text-dimmed/50'}"
        aria-pressed={controlling}
        aria-disabled={!inputReady}
        aria-label={controlling ? 'Stop controlling the screen' : 'Control the screen'}
        title={controlling
          ? 'Stop controlling the screen'
          : inputReady
            ? 'Control the screen: tap, drag and type'
            : inputProblem}
        onclick={toggleControl}
      >
        <CioCursor size={13} />
      </button>
    {/if}
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

<style>
  /* The landing mark: a short ring where the finger went, so a tap on a device
     that answers slowly still reads as registered. */
  .display-tap {
    animation: display-tap 420ms ease-out forwards;
  }

  @keyframes display-tap {
    from {
      opacity: 0.9;
      transform: translate(-50%, -50%) scale(0.4);
    }
    to {
      opacity: 0;
      transform: translate(-50%, -50%) scale(1.6);
    }
  }
</style>
