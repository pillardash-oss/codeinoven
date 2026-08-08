/**
 * Background dispatcher for messages queued while an agent was busy.
 *
 * Queuing a message while the agent is working persists it in the recovery
 * snapshot (`rendererRecovery.queuedMessages`) and hands it to the mounted
 * ThreadView to auto-send on the next idle transition. But ThreadView is keyed
 * by the selected thread, so navigating away unmounts it and its `agent:event`
 * subscription, leaving the queued message stranded until the user returns.
 *
 * The threadMessages store keeps receiving session events at module scope even
 * when no view is mounted. This dispatcher hooks those idle transitions and
 * sends the persisted queue for threads that are NOT currently mounted, so a
 * message you queued keeps getting delivered the moment the agent is free — no
 * matter which thread you are looking at.
 */
import { invoke } from '$lib/ipc.svelte'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import { rendererRecovery, type QueuedMessageEntry } from '$lib/stores/renderer-recovery.svelte'
import { CHAT_DEFAULT_SETTINGS, DEFAULT_SETTINGS } from '$lib/stores/thread-settings.svelte'
import { messageId as createMessageId } from '$shared/id'
import { INBOX_PROJECT_ID, type ThreadSettings } from '$shared/types'

function threadKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`
}

class QueuedMessageDispatcher {
  /** Queues currently being sent, so concurrent idle events cannot double-send. */
  #inFlight = new Set<string>()
  /** Threads whose ThreadView is currently mounted — they own their own dispatch. */
  #mounted = new Set<string>()

  /** Register a mounted ThreadView so the dispatcher defers to it. */
  markMounted(projectId: string, threadId: string): void {
    this.#mounted.add(threadKey(projectId, threadId))
  }

  /** Unregister a ThreadView that is being destroyed. */
  markUnmounted(projectId: string, threadId: string): void {
    this.#mounted.delete(threadKey(projectId, threadId))
  }

  /**
   * Called by the threadMessages store whenever a session transitions to idle.
   * Sends the thread's persisted queued message, unless the thread is currently
   * mounted (its ThreadView handles the dispatch with its own guards), already
   * busy again, or waiting on a user gate (permission / question / image
   * descriptor) — those keep the queue for a later idle transition.
   */
  onThreadIdle(projectId: string, threadId: string): void {
    const key = threadKey(projectId, threadId)
    if (this.#inFlight.has(key)) return
    if (this.#mounted.has(key)) return
    if (!rendererRecovery.queuedMessageFor(projectId, threadId)) return
    if (agentRuns.isBusy(projectId, threadId)) return

    void this.#dispatch(projectId, threadId, key)
  }

  async #dispatch(projectId: string, threadId: string, key: string): Promise<void> {
    this.#inFlight.add(key)
    let dispatched: QueuedMessageEntry | null = null
    let userMessageId = ''
    try {
      if (await this.#hasPendingGate(projectId, threadId)) return
      const settings = await this.#resolveSettings(projectId, threadId)
      // Nothing may have changed while we waited — verify before dispatching.
      if (this.#mounted.has(key)) return
      const entry = rendererRecovery.queuedMessageFor(projectId, threadId)
      if (!entry) return
      if (agentRuns.isBusy(projectId, threadId)) return
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
            dispatched.taskReferences
          )
        }
      }
    } finally {
      this.#inFlight.delete(key)
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
