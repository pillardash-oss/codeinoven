import { SvelteMap } from 'svelte/reactivity'

/**
 * How many rows a thread-family sidebar list mounts before its "Show more".
 *
 * The threads timeline, the chats list, and each assistant's tasks draw the same
 * thread rows and can hold the same history, so they page at one depth. A list
 * that paged at its own depth is the drift this constant exists to stop, and a
 * mounted row is the whole cost: every row is a component with its own state,
 * effects and subscriptions.
 */
export const THREAD_LIST_PAGE_SIZE = 15

/**
 * The row budget for one or more sidebar lists.
 *
 * A list mounts its first page and keeps the rest behind "Show more" (and "Show
 * less"), so the mounted row count stays bounded to about a screenful however
 * long the history grows. The budget is keyed by list, so one object serves every
 * list a sidebar draws (each project folder, each status group, the chats list,
 * each assistant) without their counts colliding.
 */
export class RowPageBudget {
  #counts = new SvelteMap<string, number>()

  constructor(private readonly defaultPageSize: number = THREAD_LIST_PAGE_SIZE) {}

  /** Rows a list currently shows: its budget, or the first page before it grows. */
  visibleCount(listKey: string, pageSize: number = this.defaultPageSize): number {
    return this.#counts.get(listKey) ?? pageSize
  }

  /** Grow a list's budget by one page, capped at the real total. */
  showMore(listKey: string, total: number, pageSize: number = this.defaultPageSize): void {
    const current = this.visibleCount(listKey, pageSize)
    this.#counts.set(listKey, Math.min(current + pageSize, total))
  }

  /** Drop a list back to its first page. */
  showLess(listKey: string, pageSize: number = this.defaultPageSize): void {
    this.#counts.set(listKey, pageSize)
  }

  /** Raise a list's budget so a specific row number renders. */
  ensureVisible(listKey: string, needed: number, pageSize: number = this.defaultPageSize): void {
    const current = this.visibleCount(listKey, pageSize)
    if (needed > current) this.#counts.set(listKey, needed)
  }

  /** Grow a list's budget by freshly fetched rows, capped at the real total. */
  extend(
    listKey: string,
    extra: number,
    cap: number,
    pageSize: number = this.defaultPageSize
  ): void {
    const current = this.visibleCount(listKey, pageSize)
    this.#counts.set(listKey, Math.min(current + extra, cap))
  }

  /**
   * The rows a list renders: the budgeted head slice, plus the active row
   * appended last when it sits beyond the budget.
   *
   * The active row is artificial: it leaves the list the moment selection moves
   * elsewhere, so a collapsed budget keeps the thread the user is on in focus
   * without growing the list to its natural position.
   */
  visibleRows<T extends { id: string }>(
    listKey: string,
    rows: readonly T[],
    activeId: string | null,
    pageSize: number = this.defaultPageSize
  ): T[] {
    const count = this.visibleCount(listKey, pageSize)
    const head = rows.slice(0, count)
    if (!activeId || head.some((row) => row.id === activeId)) return [...head]
    const active = rows.find((row) => row.id === activeId)
    return active ? [...head, active] : [...head]
  }

  /** Rows still hidden behind "Show more", excluding the artificial active row. */
  hiddenCount<T>(rows: readonly T[], visible: readonly T[]): number {
    return Math.max(0, rows.length - visible.length)
  }

  /** Drop a list's budget once the list is gone, so it cannot outlive its rows. */
  forget(listKey: string): void {
    this.#counts.delete(listKey)
  }
}
