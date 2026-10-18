/** The meter covers the selected harness/provider's primary thread work. */
export function ledgerContextUsageSql(snapshot: string): string {
  return `json_set(${snapshot}, '$.costUsd', COALESCE((
    SELECT SUM(cost_usd) FROM usage_events
    WHERE thread_id = threads.id
      AND harness_id = json_extract(${snapshot}, '$.harnessId')
      AND provider_id = json_extract(${snapshot}, '$.providerId')
      AND feature IN ('main', 'assignment', 'audit')
  ), json_extract(${snapshot}, '$.costUsd')))`
}

export const RECONCILE_THREAD_CONTEXT_USAGE_SQL = `UPDATE threads
  SET context_usage = ${ledgerContextUsageSql('threads.context_usage')}
  WHERE id = ? AND context_usage IS NOT NULL AND json_valid(context_usage)`
