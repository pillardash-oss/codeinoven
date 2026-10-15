import type { AssistantExecution, ThreadSettings } from './types'
import { LOCAL_OVEN_ID } from './ovens'

/**
 * Assistant execution targets, as pure functions.
 *
 * An assistant may name an Oven its runs execute on, so scheduled assistant work
 * can stay off the user's own device. The assistant's target is the default for
 * every run it dispatches; a task that already has an Oven of its own keeps it,
 * so a task-level choice always wins over the assistant default.
 */

/** Whether an execution target actually points at a remote Oven. */
export function isRemoteExecution(
  execution: AssistantExecution | undefined
): execution is AssistantExecution {
  return !!execution && execution.ovenId !== LOCAL_OVEN_ID
}

/** Whether a task's own settings already pin it to a remote Oven. */
export function taskHasOwnOven(settings: ThreadSettings | undefined): boolean {
  return !!settings?.ovenId && settings.ovenId !== LOCAL_OVEN_ID
}

/**
 * The settings a run should actually execute with: the task's settings, plus
 * the assistant's target when the task has not chosen an Oven itself.
 */
export function settingsWithAssistantTarget(
  settings: ThreadSettings,
  execution: AssistantExecution | undefined
): ThreadSettings {
  if (taskHasOwnOven(settings) || !isRemoteExecution(execution)) return settings
  const { ovenId, ovenPath } = execution
  return {
    ...settings,
    ovenId,
    ...(ovenPath ? { ovenPath } : { ovenPath: undefined })
  }
}
