import { Logger } from '../../system/logger'
import { broadcastThreadUpdate } from '../thread-events'
import type { Thread, ThreadSettings } from '../../../lib/types'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine threads-create: one concern, moved verbatim from the composition root. */
export class ChatEngineThreadsCreate {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Create the real, user-visible thread a dispatch runs on.
   *
   * The thread takes the same path a user-created one takes: `prepareCreateThread`
   * persists it with the resolved settings, so the row carries the Oven, the
   * harness and the model, and the broadcast that follows is what makes it
   * appear in every renderer's sidebar the moment it exists.
   */
  async createOrchestrationThread(input: {
    projectId: string
    title: string
    settings: ThreadSettings
    /**
     * The assistant a dispatched run belongs to, when the target was one.
     *
     * It is part of the created row for the same reason a task carries it: the
     * run's prompt is composed with that assistant's instructions, and its
     * reply is written back into the group chat under that assistant's name.
     */
    assistantId?: string
    /**
     * Who dispatched this thread, recorded on the row itself.
     *
     * Written once at creation rather than inferred later: the project board
     * states a dispatched row's origin from this fact, so it can never drift
     * from the dispatch that actually created it.
     */
    dispatchOrigin?: import('../../../lib/types').ThreadDispatchOrigin
  }): Promise<Thread> {
    const { thread, finalize } = this.host.threadManager.prepareCreateThread(
      {
        projectId: input.projectId,
        providerId: input.settings.providerId,
        title: input.title,
        titleSource: 'manual',
        settings: input.settings,
        ...(input.assistantId ? { assistantId: input.assistantId } : {}),
        dispatchOrigin: input.dispatchOrigin
      },
      {
        onEviction: (outcome) => {
          if (outcome.failedIds.length === 0) return
          Logger.error('Orchestration thread eviction failed', {
            evictedId: outcome.evictedId,
            failedIds: outcome.failedIds.join(','),
            error: String(outcome.error)
          })
        }
      }
    )
    await finalize()
    broadcastThreadUpdate(thread)
    return thread
  }
}
