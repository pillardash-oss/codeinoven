<script lang="ts">
  import type { Snippet } from 'svelte'
  import DiffRows from './DiffRows.svelte'
  import type { DiffLine } from './file-diff'

  interface Props {
    /** The diff lines shown inside the hover popover. */
    lines: DiffLine[]
    /** The element users hover to reveal the popover. */
    trigger: Snippet
    /** Optional max-height for the scrollable diff body (e.g. "18rem"). */
    maxHeight?: string
    /** Optional width of the popover (defaults to a bounded read width). */
    width?: string
    /** Extra classes for the hover wrapper element. */
    class?: string
  }

  let {
    lines,
    trigger,
    maxHeight = '18rem',
    width = '440px',
    class: className = ''
  }: Props = $props()

  const SHOW_DELAY_MS = 350
  const HIDE_DELAY_MS = 200
  const GAP_PX = 10

  let anchor = $state<HTMLElement | null>(null)
  let open = $state(false)
  let position = $state<{ top: number; left: number }>({ top: 0, left: 0 })
  let showTimer: ReturnType<typeof setTimeout> | null = null
  let hideTimer: ReturnType<typeof setTimeout> | null = null

  function place(): void {
    const rect = anchor?.getBoundingClientRect()
    if (!rect) return
    const estimateHeight = 360
    const estimateWidth = 440
    let top = rect.top + rect.height / 2 - estimateHeight / 2
    let left = rect.right + GAP_PX
    const maxLeft = window.innerWidth - estimateWidth - 8
    const maxTop = window.innerHeight - estimateHeight - 8
    if (left > maxLeft) left = Math.max(8, rect.left - estimateWidth - GAP_PX)
    top = Math.max(8, Math.min(maxTop, top))
    position = { top, left }
  }

  function scheduleShow(): void {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    if (showTimer) return
    showTimer = setTimeout(() => {
      showTimer = null
      place()
      open = true
    }, SHOW_DELAY_MS)
  }

  function scheduleHide(): void {
    if (showTimer) {
      clearTimeout(showTimer)
      showTimer = null
    }
    if (hideTimer) return
    hideTimer = setTimeout(() => {
      hideTimer = null
      open = false
    }, HIDE_DELAY_MS)
  }

  function cancelHide(): void {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  function closeOnScroll(event: Event): void {
    const target = event.target as Node | null
    if (target && anchor?.contains(target)) return
    open = false
  }

  function closeOnKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') open = false
  }

  $effect(() => {
    if (!open) return
    window.addEventListener('scroll', closeOnScroll, true)
    window.addEventListener('keydown', closeOnKeydown)
    return () => {
      window.removeEventListener('scroll', closeOnScroll, true)
      window.removeEventListener('keydown', closeOnKeydown)
    }
  })
</script>

<span
  bind:this={anchor}
  role="group"
  class="inline-flex {className}"
  onpointerenter={scheduleShow}
  onpointerleave={scheduleHide}
  onfocusin={scheduleShow}
  onfocusout={scheduleHide}
>
  {@render trigger()}
</span>

{#if open}
  <div
    role="dialog"
    aria-label="Diff preview"
    tabindex="-1"
    class="fixed z-50 overflow-hidden rounded-lg border border-border bg-surface shadow-xl"
    style="top: {position.top}px; left: {position.left}px; width: {width};"
    onpointerenter={cancelHide}
    onpointerleave={scheduleHide}
  >
    <div
      class="max-w-full overflow-x-hidden overflow-y-auto py-1 font-mono text-[11px] leading-5"
      style="max-height: {maxHeight};"
    >
      <DiffRows {lines} paneLabels />
    </div>
  </div>
{/if}
