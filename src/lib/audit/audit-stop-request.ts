/**
 * The message an independent audit run reports when the user stopped it.
 *
 * The renderer matches this exact text so a deliberate stop is shown as a stop
 * instead of the failure card the auditor's own errors land on.
 */
export const INDEPENDENT_AUDIT_STOPPED_MESSAGE = 'The independent audit was stopped.'

/**
 * Whether a stop request made at `requestedAt` belongs to the run that began at
 * `runStartedAt`.
 *
 * A request older than the run start was aimed at a run that had already
 * finished (or at a start that failed before dispatching), so it must never
 * cancel this one. The request is therefore scoped by time rather than by a
 * flag that could leak into the next audit.
 */
export function auditStopAppliesToRun(
  requestedAt: number | undefined,
  runStartedAt: number
): boolean {
  return requestedAt !== undefined && requestedAt >= runStartedAt
}
