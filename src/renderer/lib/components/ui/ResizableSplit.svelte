<script lang="ts">
  import { untrack } from 'svelte'
  import type { Snippet } from 'svelte'

  interface Props {
    top: Snippet
    bottom: Snippet
    topLabel?: string
    bottomLabel?: string
    /** Initial top pane share, 0..1. Defaults to 50%. */
    initialRatio?: number
    class?: string
  }

  let {
    top,
    bottom,
    topLabel,
    bottomLabel,
    initialRatio = 0.5,
    class: className = ''
  }: Props = $props()

  const MIN_RATIO = 0.2
  const MAX_RATIO = 0.8

  function clamp(value: number): number {
    return Math.min(Math.max(value, MIN_RATIO), MAX_RATIO)
  }

  let container = $state<HTMLDivElement | null>(null)
  let ratio = $state.raw(clamp(untrack(() => initialRatio)))
  let resizing = $state(false)
  let pointerId = 0
  let startY = 0
  let startRatio = 0

  function startResize(event: PointerEvent & { currentTarget: HTMLButtonElement }): void {
    resizing = true
    pointerId = event.pointerId
    startY = event.clientY
    startRatio = ratio
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function resize(event: PointerEvent): void {
    if (!resizing || event.pointerId !== pointerId) return
    const height = container?.getBoundingClientRect().height ?? 1
    ratio = clamp(startRatio + (event.clientY - startY) / Math.max(height, 1))
  }

  function finishResize(event: PointerEvent): void {
    if (!resizing || event.pointerId !== pointerId) return
    resizing = false
  }

  function resizeWithKeyboard(event: KeyboardEvent): void {
    const delta = event.key === 'ArrowUp' ? -0.05 : event.key === 'ArrowDown' ? 0.05 : 0
    if (!delta) return
    event.preventDefault()
    ratio = clamp(ratio + delta)
  }
</script>

<div bind:this={container} class={['flex min-h-0 flex-col', className].filter(Boolean).join(' ')}>
  <div class="min-h-0 overflow-y-auto" style="flex: {ratio} 1 0%">
    {#if topLabel}
      <p
        class="sticky top-0 z-10 bg-app/95 px-3 py-1 text-[9px] font-semibold uppercase tracking-wide text-muted backdrop-blur"
      >
        {topLabel}
      </p>
    {/if}
    {@render top()}
  </div>

  <button
    type="button"
    aria-label="Resize panes"
    title="Resize panes"
    class="flex h-1.5 shrink-0 cursor-row-resize touch-none items-center justify-center bg-transparent transition-colors hover:bg-primary/25 focus:bg-primary/25 focus:outline-none"
    onpointerdown={startResize}
    onpointermove={resize}
    onpointerup={finishResize}
    onpointercancel={finishResize}
    onkeydown={resizeWithKeyboard}
  >
    <span class="h-0.5 w-8 rounded-full bg-border"></span>
  </button>

  <div class="min-h-0 overflow-y-auto" style="flex: {1 - ratio} 1 0%">
    {#if bottomLabel}
      <p
        class="sticky top-0 z-10 bg-app/95 px-3 py-1 text-[9px] font-semibold uppercase tracking-wide text-muted backdrop-blur"
      >
        {bottomLabel}
      </p>
    {/if}
    {@render bottom()}
  </div>
</div>
