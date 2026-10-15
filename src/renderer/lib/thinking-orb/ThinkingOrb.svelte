<script lang="ts">
  import { schemeState } from '$lib/stores/scheme.svelte'
  import { MODE_DRAWS } from './engine/registry'
  import { resolvePreset } from './presets'
  import type { OrbSize, OrbState, OrbTheme } from './types'

  interface Props {
    /** Which animation to show. @default 'working' */
    state?: OrbState
    /** Tuned size preset — 64 or 20 CSS px. @default 20 */
    size?: OrbSize
    /** Theme mode; `auto` follows the painted app theme. @default 'auto' */
    theme?: OrbTheme
    /** Animation speed multiplier on top of the preset's baked speed. @default 1 */
    speed?: number
    /** Freeze the animation on the current frame. @default false */
    paused?: boolean
    /** Accessible label; falls back to the state's own wording. */
    label?: string
    /** Extra classes for the canvas. */
    class?: string
  }

  // `state` is the public prop name, but it would shadow the `$state` rune, so
  // it is aliased on destructure and only ever read as `orbState`.
  let {
    state: orbState = 'working',
    size = 20,
    theme = 'auto',
    speed = 1,
    paused = false,
    label,
    class: className = ''
  }: Props = $props()

  const LABELS: Record<OrbState, string> = {
    working: 'Working…',
    searching: 'Searching…',
    solving: 'Solving…',
    listening: 'Listening…',
    connecting: 'Connecting…',
    weaving: 'Weaving…',
    composing: 'Composing…',
    breathing: 'Thinking…',
    shaping: 'Shaping…'
  }

  let canvas = $state<HTMLCanvasElement>()

  /** The ink the orb draws with: dark ink on a light canvas, light ink on a
   *  dark one. The app paints the theme as a `dark` class on `<html>`, which
   *  `schemeState` mirrors, so this follows a live theme switch. */
  const resolvedDark = $derived(theme === 'auto' ? schemeState.isDark : theme === 'dark')

  /** Reduced-motion users get one static, deterministic frame. */
  let reducedMotion = $state(false)
  $effect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    reducedMotion = query.matches
    const onChange = (event: MediaQueryListEvent) => (reducedMotion = event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  })

  /** Paint the orb. One canvas, one instance, one rAF loop that pauses while
   *  the orb is offscreen or the tab is hidden, so a trace left mounted behind
   *  another view costs nothing. */
  $effect(() => {
    const element = canvas
    if (!element) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    element.width = Math.round(size * dpr)
    element.height = Math.round(size * dpr)
    const context = element.getContext('2d')
    if (!context) return

    const { mode, speed: baseSpeed, opts } = resolvePreset(orbState, size)
    const draw = MODE_DRAWS[mode]
    const effSpeed = baseSpeed * speed
    const dark = resolvedDark

    const frame = (tSec: number): void => {
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, size, size)
      draw(context, size, tSec, dark, opts)
    }

    if (reducedMotion) {
      frame(0.6)
      return
    }

    let raf = 0
    let running = false
    const loop = (): void => {
      frame((performance.now() / 1000) * effSpeed)
      if (running) raf = requestAnimationFrame(loop)
    }
    const start = (): void => {
      if (running || paused) return
      running = true
      raf = requestAnimationFrame(loop)
    }
    const stop = (): void => {
      running = false
      cancelAnimationFrame(raf)
    }

    // Draw one frame even while paused, so a frozen orb still shows its mark.
    frame((performance.now() / 1000) * effSpeed)

    let visible = true
    const observer =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(([entry]) => {
            visible = entry.isIntersecting
            if (visible && document.visibilityState !== 'hidden') start()
            else stop()
          })
        : null
    observer?.observe(element)
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') stop()
      else if (visible) start()
    }
    document.addEventListener('visibilitychange', onVisibility)
    if (!observer) start()

    return () => {
      stop()
      observer?.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  })
</script>

<!-- role="img" is how a canvas is exposed to assistive tech; the a11y rule flags it as a false positive. -->
<!-- svelte-ignore a11y_no_interactive_element_to_noninteractive_role -->
<canvas
  bind:this={canvas}
  class={className}
  style="width: {size}px; height: {size}px; display: block;"
  role="img"
  aria-label={label ?? LABELS[orbState]}
></canvas>
