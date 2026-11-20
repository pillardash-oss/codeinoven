import { SvelteMap } from 'svelte/reactivity'
import { subscribe } from '$lib/ipc.svelte'
import { threadMessages } from './thread-messages.svelte'
import type { AgentEvent, PermissionRequest } from '$shared/types'

const EMPTY_REQUESTS: PermissionRequest[] = []

function conversationKey(projectId: string, conversationId: string): string {
  return `${projectId}:${conversationId}`
}

/**
 * Permission requests that block a conversation until the user answers them,
 * keyed by `projectId:conversationId`.
 *
 * The queue lives here, beside the conversation, instead of inside whichever
 * view happens to be mounted. A permission request blocks work whether or not
 * the user is looking at it: leaving a thread for a project view unmounts its
 * ThreadView, and a request raised (or still pending) across that switch used
 * to exist only in that view's local state, so coming back to a thread whose
 * row said "needs attention" could show no card and no way to answer it. The
 * store keeps the request across the unmount, and the event stream files it
 * even while nothing is mounted, so the card is there the moment the thread is
 * opened again.
 *
 * Requests are routed by the session the request arrived on, using the same
 * session → conversation table the streaming path uses, so a side chat and
 * its parent thread can never be confused for each other.
 *
 * A conversation is filed for only once a view has registered it (a thread on
 * mount, a side chat when its session comes up). Mounting also reconciles the
 * queue against the authoritative list the main process holds, which is what
 * repairs a request raised while this renderer was not running at all.
 */
class ConversationAttentionState {
  #pendingPermissions = new SvelteMap<string, PermissionRequest[]>()
  /**
   * Conversations whose blocking requests this store files, registered by the
   * view that mounts them or by the event that brings a side chat's session
   * up. Non-reactive bookkeeping: only read inside the event handler.
   */
  #trackedConversations = new Set<string>()

  constructor() {
    subscribe('agent:event', (...args: unknown[]) => {
      const event = args[0] as AgentEvent | undefined
      if (event) this.#handleAgentEvent(event)
    })
  }

  /** Unanswered permission requests of a conversation, oldest first. */
  permissions(projectId: string, conversationId: string): PermissionRequest[] {
    return (
      this.#pendingPermissions.get(conversationKey(projectId, conversationId)) ?? EMPTY_REQUESTS
    )
  }

  /** Whether the conversation is blocked on a permission request. */
  hasAttention(projectId: string, conversationId: string): boolean {
    return this.permissions(projectId, conversationId).length > 0
  }

  /**
   * File this conversation's requests from now on, even while no view of it is
   * mounted. Called by a view on mount, before (or beside) its first read of
   * the authoritative queue.
   */
  track(projectId: string, conversationId: string): void {
    this.#trackedConversations.add(conversationKey(projectId, conversationId))
  }

  /** Replace a conversation's queue with the queue a view just applied. */
  set(projectId: string, conversationId: string, requests: PermissionRequest[]): void {
    this.#trackedConversations.add(conversationKey(projectId, conversationId))
    this.#set(conversationKey(projectId, conversationId), requests)
  }

  /** Drop a request the user just answered. */
  resolve(projectId: string, conversationId: string, requestId: string): void {
    const key = conversationKey(projectId, conversationId)
    const requests = this.#pendingPermissions.get(key)
    if (!requests?.some((request) => request.id === requestId)) return
    this.#set(
      key,
      requests.filter((request) => request.id !== requestId)
    )
  }

  /**
   * Replace the queue with the authoritative list, keeping requests that
   * arrived while that list was in flight.
   *
   * A view hydrating on mount cannot simply overwrite: the store is fed by the
   * live event stream, so a request raised during the IPC round trip is newer
   * than the list it carries and must survive (`knownIds` is what this view
   * already had before it asked). Losing it would strand the turn with no card
   * and no other way to answer.
   */
  reconcile(
    projectId: string,
    conversationId: string,
    serverRequests: PermissionRequest[],
    knownIds: ReadonlySet<string>
  ): void {
    const key = conversationKey(projectId, conversationId)
    // A view only reconciles its own conversation, so hydrating is proof this
    // conversation wants a store-backed queue.
    this.#trackedConversations.add(key)
    const arrivals = this.permissions(projectId, conversationId).filter(
      (request) => !knownIds.has(request.id)
    )
    const merged = [...serverRequests]
    for (const request of arrivals) {
      if (!merged.some((candidate) => candidate.id === request.id)) merged.push(request)
    }
    this.#set(key, merged)
  }

  /** Clear a conversation's queue (closed, expired, or restarted conversation). */
  clear(projectId: string, conversationId: string): void {
    const key = conversationKey(projectId, conversationId)
    this.#trackedConversations.delete(key)
    if (!this.#pendingPermissions.has(key)) return
    this.#pendingPermissions.delete(key)
  }

  #handleAgentEvent(event: AgentEvent): void {
    // The event that brings a side chat's session up is also the one that marks
    // its conversation as store-backed from then on.
    if (event.type === 'temporary-chat.started') {
      this.#trackedConversations.add(conversationKey(event.projectId, event.temporaryChatId))
      return
    }
    if (event.type !== 'permission.asked' && event.type !== 'permission.replied') return
    const target = threadMessages.conversationForSession(event.sessionId)
    if (!target) return
    const { projectId, conversationId } = target
    const key = conversationKey(projectId, conversationId)
    if (!this.#trackedConversations.has(key)) return
    if (event.type === 'permission.replied') {
      this.resolve(projectId, conversationId, event.requestId)
      return
    }
    this.#set(key, [
      ...this.permissions(projectId, conversationId).filter(
        (request) => request.id !== event.permission.id
      ),
      event.permission
    ])
  }

  #set(key: string, requests: PermissionRequest[]): void {
    if (requests.length === 0) {
      this.#pendingPermissions.delete(key)
      return
    }
    this.#pendingPermissions.set(key, requests)
  }
}

export const conversationAttention = new ConversationAttentionState()
