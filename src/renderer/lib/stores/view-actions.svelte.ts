import type { Component } from 'svelte'

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
  icon?: Component
  title?: string
  ariaLabel?: string
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
  /** Replace the registered action set for the current view. */
  set(view: string, items: ViewActionItem[]): void {
    registry.view = view
    registry.items = items
  }
}
