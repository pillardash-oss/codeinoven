import { buildBoundedQuery } from '../bounded-query'

/** A bounded read result, shared by the worker path and its local fallback. */
export interface BoundedRowsResult {
  ok: boolean
  rows: Record<string, unknown>[]
  truncated: boolean
  error?: string
}

/** The synchronous surface a fallback read runs on (the primary connection). */
export interface SynchronousQueryHost {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[]
}

/**
 * Await a worker request, but never longer than `deadlineMs`.
 *
 * Answers `null` when the deadline passes. The pending request is still
 * handled (its rejection is observed) because it keeps running on the worker;
 * it simply stops being something the caller waits on.
 */
export async function raceWorkerQuery<T>(
  pending: Promise<T>,
  deadlineMs?: number
): Promise<T | null> {
  if (deadlineMs === undefined) return await pending
  void pending.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, deadlineMs))
  })
  try {
    return await Promise.race([pending, timedOut])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Local fallback for the worker's bounded query: applies the same outer-limit
 * and truncation semantics against a primary connection.
 */
export function runLocalBoundedQuery(
  db: SynchronousQueryHost,
  sql: string,
  params: unknown[],
  maxRows: number
): BoundedRowsResult {
  try {
    const boundedQuery = buildBoundedQuery(sql, maxRows)
    const boundParams = [...params]
    if (boundedQuery.limitParam !== undefined) {
      boundParams.push(boundedQuery.limitParam)
    }
    const rows = db.all<Record<string, unknown>>(boundedQuery.sql, ...boundParams)
    const bounded = Math.max(0, Math.floor(maxRows))
    const truncated = bounded > 0 && rows.length > bounded
    return { ok: true, rows: truncated ? rows.slice(0, bounded) : rows, truncated }
  } catch (error) {
    return { ok: false, rows: [], truncated: false, error: String(error) }
  }
}
