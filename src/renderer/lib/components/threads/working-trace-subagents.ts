/**
 * Wording and counting rules for the working-trace header's sub-agent badge.
 *
 * The badge answers two questions in one line: how many workers this turn
 * spawned, and   when exactly one is live   what that worker was asked to do.
 * Keeping the wording here means the tooltip and the visible label can never
 * disagree about the same turn.
 */

/** Tooltip for the badge, which names the sole live task when there is one. */
export function subagentBadgeTitle(
  soleActiveTask: string | null,
  subagentCount: number,
  activeSubagentCount: number
): string {
  return soleActiveTask
    ? `${soleActiveTask} is working - ${subagentCount} ${subagentCount === 1 ? 'sub-agent' : 'sub-agents'} - open list`
    : `Sub-agents spawned: ${subagentCount}, ${activeSubagentCount} running - open list`
}

/** Visible badge copy: the sole live task, else a count of running and total. */
export function subagentBadgeLabel(
  soleActiveTask: string | null,
  activeSubagentCount: number,
  subagentCount: number
): string {
  if (soleActiveTask) return soleActiveTask
  if (activeSubagentCount > 0) return `${activeSubagentCount} active · ${subagentCount} total`
  return `${subagentCount} ${subagentCount === 1 ? 'sub-agent' : 'sub-agents'}`
}
