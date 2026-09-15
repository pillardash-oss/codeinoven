import type { AgentSubagentActivity, AgentToolStatus } from '$shared/types'

/**
 * Presentation rules shared by every sub-agent surface (working-trace
 * dropdown, trace card, sub-agent session header, tab title).
 *
 * One delegated worker is described the same way everywhere: what task it was
 * given, which model runs it, whether it blocks the parent, and how long it has
 * been going. Keeping the wording here means the compact dropdown row and the
 * full session header can never disagree about the same worker.
 */

/** Only used when a harness reports no delegated task at all. */
export const SUBAGENT_FALLBACK_LABEL = 'Sub-agent'

/** The delegated task type, e.g. `explore`. Falls back to the task text. */
export function subagentTaskLabel(activity: AgentSubagentActivity): string {
  const agent = activity.agent?.trim()
  if (agent) return agent
  return activity.description?.trim() || SUBAGENT_FALLBACK_LABEL
}

/**
 * The longer task text, or null when it would only repeat the label. Pi names
 * both fields after the purpose, so most rows need no second line.
 */
export function subagentTaskDetail(activity: AgentSubagentActivity): string | null {
  const description = activity.description?.trim()
  if (!description || description === subagentTaskLabel(activity)) return null
  return description
}

/**
 * Model that runs the worker. Harnesses report ids as `provider/model`; the
 * compact form drops the provider half, which the detail header shows
 * separately.
 */
export function subagentModelLabel(
  activity: AgentSubagentActivity,
  compact = false
): string | null {
  const model = activity.modelId?.trim()
  if (!model) return null
  if (!compact) return model
  const separator = model.lastIndexOf('/')
  return separator >= 0 && separator < model.length - 1 ? model.slice(separator + 1) : model
}

/** True while the delegated worker is still executing. */
export function subagentIsRunning(activity: AgentSubagentActivity): boolean {
  return activity.status === 'running'
}

/** Status wording. The icon beside it carries the same meaning visually. */
export function subagentStatusLabel(status: AgentToolStatus): string {
  switch (status) {
    case 'running':
      return 'Working'
    case 'completed':
      return 'Completed'
    case 'error':
      return 'Failed'
    default:
      return 'Starting'
  }
}

/** Token color per lifecycle state, so every surface tints it identically. */
export const SUBAGENT_STATUS_TONE: Record<AgentToolStatus, string> = {
  running: 'text-info',
  completed: 'text-success',
  error: 'text-danger',
  pending: 'text-dimmed'
}

/**
 * Mode wording for the worker. A background worker outlives the tool call that
 * spawned it; an inline worker blocks the parent agent until it returns.
 */
export function subagentModeLabel(background: boolean): string {
  return background ? 'Background' : 'Inline'
}

/** Why the mode matters, used as the chip's tooltip. */
export function subagentModeTitle(background: boolean): string {
  return background
    ? 'Background sub-agent: it keeps running while the parent agent continues'
    : 'Inline sub-agent: the parent agent waits for it to finish'
}
