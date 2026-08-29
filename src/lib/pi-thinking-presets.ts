import type { ThinkingPreset } from './types'

/**
 * Pi's reasoning-effort levels, accepted by its `set_thinking_level` RPC.
 * Shared between the driver (RPC-discovered models) and the native provider
 * config service (`~/.pi/agent/models.json` models) so a model marked
 * `reasoning: true` always gets a selectable thinking level in either path —
 * Pi's own model catalog has no per-model variant list to derive this from.
 */
export const PI_THINKING_PRESETS: ThinkingPreset[] = [
  { id: 'minimal', label: 'Minimal', description: 'Minimum reasoning effort' },
  { id: 'low', label: 'Low', description: 'Low reasoning effort' },
  { id: 'medium', label: 'Medium', description: 'Moderate reasoning effort' },
  { id: 'high', label: 'High', description: 'High reasoning effort' },
  { id: 'xhigh', label: 'Extra high', description: 'Extra-high reasoning effort' }
]
