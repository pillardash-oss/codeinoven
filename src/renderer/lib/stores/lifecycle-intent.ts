import {
  ENGINEERING_LIFECYCLE_STAGE_VALUES,
  type EngineeringLifecycleSelectionInput,
  type EngineeringLifecycleStage
} from '$shared/types'
import { APP_SLUG } from '$shared/brand'

/**
 * Durable storage for a thread's staged (intent-only) Engineering lifecycle
 * selection.
 *
 * Toolbox toggles are intent, never action: the selection is applied only when
 * the user sends a message. Because the staging lives in view-local state, it
 * used to vanish when the user switched threads or restarted the app — the
 * switches flipped back off even though the user had explicitly turned them
 * on, risking a send that steers the wrong prompt. These helpers persist the
 * staged selection per project + thread so it survives thread switches and app
 * restarts, and is cleared exactly when it is applied or discarded.
 */

const KEY_PREFIX = `${APP_SLUG}.lifecycleIntent.`

const STAGES = new Set<string>(ENGINEERING_LIFECYCLE_STAGE_VALUES)

function storageKey(projectId: string, threadId: string): string {
  return `${KEY_PREFIX}${projectId}.${threadId}`
}

/** Validate an unknown parsed value as a selection input; null when invalid. */
function sanitize(value: unknown): EngineeringLifecycleSelectionInput | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as { stages?: unknown; autopilot?: unknown }
  if (!Array.isArray(candidate.stages)) return null
  const stages: EngineeringLifecycleStage[] = []
  for (const stage of candidate.stages) {
    if (typeof stage !== 'string' || !STAGES.has(stage)) return null
    if (!stages.includes(stage as EngineeringLifecycleStage)) {
      stages.push(stage as EngineeringLifecycleStage)
    }
  }
  return { stages, autopilot: candidate.autopilot === true }
}

/** Load the staged selection for a thread, or null when none is staged. */
export function loadLifecycleIntent(
  projectId: string,
  threadId: string
): EngineeringLifecycleSelectionInput | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(storageKey(projectId, threadId))
    if (!raw) return null
    return sanitize(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Persist the staged selection for a thread (survives restarts). */
export function saveLifecycleIntent(
  projectId: string,
  threadId: string,
  input: EngineeringLifecycleSelectionInput
): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(storageKey(projectId, threadId), JSON.stringify(input))
  } catch {
    // Storage unavailable (private mode, quota) — non-fatal; the intent still
    // lives in view state for this session.
  }
}

/** Drop the staged selection once it has been applied or discarded. */
export function clearLifecycleIntent(projectId: string, threadId: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(storageKey(projectId, threadId))
  } catch {
    // Non-fatal: a stale intent can only re-stage a selection the user still
    // sees in the toolbox, never apply it silently.
  }
}
