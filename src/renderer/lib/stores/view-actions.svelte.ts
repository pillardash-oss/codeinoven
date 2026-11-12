import type { Component } from 'svelte'

/**
 * Where a registered action is drawn. `header` is the bar's own quick-action
 * slot beside the title; `scope-tabs` is the project tabs row of the Scope
 * Board, after the overflow count, which is where the board's own project
 * control belongs: it adds a tab, so it sits with the tabs.
 */
export type ViewActionRegion = 'header' | 'scope-tabs'

/**
 * Per-view quick actions rendered next to the view switcher dropdown in the
 * app header. The workspace (which owns the view's data and handlers)
 * registers the actions for the active sidebar view; the header only renders
 * them, so it never needs thread/project data itself. Two shapes are
 * supported: a plain icon button (icon + run) and a ready-made control such
 * as a search popover or create menu, passed as a component plus props so its
 * internal state keeps living with the workspace.
 */
export interface ViewActionItem {
  id: string
  /** Defaults to `header` when a view does not say otherwise. */
  region?: ViewActionRegion
  icon?: Component
  title?: string
  ariaLabel?: string
  /** Symbolic key tokens for the action's shortcut; shown inside its tooltip. */
  shortcut?: readonly string[]
  run?: () => void
  component?: Component<Record<string, unknown>>
  props?: Record<string, unknown>
}

const registry = $state<{
  view: string
  items: ViewActionItem[]
}>({
  view: 'none',
  items: []
})

export const viewActions = {
  /** View key the current items were registered for ('projects', 'threads', …). */
  get view(): string {
    return registry.view
  },
  get items(): ViewActionItem[] {
    return registry.items
  },
  /** The items the app bar draws in its own action slot. */
  get headerItems(): ViewActionItem[] {
    return registry.items.filter((item) => (item.region ?? 'header') === 'header')
  },
  /** The items the Scope Board draws in its project tabs row. */
  get scopeTabItems(): ViewActionItem[] {
    return registry.items.filter((item) => item.region === 'scope-tabs')
  },
  /** Replace the registered action set for the current view. */
  set(view: string, items: ViewActionItem[]): void {
    registry.view = view
    registry.items = items
  }
}
