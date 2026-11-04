import { invoke } from '$lib/ipc.svelte'
import { logRendererError } from '$lib/system/renderer-logger'
import type { RunReceipt } from '$shared/types'

/**
 * The renderer's receipts.
 *
 * One read per run, reused everywhere it is shown: the conversation mounts the
 * block, and folding or scrolling it must never ask main for the same facts
 * again. Reads are keyed by thread, and a read already in flight is joined
 * rather than repeated, so two surfaces that open at once cost one read.
 *
 * Nothing polls. `refresh` is called when the run settles or when the app's own
 * change signal says this thread's checkout moved, which is what keeps an idle
 * conversation at zero work.
 */
class RunReceiptStore {
  #receipts = $state<Record<string, RunReceipt>>({})
  /** The last signature each thread was synced at, so a re-render costs nothing. */
  #synced = new Map<string, string>()
  #loading = $state<Record<string, boolean>>({})
  #pending = new Map<string, Promise<RunReceipt | null>>()

  /** The last receipt read for a thread, or undefined when none was read yet. */
  receiptFor(threadId: string): RunReceipt | undefined {
    return this.#receipts[threadId]
  }

  isLoading(threadId: string): boolean {
    return this.#loading[threadId] === true
  }

  /**
   * Bring one thread's receipt up to date for the state it is in.
   *
   * Called from the conversation as its run settles, with the settled flag and
   * the thread's own activity stamp as the signature: an unchanged thread costs a
   * map lookup and no read, and a settle costs exactly one. The dedupe lives here
   * rather than in a component so no surface has to carry bookkeeping state.
   */
  sync(
    projectId: string,
    threadId: string,
    scopeBucketId: string | undefined,
    settled: boolean,
    updatedAt: number
  ): void {
    const signature = `${settled ? 'settled' : 'live'}:${updatedAt}`
    if (this.#synced.get(threadId) === signature) return
    this.#synced.set(threadId, signature)
    void (settled
      ? this.refresh(projectId, threadId, scopeBucketId)
      : this.ensure(projectId, threadId, scopeBucketId))
  }

  /** Read the receipt unless one is already held for this thread. */
  async ensure(projectId: string, threadId: string, scopeBucketId?: string): Promise<void> {
    if (this.#receipts[threadId]) return
    await this.#read(projectId, threadId, scopeBucketId, false)
  }

  /** Re-read a thread's receipt, after a settle or a change signal. */
  async refresh(projectId: string, threadId: string, scopeBucketId?: string): Promise<void> {
    await this.#read(projectId, threadId, scopeBucketId, true)
  }

  /** Forget one thread's receipt, when it is deleted or its binding changes. */
  forget(threadId: string): void {
    const next = { ...this.#receipts }
    delete next[threadId]
    this.#receipts = next
    this.#synced.delete(threadId)
  }

  async #read(
    projectId: string,
    threadId: string,
    scopeBucketId: string | undefined,
    refresh: boolean
  ): Promise<RunReceipt | null> {
    const key = `${threadId}:${refresh ? 'refresh' : 'read'}`
    const pending = this.#pending.get(key)
    if (pending) return pending
    this.#loading = { ...this.#loading, [threadId]: true }
    const request = (async (): Promise<RunReceipt | null> => {
      try {
        const receipt = await invoke('receipt:read', projectId, threadId, scopeBucketId, refresh)
        this.#receipts = { ...this.#receipts, [threadId]: receipt }
        return receipt
      } catch (error) {
        // A receipt is evidence, not a requirement: a failed read leaves the
        // conversation exactly as it was and says nothing it cannot back up.
        logRendererError('A run receipt could not be read', error)
        return null
      } finally {
        this.#pending.delete(key)
        this.#loading = { ...this.#loading, [threadId]: false }
      }
    })()
    this.#pending.set(key, request)
    return request
  }
}

export const runReceiptState = new RunReceiptStore()

export type { RunReceipt }
