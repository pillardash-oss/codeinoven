import { CioDiagnosticsService } from '../cio-diagnostics-service'
import { requiredDatabase, requiredString } from '../utility-orchestration/utility-input'
import type { TurnState } from '../utility-orchestration-service'
import type { UtilityOrchestrationService } from '../utility-orchestration-service'

/** UtilityOrchestrationService diagnostics: one concern, moved verbatim from the composition root. */
export class UtilityOrchestrationServiceDiagnostics {
  constructor(private readonly host: UtilityOrchestrationService) {}

  /** Read-only app diagnostics, granted on every turn that carries the gateway. */
  async runDiagnostics(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    state.diagnostics ??= new CioDiagnosticsService(
      requiredDatabase(this.host.database),
      () => this.host.units['orchestration'].projectNames(),
      this.host.threadSearch ?? undefined
    )
    const diagnostics = state.diagnostics
    const action = input['action']
    if (action === 'lookup_thread') {
      const query = requiredString(input['query'], 'query', 300)
      return diagnostics.lookupThread(query)
    }
    if (action === 'search_threads') {
      const query = requiredString(input['query'], 'query', 300)
      return { threads: await diagnostics.searchThreads(query) }
    }
    if (action === 'read_messages') {
      const threadId = requiredString(input['thread_id'], 'thread_id', 128)
      const limit = typeof input['limit'] === 'number' ? input['limit'] : 40
      return {
        threadId,
        messages: await diagnostics.loadThreadMessages(threadId, limit)
      }
    }
    if (action === 'read_log') {
      const file = requiredString(input['file'], 'file', 120)
      const level = typeof input['level'] === 'string' ? input['level'] : undefined
      const limit = typeof input['limit'] === 'number' ? input['limit'] : 100
      return diagnostics.readLog(file, { level, limit })
    }
    if (action === 'list_schema') {
      const table = typeof input['table'] === 'string' ? input['table'] : undefined
      return diagnostics.listSchema(table)
    }
    if (action === 'query_sql') {
      const sql = requiredString(input['sql'], 'sql', 4_000)
      const params = Array.isArray(input['params']) ? input['params'] : []
      return diagnostics.runQuery(sql, params)
    }
    throw new TypeError('Diagnostics action is invalid')
  }
}
