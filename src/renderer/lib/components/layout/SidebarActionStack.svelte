<script module lang="ts">
  import type { Component } from 'svelte'

  /**
   * One action in a panel's action stack.
   *
   * A plain action is an icon and a name the stack draws itself. A component
   * action is a ready-made control (the project door, the assistant door) that
   * the stack positions and sizes like every other action, so it folds with
   * them instead of standing outside the animation.
   */
  export interface SidebarPanelAction {
    id: string
    label: string
    icon?: Component
    run?: () => void
    component?: Component<Record<string, unknown>>
    props?: Record<string, unknown>
    shortcut?: readonly string[]
  }
</script>

<script lang="ts">
  import { ICON_SIZE } from '$lib/components/icons/cio/scale'
  import { encodeShortcutTokens } from '$lib/keymap/keymap'
  import type { Attachment } from 'svelte/attachments'

  interface Props {
    actions: SidebarPanelAction[]
    /**
     * How far the panel's list has scrolled, from 0 (its top) to 1 (fully away).
     * The label of each action gives way across its own slice of that range, so a
     * slow scroll shows the stack narrowing one action at a time.
     */
    progress: number
  }

  let { actions, progress }: Props = $props()

  /** One row is the rail's own icon box, so the stack's rows line up with the
   *  utility icons anchored at the foot of the view rail. */
  const ACTION_ROW = 32
  const ROW_GAP = 2

  /** The slice of the scroll the given action owns, so the fold travels down the
   *  stack one action at a time. */
  function actionProgress(index: number, total: number): number {
    if (total <= 1) return progress
    const span = 0.5
    const start = (index / (total - 1)) * (1 - span)
    return Math.min(1, Math.max(0, (progress - start) / span))
  }

  const stackHeight = $derived(
    actions.length * ACTION_ROW + Math.max(0, actions.length - 1) * ROW_GAP
  )

  /**
   * The stack's own width, so the folded row can ask whether the names fit.
   *
   * The room never shrinks with the fold: taking height back mid-scroll changes
   * the list's viewport, which can remove the very overflow that caused the fold
   * and set the two fighting, which is the vibration this replaced.
   */
  let containerWidth = $state(0)

  /** The row's own width, so the fold can decide whether every name fits. A
   *  resize observer where the platform has one, and a plain resize listener
   *  where it does not. */
  const measureWidth: Attachment<HTMLElement> = (element) => {
    const update = (): void => {
      containerWidth = element.clientWidth
    }
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }

  /** Natural width of each name, measured in the panel's own type. */
  const labelWidths = $derived.by(() => {
    const context = measureContext()
    return actions.map((action) => (context ? context.measureText(action.label).width : 0))
  })

  /** A folded action is its mark plus its name, with the button's own padding. */
  const foldedWidths = $derived(actions.map((_, index) => ACTION_ROW + 12 + labelWidths[index]))

  /** Whether the folded row can keep every name instead of dropping to marks. */
  const keepLabels = $derived(
    actions.length > 0 &&
      containerWidth > 0 &&
      foldedWidths.reduce((total, width) => total + width, 0) + (actions.length - 1) * ROW_GAP <=
        containerWidth
  )

  const rowWidth = $derived.by(() =>
    keepLabels
      ? foldedWidths.reduce((total, width) => total + width, 0) + (actions.length - 1) * ROW_GAP
      : stackHeight
  )

  /** Left edge of each action once folded, in the centred row. */
  const foldedLefts = $derived.by(() => {
    const lefts: number[] = []
    let cursor = (containerWidth - rowWidth) / 2
    for (const width of keepLabels ? foldedWidths : actions.map(() => ACTION_ROW)) {
      lefts.push(cursor)
      cursor += width + ROW_GAP
    }
    return lefts
  })

  /** One action's box, travelling from its own line in the stack to its slot in
   *  the centred row: top, left and width all interpolate, so a slow scroll shows
   *  each mark move to its place rather than the stack losing its words. */
  function styleFor(index: number): string {
    const p = actionProgress(index, actions.length)
    const top = index * (ACTION_ROW + ROW_GAP) * (1 - p)
    const left = foldedLefts[index] ?? 0
    const width = keepLabels ? foldedWidths[index] : ACTION_ROW
    return [
      `top: ${top}px`,
      `left: calc(${left}px * ${p})`,
      `width: calc(100% * ${1 - p} + ${width}px * ${p})`
    ].join('; ')
  }

  /** A name stays while there is room for it: only a row too narrow for every
   *  name drops back to marks, and then each name gives way in its own turn. */
  function labelOpacity(index: number): number {
    if (keepLabels) return 1
    const p = actionProgress(index, actions.length)
    return Math.max(0, 1 - p * 2.4)
  }

  /** A canvas that measures text in the app's own font at the panel's size, so
   *  the row knows whether its names fit instead of guessing at their widths. */
  let context: CanvasRenderingContext2D | null | undefined
  function measureContext(): CanvasRenderingContext2D | null {
    if (context !== undefined) return context
    if (typeof document === 'undefined') {
      context = null
      return context
    }
    context = document.createElement('canvas').getContext('2d')
    if (context) {
      const family = getComputedStyle(document.documentElement).fontFamily || 'sans-serif'
      context.font = `500 11px ${family}`
    }
    return context
  }
</script>

<!--
  The panel's actions, in the same column and on the same rows as the rail's
  utility icons. While the list is at its top every action names itself; as the
  list scrolls, each one gives its name up in turn and keeps only its mark.
-->
<div class="relative w-full" style="height: {stackHeight}px" {@attach measureWidth}>
  {#each actions as action, index (action.id)}
    {@const ActionIcon = action.icon}
    <div
      class="action-fold absolute overflow-hidden"
      style={styleFor(index)}
      data-panel-action={action.id}
    >
      {#if action.component}
        {@const ActionControl = action.component}
        <ActionControl {...action.props ?? {}} />
      {:else if ActionIcon && action.run}
        <button
          type="button"
          class="flex h-8 w-full items-center justify-start gap-1.5 px-2 text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label={action.label}
          title={action.label}
          data-shortcut={encodeShortcutTokens(action.shortcut ?? [])}
          onclick={action.run}
        >
          <ActionIcon size={ICON_SIZE.row} class="shrink-0" />
          <span
            class="truncate text-[0.6875rem] font-medium whitespace-nowrap"
            style="opacity: {labelOpacity(index)}">{action.label}</span
          >
        </button>
      {/if}
    </div>
  {/each}
</div>

<style>
  /* The fold follows the scroll position itself, and this short transition only
     smooths the gaps between scroll events, in both directions: coming back to
     the top, every mark travels out of the row and back to its own line. */
  .action-fold {
    transition:
      top 90ms linear,
      left 90ms linear,
      width 90ms linear;
  }

  @media (prefers-reduced-motion: reduce) {
    .action-fold {
      transition: none;
    }
  }
</style>
