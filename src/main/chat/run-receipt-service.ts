import type {
  RunReceipt,
  RunReceiptBounds,
  ScopeBoard,
  Thread,
  RunBaseRecord
} from '../../lib/types'
import { DEFAULT_RUN_RECEIPT_BOUNDS } from '../../lib/types'
import { resolveThreadBoundScope } from '../../lib/bound-scope'
import { shapeRunReceipt } from '../../lib/run-receipt'
import { RunReceiptCache } from './run-receipt/run-receipt-cache'
import { readRunChecks, type RunChecksReader } from './run-receipt/run-receipt-checks'
import { readReceiptGitFacts, type ReceiptGit } from './run-receipt/run-receipt-git'
import { RunBaseRecorder } from './run-receipt/run-receipt-base'

/**
 * The run receipt service.
 *
 * One read answers what a run did: the commits it made, the files it changed,
 * what it left uncommitted, and the checks it actually executed. Every number
 * comes from Git or from the run's own tool calls, never from the model's prose.
 *
 * The work is bounded and off the render path:
 *
 * - Two Git reads per fact per range (one status, one log, one range diff), never
 *   one per file.
 * - The checks read is a capped page of the thread's own tool messages.
 * - The result is cached per `(projectId, scopeBucketId, baseSha, headSha)`, so a
 *   re-render of an unchanged run performs no Git work at all. The cache expires
 *   on read rather than on a timer, so an idle app runs nothing for receipts.
 * - It never throws for a run it cannot describe: a missing base, an unreadable
 *   repository or a run still in flight each become an explicit state.
 *
 * Nothing here writes to the checkout, and nothing runs synchronously on the
 * Electron main thread: every Git call is the asynchronous service the rest of
 * the app already uses.
 */

/** What one receipt read asks for. */
export interface RunReceiptRequest {
  projectId: string
  threadId: string
  /** Scope to read when the thread itself names none (a project thread). */
  scopeBucketId?: string
  /**
   * Re-read even when a cached receipt covers the range.
   *
   * The renderer sets this when the app's own git change signal fires for the
   * thread, which is what makes invalidation event-driven instead of polled.
   */
  refresh?: boolean
}

/** The ports a receipt read needs. Narrow on purpose, so a test can count calls. */
export interface RunReceiptDeps {
  git: ReceiptGit
  threads: { getThread(projectId: string, threadId: string): Promise<Thread | null> }
  checks: RunChecksReader
  /** Resolve the checkout a scope stands for, through the scope authority. */
  resolveRoot(projectId: string, scopeBucketId?: string): Promise<string>
  /** A project's scope board, for the scope's display name. */
  scopeBoard(projectId: string): Promise<ScopeBoard>
  /** Record a run's base once, and never move it afterwards. */
  bases: RunBaseRecorder
  bounds?: RunReceiptBounds
  cache?: RunReceiptCache
}

/** A cache index entry: the range a thread's last read covered. */
interface HeadIndex {
  key: string
}

export class RunReceiptService {
  private readonly bounds: RunReceiptBounds
  private readonly cache: RunReceiptCache
  /** thread + base -> the cache key holding its latest receipt. */
  private readonly index = new Map<string, HeadIndex>()

  constructor(private readonly deps: RunReceiptDeps) {
    this.bounds = deps.bounds ?? DEFAULT_RUN_RECEIPT_BOUNDS
    this.cache = deps.cache ?? new RunReceiptCache()
  }

  /**
   * Read (or reuse) the receipt for one run.
   *
   * Order matters: the scope decides the checkout, the thread decides the base,
   * and the base plus the head decide whether anything has changed.
   */
  async read(request: RunReceiptRequest): Promise<RunReceipt> {
    const now = Date.now()
    const thread = await this.deps.threads.getThread(request.projectId, request.threadId)
    if (!thread) {
      return this.failure(request, now, 'This run no longer exists.')
    }
    // A bound assistant task's checkout is its binding; a project thread's is the
    // scope it was asked to show. The shared resolver answers both, so the
    // receipt can never disagree with the rail about where the run worked.
    const bound = resolveThreadBoundScope(thread)
    const scope = bound ?? {
      projectId: request.projectId,
      scopeBucketId: request.scopeBucketId ?? thread.scopeBucketId ?? 'default'
    }
    const scopeName = await this.scopeName(scope.projectId, scope.scopeBucketId)
    const base = thread.runBase ?? null
    if (!base) {
      return shapeRunReceipt({
        state: 'no-base',
        projectId: request.projectId,
        threadId: request.threadId,
        scope: { ...scope, scopeName, branch: thread.branch ?? null },
        baseSha: null,
        headSha: null,
        reason: 'This run recorded no starting commit, so its range cannot be known.',
        readAt: now
      })
    }
    const indexKey = this.indexKey(scope, request.threadId, base.sha)
    if (request.refresh) this.index.delete(indexKey)
    if (!request.refresh) {
      const cached = this.cached(indexKey)
      if (cached) return cached
    }
    if (thread.status === 'executing') {
      return shapeRunReceipt({
        state: 'running',
        projectId: request.projectId,
        threadId: request.threadId,
        scope: { ...scope, scopeName, branch: thread.branch ?? null },
        baseSha: base.sha,
        headSha: null,
        reason: 'This run has not settled yet.',
        readAt: now
      })
    }
    try {
      const path = await this.deps.resolveRoot(scope.projectId, scope.scopeBucketId)
      const facts = await readReceiptGitFacts(this.deps.git, {
        projectPath: path,
        baseSha: base.sha,
        bounds: this.bounds
      })
      const checks = await readRunChecks(this.deps.checks, request.threadId, this.bounds)
      const receipt = shapeRunReceipt({
        state: 'ready',
        projectId: request.projectId,
        threadId: request.threadId,
        scope: { ...scope, scopeName, branch: facts.branch },
        baseSha: base.sha,
        headSha: facts.headSha,
        commits: facts.commits,
        files: facts.files,
        uncommitted: facts.uncommitted,
        checks: checks.checks,
        truncated: {
          commits: facts.truncated.commits,
          files: facts.truncated.files,
          uncommitted: facts.truncated.uncommitted
        },
        readAt: now
      })
      this.store(indexKey, scope, receipt)
      return receipt
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return shapeRunReceipt({
        state: 'error',
        projectId: request.projectId,
        threadId: request.threadId,
        scope: { ...scope, scopeName, branch: thread.branch ?? null },
        baseSha: base.sha,
        headSha: null,
        reason,
        readAt: now
      })
    }
  }

  /**
   * Drop what the cache knows about one thread's range.
   *
   * The app's own change signal calls this, so a commit or a repair is visible on
   * the next read without a timer and without a Git probe on every render.
   */
  invalidate(projectId: string, threadId?: string): void {
    if (threadId === undefined) {
      this.index.clear()
      this.cache.clear()
      return
    }
    const prefix = `${projectId}\u0000${threadId}\u0000`
    for (const [key, entry] of this.index) {
      if (!key.startsWith(prefix)) continue
      this.index.delete(key)
      this.cache.delete(entry.key)
    }
  }

  /** Record the commit a run starts from, once. */
  async recordBase(
    projectId: string,
    threadId: string,
    sha: string,
    scope: { projectId: string; scopeBucketId: string }
  ): Promise<RunBaseRecord | null> {
    return this.deps.bases.record(projectId, threadId, sha, scope)
  }

  private indexKey(
    scope: { projectId: string; scopeBucketId: string },
    threadId: string,
    baseSha: string
  ): string {
    return `${scope.projectId}\u0000${threadId}\u0000${baseSha}`
  }

  private cached(indexKey: string): RunReceipt | null {
    const entry = this.index.get(indexKey)
    if (!entry) return null
    const receipt = this.cache.get(entry.key)
    if (!receipt) {
      this.index.delete(indexKey)
      return null
    }
    return receipt
  }

  private store(
    indexKey: string,
    scope: { projectId: string; scopeBucketId: string },
    receipt: RunReceipt
  ): void {
    const key = RunReceiptCache.key(scope.projectId, scope.scopeBucketId, receipt.baseSha, receipt.headSha)
    this.cache.set(key, receipt)
    this.index.set(indexKey, { key })
  }

  private async scopeName(projectId: string, scopeBucketId: string): Promise<string> {
    try {
      const board = await this.deps.scopeBoard(projectId)
      return (
        board.buckets.find((bucket) => bucket.id === scopeBucketId)?.name ??
        scopeBucketId
      )
    } catch {
      // A board that cannot be read names no scope, and the id is the honest
      // fallback: it is the identity the run resolved.
      return scopeBucketId
    }
  }

  private failure(request: RunReceiptRequest, now: number, reason: string): RunReceipt {
    return shapeRunReceipt({
      state: 'error',
      projectId: request.projectId,
      threadId: request.threadId,
      scope: {
        projectId: request.projectId,
        scopeBucketId: request.scopeBucketId ?? 'default',
        scopeName: request.scopeBucketId ?? 'default',
        branch: null
      },
      baseSha: null,
      headSha: null,
      reason,
      readAt: now
    })
  }
}
