import type { Component } from 'svelte'
import CioNote from '@pillardash-oss/cio-icon/CioNote.svelte'
import CioNotes from '@pillardash-oss/cio-icon/CioNotes.svelte'
import CioTabSettings from '@pillardash-oss/cio-icon/CioTabSettings.svelte'
import CioTabTasks from '@pillardash-oss/cio-icon/CioTabTasks.svelte'
import CioPackage from '@pillardash-oss/cio-icon/CioPackage.svelte'

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
  utilities: { id: 'utilities', name: 'Utilities', icon: CioPackage },
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
