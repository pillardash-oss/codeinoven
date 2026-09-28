import type { Component } from 'svelte'
import { BarChart3, Briefcase, Cloud, Code, Folder, Globe, Heart, Star } from '@lucide/svelte'
import { BROWSER_GROUP_ICON_IDS, type BrowserGroupIconId } from '$lib/stores/global-browser-types'

/**
 * The icon catalog a browser group can wear, in one place so the group row and
 * the group editor cannot offer different sets. The ids come from
 * `global-browser-types` (which is what persistence validates against); this map
 * is the renderer's resolution of those ids to components.
 */
export const BROWSER_GROUP_ICONS: Record<BrowserGroupIconId, Component> = {
  folder: Folder,
  briefcase: Briefcase,
  cloud: Cloud,
  code: Code,
  chart: BarChart3,
  star: Star,
  heart: Heart,
  globe: Globe
}

/** Iteration order for the editor's icon picker. */
export const BROWSER_GROUP_ICON_LIST: ReadonlyArray<{
  id: BrowserGroupIconId
  icon: Component
}> = BROWSER_GROUP_ICON_IDS.map((id) => ({ id, icon: BROWSER_GROUP_ICONS[id] }))
