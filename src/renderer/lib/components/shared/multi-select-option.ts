import type { Component } from 'svelte'

/**
 * One selectable row in the shared multi-select filter picker. Entity agnostic:
 * a project, a routine, and a browser group all render from this shape.
 */
export interface MultiSelectOption {
  id: string
  label: string
  description?: string
  color?: string
  iconUrl?: string | null
  icon?: Component
}
