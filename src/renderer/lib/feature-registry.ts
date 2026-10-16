import type { Component } from 'svelte'
import CioNote from './components/icons/cio/CioNote.svelte'
import CioNotes from './components/icons/cio/CioNotes.svelte'
import CioTabSettings from './components/icons/cio/CioTabSettings.svelte'
import CioTabTasks from './components/icons/cio/CioTabTasks.svelte'
import CioTabUtilities from './components/icons/cio/CioTabUtilities.svelte'

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
  /** Canonical mark, used wherever the feature is shown. Every one of these is a
   *  CIO drawing, so a feature reads the same on the rail, in its tab and in the
   *  settings section that owns it. */
  icon: Component
}

export const FEATURES: Record<FeatureId, FeatureDefinition> = {
  utilities: { id: 'utilities', name: 'Utilities', icon: CioTabUtilities },
  'thread-note': { id: 'thread-note', name: 'Thread note', icon: CioNote },
  'tab-note': { id: 'tab-note', name: 'Tab note', icon: CioNote },
  'sticky-notes': { id: 'sticky-notes', name: 'Sticky notes', icon: CioNotes },
  'task-manager': { id: 'task-manager', name: 'Task manager', icon: CioTabTasks },
  settings: { id: 'settings', name: 'Settings', icon: CioTabSettings }
}

/** The definition for one feature. */
export function feature(id: FeatureId): FeatureDefinition {
  return FEATURES[id]
}
