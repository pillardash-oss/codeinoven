import CioCheckCircle from '@pdslng/cio-icon/CioCheckCircle.svelte'
import CioCrossCircle from '@pdslng/cio-icon/CioCrossCircle.svelte'
import CioDot from '@pdslng/cio-icon/CioDot.svelte'
import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
import CioMinusCircle from '$lib/components/icons/cio/CioMinusCircle.svelte'
/**
 * How a deployment or workflow run state reads at a glance.
 *
 * The Git panel's action row has no room for the state's word, so the glyph has
 * to carry it: a tick when it worked, a cross when it did not, a barred ring for
 * a run somebody stopped, a recycle mark while it is still moving, and a quiet
 * dot for the states that are neither (skipped, inactive, or not reported yet).
 *
 * A cancellation is not a failure. It is drawn in the quiet tone with its own
 * mark, because a red cross tells the reader the run broke when nothing broke.
 */
type StateTone = 'success' | 'failure' | 'idle' | 'active'

const FAILED_STATES = new Set([
  'failure',
  'error',
  'timed_out',
  'startup_failure',
  'action_required'
])
const IDLE_STATES = new Set(['skipped', 'cancelled', 'inactive', 'neutral'])
const TONE_CLASS: Record<StateTone, string> = {
  success: 'text-success',
  failure: 'text-danger',
  idle: 'text-dimmed',
  active: 'text-warning'
}
const STATE_LABELS: Record<string, string> = {
  success: 'Successful',
  failure: 'Failed',
  error: 'Errored',
  timed_out: 'Timed out',
  startup_failure: 'Did not start',
  action_required: 'Needs attention',
  in_progress: 'In progress',
  queued: 'Queued',
  pending: 'Pending',
  waiting: 'Waiting',
  inactive: 'Inactive',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  neutral: 'Neutral',
  unknown: 'Unknown'
}

function stateTone(state: string): StateTone {
  if (state === 'success') return 'success'
  if (FAILED_STATES.has(state)) return 'failure'
  if (IDLE_STATES.has(state)) return 'idle'
  // Everything left is a state that has not settled: queued, in progress,
  // waiting, or a provider state this app does not know by name.
  return 'active'
}

/** The glyph for one state. */
export function stateGlyph(state: string): typeof CioCheckCircle {
  if (state === 'cancelled') return CioMinusCircle
  const tone = stateTone(state)
  if (tone === 'success') return CioCheckCircle
  if (tone === 'failure') return CioCrossCircle
  if (tone === 'idle') return CioDot
  return CioRefresh
}

/** The glyph's colour, matching the tone the state pills use. */
export function stateGlyphClass(state: string): string {
  return TONE_CLASS[stateTone(state)]
}

/** The state in words, for the glyph's tooltip and accessible name. */
export function stateLabel(state: string): string {
  const known = STATE_LABELS[state]
  if (known) return known
  const words = state.replace(/_/gu, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
