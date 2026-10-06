import type { RoutineExecution, ThreadSettings } from './types'
import { LOCAL_OVEN_ID } from './ovens'

/**
 * Routine execution targets, as pure functions.
 *
 * A routine may name an Oven its runs execute on, so scheduled assistant work
 * can stay off the user's own device. The routine's target is the default for
 * every run it dispatches; a task that already has an Oven of its own keeps it,
 * so a task-level choice always wins over the routine default.
 */

/** Whether an execution target actually points at a remote Oven. */
export function isRemoteExecution(
  execution: RoutineExecution | undefined
): execution is RoutineExecution {
  return !!execution && execution.ovenId !== LOCAL_OVEN_ID
}

/** Whether a task's own settings already pin it to a remote Oven. */
export function taskHasOwnOven(settings: ThreadSettings | undefined): boolean {
  return !!settings?.ovenId && settings.ovenId !== LOCAL_OVEN_ID
}

/**
 * The settings a run should actually execute with: the task's settings, plus
 * the routine's target when the task has not chosen an Oven itself.
 */
export function settingsWithRoutineTarget(
  settings: ThreadSettings,
  execution: RoutineExecution | undefined
): ThreadSettings {
  if (taskHasOwnOven(settings) || !isRemoteExecution(execution)) return settings
  const { ovenId, ovenPath } = execution
  return {
    ...settings,
    ovenId,
    ...(ovenPath ? { ovenPath } : { ovenPath: undefined })
  }
}
