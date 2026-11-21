import type { IdeLocation } from '$shared/editor-ide'

/** Keep a selected references list across the editor remount caused by opening a result. */
export interface IdeFloatingResults {
  results: IdeLocation[]
  selectedIndex: number
  title: string
  anchor: { x: number; y: number }
  /** An open project text or file search, which outlives the remount with its query. */
  search?: { mode: 'grep' | 'files'; query: string; truncated: boolean; pending: boolean }
}
const snapshots = new Map<string, IdeFloatingResults>()
export function rememberIdeResults(key: string, value: IdeFloatingResults): void {
  snapshots.delete(key)
  snapshots.set(key, value)
  if (snapshots.size > 16) snapshots.delete(snapshots.keys().next().value!)
}
export function recalledIdeResults(key: string): IdeFloatingResults | undefined {
  return snapshots.get(key)
}
export function forgetIdeResults(key: string): void {
  snapshots.delete(key)
}
