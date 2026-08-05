import type { ThinkingPreset, ThinkingLevel } from './types'

/**
 * Standard reasoning-effort presets shared by every reasoning harness.
 *
 * Drivers usually report these per model through their catalog, but that only
 * arrives after the harness resolves. The composer falls back to this list so
 * the thread's stored `thinkingLevel` snapshot renders immediately — the
 * control never disappears just because the catalog is still loading.
 */
export const STANDARD_THINKING_PRESETS: ThinkingPreset[] = [
  { id: 'minimal', label: 'Minimal', description: 'Minimum reasoning effort' },
  { id: 'low', label: 'Low', description: 'Low reasoning effort' },
  { id: 'medium', label: 'Medium', description: 'Moderate reasoning effort' },
  { id: 'high', label: 'High', description: 'High reasoning effort' },
  {
    id: 'xhigh',
    label: 'Extra high',
    description: 'Extra-high effort; uses significantly more quota'
  },
  {
    id: 'max',
    label: 'Max · high usage',
    description: 'Maximum effort; uses significantly more quota'
  },
  { id: 'ultra', label: 'Ultra · highest usage', description: 'Ultra effort; uses the most quota' }
]

/** Default reasoning effort applied when the thread has no explicit choice. */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium'
