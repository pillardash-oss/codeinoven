import { CioDiagnosticsService } from '../cio-diagnostics-service'
import {
  optionalString,
  requiredDatabase,
  requiredString
} from '../utility-orchestration/utility-input'
import type { ThreadSearchOptions } from '../../database/repositories/thread-repo'
import type { TurnState } from '../utility-orchestration-service'
import type { UtilityOrchestrationService } from '../utility-orchestration-service'

/** The narrowing a `search_threads` call may carry, validated before use. */
function searchScope(input: Record<string, unknown>): ThreadSearchOptions {
  const options: ThreadSearchOptions = {}
  const projectId = optionalString(input['project_id'], 128)
  if (projectId) options.projectId = projectId
  const scopeId = optionalString(input['scope_id'], 128)
  if (scopeId) options.scopeBucketId = scopeId
  const assistantId = optionalString(input['assistant_id'], 128)
  if (assistantId) options.assistantId = assistantId
  const family = optionalString(input['family'], 32)
  if (family) {
    if (family !== 'projects' && family !== 'chats' && family !== 'assistant') {
      throw new TypeError('family must be projects, chats, or assistant')
    }
    options.family = family
  }
  return options
}

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
      return { threads: await diagnostics.searchThreads(query, searchScope(input)) }
    }
    if (action === 'list_groups') {
      const projectId = optionalString(input['project_id'], 128)
      return diagnostics.listGroups(projectId || undefined)
    }
    if (action === 'read_messages') {
      const threadId = requiredString(input['thread_id'], 'thread_id', 128)
      const limit = typeof input['limit'] === 'number' ? input['limit'] : 40
      const beforeId = optionalString(input['before_id'], 128)
      return diagnostics.loadThreadMessages(threadId, limit, beforeId || undefined)
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
