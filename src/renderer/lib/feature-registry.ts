import { CpuIcon, Feather, Plug, Settings, StickyNotes, type LucideIcon } from '@lucide/svelte'

/**
 * Every feature's canonical name and mark live here, once.
 *
 * A feature that shows up in several surfaces (the rail, a settings section, a
 * dock item, a thread row marker) must not repeat its own icon import at each
 * site: renaming a feature or swapping its mark is one edit in this file.
 */
export type FeatureId =
  'utilities' | 'thread-note' | 'tab-note' | 'sticky-notes' | 'task-manager' | 'settings'

export interface FeatureDefinition {
  id: FeatureId
  /** Canonical human name, used wherever the feature labels itself. */
  name: string
  /** Canonical Lucide mark, used wherever the feature is shown. */
  icon: LucideIcon
}

export const FEATURES: Record<FeatureId, FeatureDefinition> = {
  utilities: { id: 'utilities', name: 'Utilities', icon: Plug },
  'thread-note': { id: 'thread-note', name: 'Thread note', icon: Feather },
  'tab-note': { id: 'tab-note', name: 'Tab note', icon: Feather },
  'sticky-notes': { id: 'sticky-notes', name: 'Sticky notes', icon: StickyNotes },
  'task-manager': { id: 'task-manager', name: 'Task manager', icon: CpuIcon },
  settings: { id: 'settings', name: 'Settings', icon: Settings }
}

/** The definition for one feature. */
export function feature(id: FeatureId): FeatureDefinition {
  return FEATURES[id]
}
