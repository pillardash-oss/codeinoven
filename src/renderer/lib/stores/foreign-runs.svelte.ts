/**
 * Threads another CodeInOven instance is running right now.
 *
 * Two instances share one config root, so they share the thread table while each
 * one receives only its own harness stream. A thread can therefore be genuinely
 * working while this window sees none of it, and the persisted status alone
 * cannot tell that apart from work happening here. The main process is the only
 * party that knows, because it holds each in-flight turn's owner process, so it
 * pushes the set and this store is the renderer's projection of it.
 */
import { SvelteMap } from 'svelte/reactivity'
import { toast } from 'svelte-sonner'
import { invoke, subscribe } from '$lib/ipc.svelte'
import { logRendererError } from '$lib/system/renderer-logger'
import { showToastError } from '$lib/stores/app-errors.svelte'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import type { ForeignRunNotice, ThreadTransferResult } from '$shared/types'

/**
 * Which transfer requests are in flight, and how the last one failed.
 *
 * `ok` is never stored: a successful transfer removes the thread from the
 * foreign set, which removes the card that would render this state at all.
 */
export interface ForeignTransferState {
  pending: boolean
  error: string | null
}

const IDLE_TRANSFER_STATE: ForeignTransferState = { pending: false, error: null }

function threadKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`
}

function sameKeys(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false
  for (const key of left) {
    if (!right.has(key)) return false
  }
  return true
}

class ForeignRunsStore {
  #keys = new Set<string>()
  #workflowKeys = new Set<string>()
  /** The threads of the last published snapshot, kept as pairs so a departing
   *  notice can clear the run state this window holds for that thread. */
  #threads = new Map<string, { projectId: string; threadId: string }>()
  /** Bumped by every push, so a hydration response that arrives after a newer
   *  event can never overwrite it. */
  #revision = 0
  /** Reactive cache of `projectId:threadId` keys. */
  runs = $state(new Set<string>())
  /** Reactive cache of the subset of `runs` that belongs to a coordinated workflow. */
  workflows = $state(new Set<string>())
  /** Reactive cache of transfer state, keyed the same way. */
  transferStates = new SvelteMap<string, ForeignTransferState>()

  constructor() {
    subscribe('thread:foreignRuns', (...args: unknown[]) => {
      this.#revision += 1
      this.replace((args[0] ?? []) as ForeignRunNotice[])
    })
    void this.#hydrate()
  }

  /** Whether another instance is running this thread's turn right now. */
  isForeign(projectId: string, threadId: string): boolean {
    return this.runs.has(threadKey(projectId, threadId))
  }

  /** Whether this foreign run belongs to a coordinated workflow, which moves as
   *  one unit: transferring it moves the Sr. Engineer and every worker. */
  isWorkflow(projectId: string, threadId: string): boolean {
    return this.workflows.has(threadKey(projectId, threadId))
  }

  /** Transfer progress and the last failure, for the transfer card. */
  transferState(projectId: string, threadId: string): ForeignTransferState {
    return this.transferStates.get(threadKey(projectId, threadId)) ?? IDLE_TRANSFER_STATE
  }

  /**
   * Ask the owning instance to hand this thread's run over, then resume it
   * here. The main-process push drops the thread from the foreign set once this
   * instance owns the turn, which is what swaps the card back for the composer.
   */
  async transfer(projectId: string, threadId: string): Promise<void> {
    const key = threadKey(projectId, threadId)
    if (this.transferStates.get(key)?.pending) return
    this.#setTransferState(key, { pending: true, error: null })
    try {
      const result = await invoke('thread:transferRun', projectId, threadId)
      if (result.ok && result.noLongerForeign) {
        await this.#refreshThread(projectId, threadId)
        this.transferStates.delete(key)
        toast.info('The thread is no longer running in the other instance.')
        return
      }
      this.#settleTransfer(key, result)
    } catch (error) {
      logRendererError('Cross-instance thread transfer failed', error)
      this.#settleTransfer(key, { ok: false, reason: 'The transfer could not be completed.' })
    }
  }

  /**
   * Record a transfer verdict, and make sure the user can read it.
   *
   * A transfer that fails after the other instance stopped the run drops the
   * thread from the foreign set before the answer arrives, so the card is already
   * gone when the verdict lands. The verdict is stored anyway, because the thread
   * can come back to the set (the other instance resumed the run it stopped), and
   * when no card is on screen to carry the reason it is toasted instead. Dropping
   * it there is what leaves a stopped run with nothing explaining it.
   */
  #settleTransfer(key: string, result: ThreadTransferResult): void {
    const cardOnScreen = this.runs.has(key)
    if (result.ok || !cardOnScreen) this.transferStates.delete(key)
    else this.#setTransferState(key, { pending: false, error: result.reason })
    if (!result.ok && !cardOnScreen) showToastError(result.reason)
  }

  async #refreshThread(projectId: string, threadId: string): Promise<void> {
    await Promise.all([
      this.#hydrate(),
      (async () => {
        try {
          const [thread, { scopeState }, { workspaceState }, { threadMessages }] =
            await Promise.all([
              invoke('thread:get', projectId, threadId),
              import('./scope.svelte'),
              import('./workspace.svelte'),
              import('./thread-messages.svelte')
            ])
          if (thread) {
            scopeState.updateThread(thread)
            if (workspaceState.selectedThread?.id === thread.id) workspaceState.updateThread(thread)
          }
          await threadMessages.mergeTurnAlignedTail(projectId, threadId, 50)
        } catch (error) {
          logRendererError('Transferred thread cache could not be refreshed', error)
        }
      })()
    ])
  }

  #setTransferState(key: string, state: ForeignTransferState): void {
    this.transferStates.set(key, state)
  }

  async #hydrate(): Promise<void> {
    const revision = ++this.#revision
    try {
      const notices = await invoke('thread:listForeignRuns')
      if (this.#revision !== revision) return
      this.replace(notices)
    } catch (error) {
      // Advisory only: the next push still lands, and a single-instance app
      // would have received an empty set anyway.
      logRendererError('Cross-instance turn notices could not be loaded', error)
    }
  }

  private replace(notices: ForeignRunNotice[]): void {
    const keys = new Set(notices.map((notice) => threadKey(notice.projectId, notice.threadId)))
    const workflowKeys = new Set(
      notices
        .filter((notice) => notice.workflow)
        .map((notice) => threadKey(notice.projectId, notice.threadId))
    )
    if (sameKeys(keys, this.#keys) && sameKeys(workflowKeys, this.#workflowKeys)) return
    this.#keys = keys
    this.#workflowKeys = workflowKeys
    this.runs = new Set(keys)
    this.workflows = new Set(workflowKeys)
    // A turn that stops being foreign is the one moment this window is provably
    // holding run state for a run it never owned. That entry was fed by the
    // sibling's stream, and the stream ends with its turn, so a terminal event
    // that never arrived would leave a finished foreign thread reading as work in
    // progress on every rail, strip and row that asks the live-working rule. The
    // shared row was already re-read and pushed by the main process, so dropping
    // the projection here is what lets the row speak alone.
    for (const [key, thread] of this.#threads) {
      if (keys.has(key)) continue
      if (!agentRuns.hasSettled(thread.projectId, thread.threadId)) continue
      agentRuns.completeSession(thread.projectId, thread.threadId)
    }
    this.#threads = new Map(
      notices.map((notice) => [
        threadKey(notice.projectId, notice.threadId),
        { projectId: notice.projectId, threadId: notice.threadId }
      ])
    )
    // A thread that is no longer foreign (this instance took it over, or it
    // settled) has no card left to show a transfer verdict on.
    for (const key of [...this.transferStates.keys()]) {
      if (!keys.has(key) && !this.transferStates.get(key)?.pending) this.transferStates.delete(key)
    }
  }
}

export const foreignRuns = new ForeignRunsStore()
