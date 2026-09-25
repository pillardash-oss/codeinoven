import type { AgentPart } from '$shared/types'

/**
 * When the agent started working on one trace: the explicit start when the
 * caller has one, else the earliest timestamp any visible entry carries.
 *
 * The fallback matters at message boundaries, where the turn's own start time
 * is unavailable but its first tool or reasoning entry already carries one, so
 * the live duration keeps counting instead of resetting to zero.
 */
export function workingTraceStartTime(
  parts: readonly AgentPart[],
  startTime: number | undefined
): number | undefined {
  if (startTime && startTime > 0) return startTime
  for (const part of parts) {
    const start =
      part.type === 'tool'
        ? part.state.time?.start
        : part.type === 'reasoning'
          ? part.time?.start
          : part.type === 'subagent'
            ? part.activity.time?.start
            : undefined
    if (start && start > 0) return start
  }
  return undefined
}
