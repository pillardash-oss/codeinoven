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
import { invoke, subscribe } from '$lib/ipc.svelte'
import { isRemotePwaRuntime } from '$lib/runtime-context'
import { logRendererError } from '$lib/system/renderer-logger'
import type { ForeignRunNotice } from '$shared/types'

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
  /** Bumped by every push, so a hydration response that arrives after a newer
   *  event can never overwrite it. */
  #revision = 0
  /** Reactive cache of `projectId:threadId` keys. */
  runs = $state(new Set<string>())

  constructor() {
    subscribe('thread:foreignRuns', (...args: unknown[]) => {
      this.#revision += 1
      this.replace((args[0] ?? []) as ForeignRunNotice[])
    })
    // A phone peer connects to exactly one desktop, so "another instance" is not
    // a state it can be shown, and the hydration channel is desktop-only.
    if (!isRemotePwaRuntime()) void this.#hydrate()
  }

  /** Whether another instance is running this thread's turn right now. */
  isForeign(projectId: string, threadId: string): boolean {
    return this.runs.has(threadKey(projectId, threadId))
  }

  async #hydrate(): Promise<void> {
    const revision = this.#revision
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
    if (sameKeys(keys, this.#keys)) return
    this.#keys = keys
    this.runs = new Set(keys)
  }
}

export const foreignRuns = new ForeignRunsStore()
