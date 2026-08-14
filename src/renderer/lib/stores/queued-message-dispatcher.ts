/**
 * Background dispatcher for messages queued while an agent was busy.
 *
 * Queuing a message while the agent is working persists it in the recovery
 * snapshot (`rendererRecovery.queuedMessages`) and hands it to the mounted
 * ThreadView to auto-send on the next idle transition. But ThreadView is keyed
 * by the selected thread, so navigating away unmounts it and its `agent:event`
 * subscription, leaving the queued message stranded until the user returns.
 *
 * This dispatcher keeps delivery alive at module scope. It subscribes to
 * `agent:event` itself (no ThreadView required) and, on ANY session idle
 * transition, sweeps every persisted queued message. For each one it asks the
 * main process for the thread's authoritative agent status
 * (`agent:getSessionStatus`) and only sends when the thread is genuinely idle,
 * not mounted, not already being dispatched, and has no pending user gate
 * (permission / question / image descriptor). Sweeping on any idle event — not
 * just the queued thread's own session — means delivery no longer depends on
 * the thread-messages store's session→thread routing map, which could be
 * missing after a thread remount and silently strand the queue.
 */
import { invoke, subscribe } from '$lib/ipc.svelte'
import { claimQueuedMessage, releaseQueuedMessage } from '$lib/stores/queued-message-claim'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import { rendererRecovery, type QueuedMessageEntry } from '$lib/stores/renderer-recovery.svelte'
import { CHAT_DEFAULT_SETTINGS, DEFAULT_SETTINGS } from '$lib/stores/thread-settings.svelte'
import { messageId as createMessageId } from '$shared/id'
import { INBOX_PROJECT_ID, type AgentEvent, type ThreadSettings } from '$shared/types'

function threadKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`
}

class QueuedMessageDispatcher {
  /** Queues currently being sent, so concurrent idle events cannot double-send. */
  #inFlight = new Set<string>()
  /** Threads whose ThreadView is currently mounted — they own their own dispatch. */
  #mounted = new Set<string>()

  constructor() {
    subscribe('agent:event', (...args: unknown[]) => {
      const event = args[0] as AgentEvent | undefined
      if (!event) return
      const idle =
        event.type === 'session.idle' ||
        (event.type === 'session.status' && event.status.state === 'idle')
      if (idle) this.#sweep()
    })
  }

  /** Register a mounted ThreadView so the dispatcher defers to it. */
  markMounted(projectId: string, threadId: string): void {
    this.#mounted.add(threadKey(projectId, threadId))
  }

  /** Unregister a ThreadView that is being destroyed. */
  markUnmounted(projectId: string, threadId: string): void {
    this.#mounted.delete(threadKey(projectId, threadId))
  }

  /**
   * An idle transition means some agent just became free — re-check every
   * queued message. The authoritative per-thread status check in #dispatch
   * guarantees a queue is only sent when ITS thread is the one that is idle.
   */
  #sweep(): void {
    for (const { projectId, threadId } of rendererRecovery.queuedMessageThreads()) {
      const key = threadKey(projectId, threadId)
      if (this.#inFlight.has(key)) continue
      if (this.#mounted.has(key)) continue
      void this.#dispatch(projectId, threadId, key)
    }
  }

  async #dispatch(projectId: string, threadId: string, key: string): Promise<void> {
    // Claim synchronously, before any await. This is the single atomic gate
    // shared with the mounted ThreadView: whoever claims first owns delivery,
    // so concurrent idle transitions can never double-send the same message.
    if (!claimQueuedMessage(projectId, threadId)) return
    this.#inFlight.add(key)
    let dispatched: QueuedMessageEntry | null = null
    let userMessageId = ''
    try {
      // The thread's own agent must be genuinely idle — never send into a turn
      // that is still working, waiting on the provider, or gone entirely.
      if (!(await this.#isIdle(projectId, threadId))) return
      if (await this.#hasPendingGate(projectId, threadId)) return
      const settings = await this.#resolveSettings(projectId, threadId)
      // Nothing may have changed while we waited — verify before dispatching.
      if (this.#mounted.has(key)) return
      const entry = rendererRecovery.queuedMessageFor(projectId, threadId)
      if (!entry) return
      if (!(await this.#isIdle(projectId, threadId))) return
      dispatched = entry
      userMessageId = createMessageId()
      // Clear the persisted queue first: repeated idle events must not see it
      // while the send is in flight, and on failure it is recovered below.
      rendererRecovery.clearQueuedMessage(projectId, threadId)
      await threadMessages.send(
        projectId,
        threadId,
        settings,
        entry.text,
        entry.attachments,
        undefined,
        userMessageId,
        undefined,
        entry.promptContext,
        entry.promptReferences,
        entry.projectReferences,
        entry.presentation,
        entry.taskReferences
      )
    } catch {
      // Mirror the mounted ThreadView's failure recovery: if the message never
      // reached the conversation, write it back as a composer draft so it is
      // preserved but never auto-retried (an error/idle loop must not spam).
      if (dispatched) {
        const reached = threadMessages
          .messages(projectId, threadId)
          .some((message) => message.id === userMessageId)
        if (!reached) {
          rendererRecovery.setDraft(
            projectId,
            threadId,
            dispatched.text,
            dispatched.attachments,
            dispatched.projectReferences,
            dispatched.taskReferences,
            dispatched.promptReferences
          )
        }
      }
    } finally {
      this.#inFlight.delete(key)
      releaseQueuedMessage(projectId, threadId)
    }
  }

  /** The thread's authoritative agent state, read from the main process. */
  async #isIdle(projectId: string, threadId: string): Promise<boolean> {
    try {
      const status = await invoke('agent:getSessionStatus', projectId, threadId)
      return status?.state === 'idle'
    } catch {
      // Be conservative when state cannot be read: keep the queue parked and
      // let the next idle transition (or opening the thread) retry.
      return false
    }
  }

  /** A user decision gate keeps the queue parked until the user resolves it. */
  async #hasPendingGate(projectId: string, threadId: string): Promise<boolean> {
    try {
      const permissions = await invoke('agent:listPermissions', projectId, threadId)
      if (permissions.length > 0) return true
      const imageDescriptorErrors = await invoke(
        'agent:listImageDescriptorErrors',
        projectId,
        threadId
      )
      if (imageDescriptorErrors.length > 0) return true
      const questions = await invoke('agent:listQuestions', projectId, threadId)
      if (questions.length > 0) return true
    } catch {
      // Be conservative when gate state cannot be read: keep the queue parked
      // and let the next idle transition (or opening the thread) retry.
      return true
    }
    return false
  }

  /** The thread's persisted settings, else the appropriate defaults. */
  async #resolveSettings(projectId: string, threadId: string): Promise<ThreadSettings> {
    try {
      const thread = await invoke('thread:get', projectId, threadId)
      if (thread?.settings) return { ...DEFAULT_SETTINGS, ...thread.settings }
    } catch {
      // Fall through to the defaults when the thread record cannot be read.
    }
    return projectId === INBOX_PROJECT_ID ? { ...CHAT_DEFAULT_SETTINGS } : { ...DEFAULT_SETTINGS }
  }
}

export const queuedMessageDispatcher = new QueuedMessageDispatcher()
