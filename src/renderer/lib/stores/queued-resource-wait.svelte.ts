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
import {
  type AdmissionDecision,
  type ResourceWaitTarget,
  type ThreadResourceGateAnswer
} from '$shared/resource-admission'

/** How often a message waiting on the device asks again. */
const RECHECK_MS = 5_000

interface ResourceWait {
  projectId: string
  threadId: string
  decision: AdmissionDecision
  /** Whose machine the wait belongs to: this device, or one named Oven. */
  target: ResourceWaitTarget
  /** What delivers the message once the device frees up. */
  retry: (() => void) | null
}

class QueuedResourceWait {
  #waits = $state<ResourceWait[]>([])
  #timer: ReturnType<typeof setInterval> | null = null

  /** The reading holding this thread's queued message, and whose machine. */
  for(
    projectId: string,
    threadId: string
  ): { decision: AdmissionDecision; target: ResourceWaitTarget } | null {
    const wait = this.#find(projectId, threadId)
    return wait === undefined ? null : { decision: wait.decision, target: wait.target }
  }

  /** True when this thread's queued message is waiting on the device. */
  holds(projectId: string, threadId: string): boolean {
    return this.#find(projectId, threadId) !== undefined
  }

  /**
   * Park the message on the device. The retry is what re-runs delivery, so the
   * path that queued the message keeps ownership of it.
   */
  hold(
    projectId: string,
    threadId: string,
    decision: AdmissionDecision,
    target: ResourceWaitTarget,
    retry?: () => void
  ): void {
    const existing = this.#find(projectId, threadId)
    if (existing !== undefined) {
      this.#waits = this.#waits.map((wait) =>
        wait === existing ? { ...wait, decision, target, retry: retry ?? wait.retry } : wait
      )
    } else {
      this.#waits = [
        ...this.#waits,
        { projectId, threadId, decision, target, retry: retry ?? null }
      ]
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

  /** One recheck: drop stale waits, ask each thread's own gate, release what cleared. */
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
    // One gate answer per held thread. A device wait reads this machine; an
    // Oven wait probes its Oven, which main caches briefly so this cadence
    // costs one SSH probe per Oven, not per thread.
    const answers = await Promise.all(
      this.#waits.map(async (wait) => ({
        wait,
        answer: await this.#gateFor(wait.projectId, wait.threadId)
      }))
    )
    const stillHeld: ResourceWait[] = []
    const released: (() => void)[] = []
    for (const { wait, answer } of answers) {
      if (answer === null || answer.wait === null) {
        if (wait.retry !== null) released.push(wait.retry)
        continue
      }
      stillHeld.push({ ...wait, decision: answer.wait, target: answer.target })
    }
    if (stillHeld.length === 0) {
      this.clearAll()
    } else {
      this.#waits = stillHeld
    }
    for (const retry of released) retry()
  }

  /** One thread's gate answer, or null when the gate could not be read. */
  async #gateFor(projectId: string, threadId: string): Promise<ThreadResourceGateAnswer | null> {
    try {
      return await invoke('system:threadResourceGate', projectId, threadId)
    } catch {
      return null
    }
  }
}

/**
 * The reading that should hold a new turn on this thread, or null when the
 * turn may start. The gate answers for whichever machine will run it: this
 * device for a local thread, the named Oven for an Oven thread. A reading that
 * cannot be taken fails open: an unreachable sampler must never stop the
 * user's work.
 */
export async function readThreadHold(
  projectId: string,
  threadId: string
): Promise<ThreadResourceGateAnswer | null> {
  try {
    return await invoke('system:threadResourceGate', projectId, threadId)
  } catch {
    return null
  }
}

export const queuedResourceWait = new QueuedResourceWait()
