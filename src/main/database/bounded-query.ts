/**
 * Apply the worker's result cap without creating invalid SQL when the caller
 * already uses LIMIT for an inner query or an intentionally small result set.
 */
export function buildBoundedQuery(
  sql: string,
  maxRows: number
): { sql: string; limitParam?: number } {
  const statementSql = sql.replace(/;\s*$/u, '')
  const bounded = Math.max(0, Math.floor(maxRows))
  if (bounded <= 0) return { sql: statementSql }

  const boundedSql = /\bLIMIT\b/iu.test(statementSql)
    ? `SELECT * FROM (${statementSql}) AS __cio_bounded_query LIMIT ?`
    : `${statementSql} LIMIT ?`
  return { sql: boundedSql, limitParam: bounded + 1 }
}
