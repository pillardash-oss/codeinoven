import { mergeStreamedPart } from '$shared/agent-part-merge'
import { subagentStatusIsTerminal } from '$lib/subagent-presentation'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import { messageText, threadKey } from './thread-messages-merge'
import type { ThreadMessagesCache } from './thread-messages-cache.svelte'
import type { AgentEvent, AgentMessage, AgentPart, BrainstormTraceUpdate } from '$shared/types'

/**
 * Streaming and agent-event application for thread messages.
 *
 * Applies live part updates and provider telemetry to the cache, and routes
 * `agent:event` payloads (including Brainstorm lifecycle events) to the
 * conversation that owns the session. All cache mutation goes through
 * ThreadMessagesCache so the reveal/notify batching stays in one place.
 */
export class ThreadMessagesEvents {
  constructor(private readonly cache: ThreadMessagesCache) {}

  /** Apply a streaming part update to the cached messages. */
  upsertPart(projectId: string, threadId: string, sessionId: string, part: AgentPart): void {
    if (!this.cache.matchesSession(projectId, threadId, sessionId)) return
    this.cache.flushReveal(threadKey(projectId, threadId))
    const entry = this.cache.entry(projectId, threadId)
    const msgId = part.messageID
    const msgIndex = entry.messages.findLastIndex((message) => message.id === msgId)

    if (msgIndex === -1) {
      // If the part's text matches the last user's message, it's an echo from
      // the server, skip it to prevent a duplicate assistant message.
      if (part.type === 'text') {
        const lastUser = [...entry.messages].reverse().find((m) => m.role === 'user')
        if (lastUser && messageText(lastUser) === part.text) return
      }
      const newMsg: AgentMessage = {
        id: msgId,
        role: 'assistant',
        parts: [part],
        createdAt: Date.now()
      }
      entry.messages = [...entry.messages, newMsg]
    } else {
      const msg = entry.messages[msgIndex]
      // Providers overwhelmingly update the active tail part. Search backward
      // so a long-running trace stays constant-time in the common case.
      const partIndex = msg.parts.findLastIndex((candidate) => candidate.id === part.id)
      if (partIndex === -1) {
        msg.parts = [...msg.parts, part]
      } else {
        // A snapshot shorter than what already streamed must never wipe the
        // streamed text (see mergeStreamedPart).
        msg.parts[partIndex] = mergeStreamedPart(msg.parts[partIndex], part)
      }
      entry.messages = [...entry.messages]
    }
    this.cache.notifyStreaming(projectId, threadId)
  }

  /** Append streaming text to a specific part field. */
  applyDelta(
    projectId: string,
    threadId: string,
    sessionId: string,
    messageId: string,
    partId: string,
    field: string,
    delta: string
  ): void {
    if (!this.cache.matchesSession(projectId, threadId, sessionId)) return
    this.cache.flushReveal(threadKey(projectId, threadId))
    const entry = this.cache.entry(projectId, threadId)
    const msg = entry.messages.findLast((message) => message.id === messageId)
    if (!msg) return
    const part = msg.parts.findLast((candidate) => candidate.id === partId)
    if (!part) return
    if (field === 'text' && (part.type === 'text' || part.type === 'reasoning')) {
      part.text += delta
      entry.messages = [...entry.messages]
      this.cache.notifyStreaming(projectId, threadId)
    }
  }

  /** Mark a message as completed and stamp reasoning end times. */
  markCompleted(
    projectId: string,
    threadId: string,
    sessionId: string,
    messageId: string,
    error?: string,
    compaction = false,
    tokens?: AgentMessage['tokens'],
    contextWindow?: number,
    contextUsed?: number,
    contextEstimated?: boolean,
    rateLimits?: AgentMessage['rateLimits'],
    credits?: AgentMessage['credits'],
    bankedResets?: AgentMessage['bankedResets']
  ): void {
    if (!this.cache.matchesSession(projectId, threadId, sessionId)) return
    this.cache.flushReveal(threadKey(projectId, threadId))
    const entry = this.cache.entry(projectId, threadId)
    const doneMsg = entry.messages.find((m) => m.id === messageId)
    if (!doneMsg) return
    const now = Date.now()
    doneMsg.completedAt = now
    doneMsg.error = error
    if (tokens) doneMsg.tokens = tokens
    if (contextWindow !== undefined) doneMsg.contextWindow = contextWindow
    if (contextUsed !== undefined) doneMsg.contextUsed = contextUsed
    if (contextEstimated !== undefined) doneMsg.contextEstimated = contextEstimated
    if (rateLimits) doneMsg.rateLimits = rateLimits
    if (credits) doneMsg.credits = credits
    if (bankedResets) doneMsg.bankedResets = bankedResets
    if (compaction) {
      doneMsg.parts = doneMsg.parts.map((part): AgentPart =>
        part.type === 'text'
          ? {
              type: 'compaction-summary',
              id: part.id,
              messageID: part.messageID,
              text: part.text
            }
          : part
      )
    }
    for (const part of doneMsg.parts) {
      if (part.type === 'reasoning' && !part.time?.end) {
        part.time = { ...part.time, end: now }
      }
      // A tool still marked running when its message completes is finished by
      // definition, freeze its duration so the card stops counting while the
      // agent moves on to later tool calls.
      if (part.type === 'tool' && part.state.status === 'running' && !part.state.time?.end) {
        part.state.status = 'completed'
        part.state.time = { start: part.state.time?.start ?? now, end: now }
      }
      if (
        part.type === 'subagent' &&
        part.activity.status === 'running' &&
        !part.activity.time?.end
      ) {
        // A background worker outlives the tool call that spawned it, so the
        // parent message completing says nothing about it: its own settle
        // record closes the card. A failed message is the exception, because
        // nothing will ever settle a worker whose run just died.
        if (part.activity.background && !error) continue
        part.activity.status = 'completed'
        part.activity.time = { start: part.activity.time?.start ?? now, end: now }
      }
    }
    entry.messages = [...entry.messages]
    this.cache.notifyStreaming(projectId, threadId)
  }

  /** Apply provider account telemetry without creating a duplicate answer. */
  updateUsage(
    projectId: string,
    threadId: string,
    sessionId: string,
    messageId: string,
    tokens?: AgentMessage['tokens'],
    contextWindow?: number,
    contextUsed?: number,
    contextEstimated?: boolean,
    cost?: number,
    rateLimits?: AgentMessage['rateLimits'],
    credits?: AgentMessage['credits'],
    bankedResets?: AgentMessage['bankedResets']
  ): void {
    if (!this.cache.matchesSession(projectId, threadId, sessionId)) return
    this.cache.flushReveal(threadKey(projectId, threadId))
    const entry = this.cache.entry(projectId, threadId)
    const message = entry.messages.find((candidate) => candidate.id === messageId)
    if (!message) return
    if (tokens) message.tokens = tokens
    if (contextWindow !== undefined) message.contextWindow = contextWindow
    if (contextUsed !== undefined) message.contextUsed = contextUsed
    if (contextEstimated !== undefined) message.contextEstimated = contextEstimated
    if (cost !== undefined) message.cost = cost
    if (rateLimits) message.rateLimits = rateLimits
    if (credits) message.credits = credits
    if (bankedResets) message.bankedResets = bankedResets
    entry.messages = [...entry.messages]
    this.cache.notifyStreaming(projectId, threadId)
  }

  /** Apply Brainstorm lifecycle events by thread identity so navigation never drops them. */
  #applyBrainstormTrace(projectId: string, threadId: string, update: BrainstormTraceUpdate): void {
    if (update.type === 'refresh.started') {
      agentRuns.setBackgroundBusy(
        projectId,
        threadId,
        'brainstorm_report',
        update.startedAt,
        update.phase ? { phase: update.phase, version: update.version } : undefined
      )
      return
    }
    if (update.type === 'refresh.completed') {
      agentRuns.completeBackground(projectId, threadId, 'brainstorm_report')
      return
    }
    if (update.type === 'refresh.failed') {
      // A failed post-turn refresh must clear the background busy state (no
      // 'refresh.completed' will arrive) and surface the failure like any
      // other terminal run issue instead of silently dropping the version.
      agentRuns.completeBackground(projectId, threadId, 'brainstorm_report')
      this.cache.setRunIssue(projectId, threadId, {
        kind: 'unknown',
        message: update.error,
        harnessId: update.harnessId,
        retryable: true
      })
      return
    }
    if (update.type === 'started' || update.type === 'completed') {
      this.cache.mergePage(projectId, threadId, update.messages)
      if (update.type === 'started') {
        agentRuns.setBusy(
          projectId,
          threadId,
          true,
          this.cache.latestUserMessageId(projectId, threadId)
        )
      } else {
        agentRuns.setIdle(projectId, threadId)
      }
      return
    }

    const entry = this.cache.entry(projectId, threadId)
    const message = entry.messages.find((candidate) => candidate.id === update.messageId)
    if (!message) return
    if (update.type === 'part.updated') {
      const partIndex = message.parts.findIndex((part) => part.id === update.part.id)
      const parts =
        partIndex === -1
          ? [...message.parts, update.part]
          : message.parts.map((part, index) =>
              index === partIndex ? mergeStreamedPart(part, update.part) : part
            )
      this.cache.mergePage(projectId, threadId, [{ ...message, parts }])
      return
    }
    if (update.field !== 'text') return
    const parts = message.parts.map((part) => {
      if (part.id !== update.partId) return part
      if (part.type !== 'text' && part.type !== 'reasoning') return part
      return { ...part, text: `${part.text}${update.delta}` }
    })
    this.cache.mergePage(projectId, threadId, [{ ...message, parts }])
  }

  handle(event: AgentEvent): void {
    if (event.type === 'brainstorm.trace') {
      this.#applyBrainstormTrace(event.projectId, event.threadId, event.update)
      return
    }
    if (!('sessionId' in event)) return
    // A temporary chat's isolated session coming up, bind it so the shared
    // pipeline routes streaming events to the side chat like any thread.
    if (event.type === 'temporary-chat.started') {
      this.cache.setSessionId(event.projectId, event.temporaryChatId, event.sessionId)
      return
    }
    const target = this.cache.conversationForSession(event.sessionId)
    if (!target) return
    const { projectId, conversationId: threadId } = target

    // Live streaming activity is authoritative evidence the agent is still
    // working. A stray idle/status snapshot between activity blips must never
    // leave the thread idle, and fold its working trace, while parts keep
    // streaming (the definitive session.idle that ends the turn clears it).
    //
    // A terminal sub-agent card patch is the exception: it closes a worker that
    // already ended (completed, failed, or stopped by the user), so treating it
    // as activity would flip the row back to "working" right after the stop.
    const terminalSubagentPatch =
      event.type === 'message.part.updated' &&
      event.part.type === 'subagent' &&
      subagentStatusIsTerminal(event.part.activity.status)
    if (
      !terminalSubagentPatch &&
      (event.type === 'message.part.updated' || event.type === 'message.part.delta')
    ) {
      this.cache.setRunIssue(projectId, threadId, null)
      agentRuns.setBusy(
        projectId,
        threadId,
        true,
        this.cache.latestUserMessageId(projectId, threadId)
      )
    }

    switch (event.type) {
      case 'steer.held':
      case 'steer.delivered':
      case 'steer.discarded': {
        const entry = this.cache.entry(projectId, threadId)
        if (event.type === 'steer.held') {
          entry.heldSteerIds.add(event.userMessageId)
        } else {
          entry.heldSteerIds.delete(event.userMessageId)
          if (event.type === 'steer.discarded') {
            // The steer never reached the harness, remove the optimistic
            // message so the conversation looks untouched.
            entry.messages = entry.messages.filter((message) => message.id !== event.userMessageId)
          }
        }
        this.cache.notify(projectId, threadId)
        break
      }
      case 'message.part.updated':
        this.upsertPart(projectId, threadId, event.sessionId, event.part)
        break
      case 'message.part.delta':
        this.applyDelta(
          projectId,
          threadId,
          event.sessionId,
          event.messageId,
          event.partId,
          event.field,
          event.delta
        )
        break
      case 'message.completed':
        this.markCompleted(
          projectId,
          threadId,
          event.sessionId,
          event.messageId,
          event.error,
          event.compaction,
          event.tokens,
          event.contextWindow,
          event.contextUsed,
          event.contextEstimated,
          event.rateLimits,
          event.credits,
          event.bankedResets
        )
        break
      case 'usage.updated':
        this.updateUsage(
          projectId,
          threadId,
          event.sessionId,
          event.messageId,
          event.tokens,
          event.contextWindow,
          event.contextUsed,
          event.contextEstimated,
          event.cost,
          event.rateLimits,
          event.credits,
          event.bankedResets
        )
        break
      case 'session.status':
        if (event.status.state === 'working' || event.status.state === 'waiting') {
          this.cache.setRunIssue(projectId, threadId, null)
          // Track the scheduled reset so the header's activity badge can drop a
          // thread whose auto-retry is parked beyond the wake window; a working
          // status means no retry is pending anymore.
          agentRuns.setRetryAt(
            projectId,
            threadId,
            event.status.state === 'waiting' ? (event.status.issue.retryAt ?? null) : null
          )
          agentRuns.setBusy(
            projectId,
            threadId,
            true,
            this.cache.latestUserMessageId(projectId, threadId)
          )
        } else if (event.status.state === 'idle') {
          agentRuns.setRetryAt(projectId, threadId, null)
          agentRuns.completeSession(projectId, threadId)
        }
        break
      case 'session.idle':
        agentRuns.completeSession(projectId, threadId)
        break
      case 'session.error':
        agentRuns.setIdle(projectId, threadId)
        this.cache.setRunIssue(
          projectId,
          threadId,
          event.issue ?? {
            kind: 'unknown',
            message: event.error ?? 'The agent stopped with an unknown error.',
            rawError: event.error,
            harnessId: 'unknown',
            retryable: true
          }
        )
        break
    }
  }
}
