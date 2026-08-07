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

/** Thinking levels ordered from lowest to highest reasoning effort. */
export const THINKING_LEVEL_ORDER: readonly ThinkingLevel[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
]

/**
 * Resolve the thinking level applied when a model is first selected.
 *
 * A model's explicitly declared `defaultThinkingLevel` always wins — that is
 * the only reason to keep a non-lowest level (e.g. a model whose default is
 * `medium`). Otherwise the lowest preset the model offers is used, so a
 * switch never leaves a stale level the new model doesn't support. Models
 * with no presets yield `undefined` and leave the current level untouched.
 */
export function resolveDefaultThinkingLevel(
  thinkingPresets: ThinkingPreset[] | undefined,
  defaultThinkingLevel: ThinkingLevel | undefined
): ThinkingLevel | undefined {
  if (defaultThinkingLevel) return defaultThinkingLevel
  const presets = thinkingPresets ?? []
  if (presets.length === 0) return undefined
  let lowest = presets[0]
  for (const preset of presets) {
    const index = THINKING_LEVEL_ORDER.indexOf(preset.id as ThinkingLevel)
    const lowestIndex = THINKING_LEVEL_ORDER.indexOf(lowest.id as ThinkingLevel)
    if (index !== -1 && (lowestIndex === -1 || index < lowestIndex)) lowest = preset
  }
  return lowest.id as ThinkingLevel
}
