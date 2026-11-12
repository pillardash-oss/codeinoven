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
  const rowWidth = $derived(stackHeight)
  /** The block folds from one row per action to a single row of marks. */
  const blockHeight = $derived(ACTION_ROW + (stackHeight - ACTION_ROW) * (1 - progress))

  /** One action's box, travelling from its own line in the stack to its slot in
   *  the centred row above the tabs: top, left and width all interpolate, so a
   *  slow scroll shows each mark move to its place rather than the stack simply
   *  losing its words. */
  function styleFor(index: number): string {
    const p = actionProgress(index, actions.length)
    const top = index * (ACTION_ROW + ROW_GAP) * (1 - p)
    const compactLeft = `calc(50% - ${rowWidth / 2}px + ${index * (ACTION_ROW + ROW_GAP)}px)`
    return [
      `top: ${top}px`,
      `left: calc(${compactLeft} * ${p})`,
      `width: calc(100% * ${1 - p} + ${ACTION_ROW * p}px)`
    ].join('; ')
  }

  function labelOpacity(index: number): number {
    const p = actionProgress(index, actions.length)
    return Math.max(0, 1 - p * 2.4)
  }
</script>

<!--
  The panel's actions, in the same column and on the same rows as the rail's
  utility icons. While the list is at its top every action names itself; as the
  list scrolls, each one gives its name up in turn and keeps only its mark.
-->
<div class="relative w-full" style="height: {blockHeight}px">
  {#each actions as action, index (action.id)}
    {@const ActionIcon = action.icon}
    <div class="absolute overflow-hidden" style={styleFor(index)} data-panel-action={action.id}>
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
