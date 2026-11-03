import type { RunReceipt } from '../types'
import type { Contract } from './contract-helpers'

/**
 * Run receipts.
 *
 * `receipt:read` returns one run's facts: the commits it made, the files it
 * changed with their line counts, what it left uncommitted, and the checks it
 * actually executed. Every number comes from Git or from the run's own tool
 * calls.
 *
 * Payload bounds, enforced in the main-process service rather than at the edge:
 *
 * - 20 commits, 100 files and 20 checks per receipt, 400 characters of output
 *   tail per check. Each list carries its own `truncated` flag, so a bounded read
 *   can never look complete.
 * - One Git status read, one bounded log read and at most two range reads per
 *   receipt, never one read per file.
 * - Cached under `(projectId, scopeBucketId, baseSha, headSha)`, so re-rendering
 *   an unchanged run performs no Git work. `refresh` is how the renderer turns
 *   the app's own change signal into invalidation instead of a poll.
 *
 * It never throws for a run it cannot describe: a missing base, an unreadable
 * repository or a run still in flight each arrive as an explicit receipt state.
 */
export const invokeReceiptContract = {
  'receipt:read': {} as Contract<
    [
      projectId: string,
      threadId: string,
      scopeBucketId?: string,
      refresh?: boolean
    ],
    RunReceipt
  >
}
