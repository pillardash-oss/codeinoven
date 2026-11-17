/**
 * The device reason a queued message is not sending yet.
 *
 * A queued message already waits on the thread: its turn has to end, and any
 * start-after dependency has to settle. This store holds the other reason, the
 * machine itself, and it is the only place that watches it. Whichever path was
 * about to deliver the message (the background dispatcher, or the mounted thread
 * on an idle transition) parks a retry here, so the message is delivered once,
 * by the path that queued it, as soon as the device has room again.
 *
 * The watching is a background service, so it follows the app's rule for one: the
 * five second ticker exists only while something is held, and it stops the moment
 * the last held message is delivered, deleted or gone.
 */
import { invoke } from '$lib/ipc.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import type { AdmissionDecision } from '$shared/resource-admission'

/** How often a message waiting on the device asks again. */
const RECHECK_MS = 5_000

interface ResourceWait {
  projectId: string
  threadId: string
  decision: AdmissionDecision
  /** What delivers the message once the device frees up. */
  retry: (() => void) | null
}

class QueuedResourceWait {
  #waits = $state<ResourceWait[]>([])
  #timer: ReturnType<typeof setInterval> | null = null

  /** The device reading holding this thread's queued message, if it is held. */
  for(projectId: string, threadId: string): AdmissionDecision | null {
    const wait = this.#find(projectId, threadId)
    return wait === undefined ? null : wait.decision
  }

  /** True when this thread's queued message is waiting on the device. */
  holds(projectId: string, threadId: string): boolean {
    return this.#find(projectId, threadId) !== undefined
  }

  /**
   * Park the message on the device. The retry is what re-runs delivery, so the
   * path that queued the message keeps ownership of it.
   */
  hold(projectId: string, threadId: string, decision: AdmissionDecision, retry?: () => void): void {
    const existing = this.#find(projectId, threadId)
    if (existing !== undefined) {
      this.#waits = this.#waits.map((wait) =>
        wait === existing ? { ...wait, decision, retry: retry ?? wait.retry } : wait
      )
    } else {
      this.#waits = [...this.#waits, { projectId, threadId, decision, retry: retry ?? null }]
    }
    this.#arm()
  }

  clear(projectId: string, threadId: string): void {
    const next = this.#waits.filter(
      (wait) => wait.projectId !== projectId || wait.threadId !== threadId
    )
    if (next.length === this.#waits.length) return
    this.#waits = next
    if (next.length === 0) this.#stop()
  }

  clearAll(): void {
    this.#waits = []
    this.#stop()
  }

  #find(projectId: string, threadId: string): ResourceWait | undefined {
    return this.#waits.find((wait) => wait.projectId === projectId && wait.threadId === threadId)
  }

  #arm(): void {
    if (this.#timer !== null) return
    this.#timer = setInterval(() => void this.#tick(), RECHECK_MS)
  }

  #stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
  }

  /** One recheck: drop stale waits, read the device, and release when it clears. */
  async #tick(): Promise<void> {
    const live = this.#waits.filter(
      (wait) => rendererRecovery.queuedMessageFor(wait.projectId, wait.threadId) !== null
    )
    if (live.length !== this.#waits.length) {
      this.#waits = live
      if (live.length === 0) {
        this.#stop()
        return
      }
    }
    let decision: AdmissionDecision
    try {
      decision = await invoke('system:resourceAdmission')
    } catch {
      return
    }
    if (decision.action === 'queue') {
      this.#waits = this.#waits.map((wait) => ({ ...wait, decision }))
      return
    }
    const retries = this.#waits
      .map((wait) => wait.retry)
      .filter((retry): retry is () => void => retry !== null)
    this.clearAll()
    for (const retry of retries) retry()
  }
}

export const queuedResourceWait = new QueuedResourceWait()
