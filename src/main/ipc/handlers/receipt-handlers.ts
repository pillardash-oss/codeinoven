import { trustedIpcMain } from '../trusted-ipc-main'
import type { IpcHandlerContext } from './context'
import { validateReceiptRequest } from '../validation/receipt'
import type { RunChecksReader } from '../../chat/run-receipt/run-receipt-checks'
import { RUN_CHECKS_MESSAGE_LIMIT } from '../../chat/run-receipt/run-receipt-checks'
import { RunBaseRecorder } from '../../chat/run-receipt/run-receipt-base'
import { RunReceiptService } from '../../chat/run-receipt-service'

/**
 * The receipt channel.
 *
 * One bounded read per run, cached per range, computed from Git and from the
 * run's own tool calls. The service is built once here so its cache lives as
 * long as the app does: a conversation that scrolls over a settled run reads it
 * from memory instead of Git.
 */

/**
 * Read one thread's tool-bearing message parts on the database worker.
 *
 * Bounded three ways before a single byte reaches the main thread: the number of
 * messages, the size of each row's JSON, and the fact that only rows carrying a
 * tool part are selected at all. A receipt must never pull a whole transcript
 * into the process to count three commands.
 */
function createChecksReader(ctx: IpcHandlerContext): RunChecksReader {
  return {
    async listToolMessageParts(threadId: string): Promise<string[]> {
      const result = await ctx.database.queryViaWorker(
        `SELECT substr(parts, 1, 16000) AS parts
           FROM agent_messages
          WHERE thread_id = ? AND parts LIKE '%"type":"tool"%'
          ORDER BY created_at ASC
          LIMIT ${RUN_CHECKS_MESSAGE_LIMIT}`,
        [threadId],
        RUN_CHECKS_MESSAGE_LIMIT,
        { deadlineMs: 2_000 }
      )
      if (!result.ok) return []
      return result.rows.flatMap((row) => {
        const parts = row['parts']
        return typeof parts === 'string' ? [parts] : []
      })
    }
  }
}

export function registerReceiptHandlers(ctx: IpcHandlerContext): void {
  const service = new RunReceiptService({
    git: ctx.gitService,
    threads: ctx.threadManager,
    checks: createChecksReader(ctx),
    resolveRoot: (projectId, scopeBucketId) =>
      ctx.resolveProjectPath(projectId, scopeBucketId) as Promise<string>,
    scopeBoard: (projectId) => ctx.scopeManager.getBoardViaWorker(projectId),
    bases: new RunBaseRecorder({
      getThread: (projectId, threadId) => ctx.threadManager.getThread(projectId, threadId),
      setRunBase: async (projectId, threadId, base) => {
        await ctx.threadManager.setRunBase(projectId, threadId, base)
      }
    })
  })

  trustedIpcMain.handle(
    'receipt:read',
    async (
      _,
      projectId: unknown,
      threadId: unknown,
      scopeBucketId?: unknown,
      refresh?: unknown
    ) => {
      const request = validateReceiptRequest(projectId, threadId, scopeBucketId, refresh)
      return service.read(request)
    }
  )
}
