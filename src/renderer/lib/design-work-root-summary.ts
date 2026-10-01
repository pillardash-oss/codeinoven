import type { AuthoredWorkKind, WorkRootState } from '$shared/ipc-contract'

/**
 * What one work-folder change did, in the user's terms.
 *
 * Both surfaces that change a root report the outcome, and they have to say the
 * same thing about the same event, so the sentence is built once here. It is
 * written from the report rather than from a count of files, because the two
 * things a user needs to know are how much moved and what was deliberately left
 * alone: a clash is the app refusing to choose between two folders that share a
 * name, and silence about it would read as the work having been lost.
 */
export function workRootMoveSummary(state: WorkRootState, kind: AuthoredWorkKind): string {
  const report = state.reports.find((entry) => entry.kind === kind)
  if (!report) return ''
  const parts: string[] = [
    report.moved === 0
      ? `Nothing was under ${report.from} to move.`
      : `Moved ${report.moved} folder${report.moved === 1 ? '' : 's'} from ${report.from} to ${report.to}.`
  ]
  if (report.clashes.length > 0) {
    const names = report.clashes.map((clash) => clash.name).join(', ')
    parts.push(`${report.clashes.length} left where ${names} already existed at the destination.`)
  }
  if (report.failed.length > 0) {
    parts.push(`${report.failed.length} could not be moved, and are still in ${report.from}.`)
  }
  return parts.join(' ')
}
