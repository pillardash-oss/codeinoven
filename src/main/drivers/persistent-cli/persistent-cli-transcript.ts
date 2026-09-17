import type { AgentEvent, AgentMessage, SessionAgentEvent, ThinkingLevel } from '../../../lib/types'
import { estimateTokenCostUsd } from '../../providers/pricing'
import {
  isPermissionToolName,
  isQuestionToolName,
  normalizeAgentQuestions,
  permissionPatterns
} from '../../../lib/agent-interactions'
import type { PersistentCliSession } from './persistent-cli-types'

export interface TurnProvenance {
  providerId?: string
  modelId?: string
  thinkingLevel?: ThinkingLevel
}

export function mergeSessionMessages(
  session: PersistentCliSession,
  messages: AgentMessage[],
  provenance: TurnProvenance | undefined,
  driverId: string
): void {
  for (const raw of messages) {
    const message: AgentMessage = {
      ...raw,
      providerId: raw.providerId ?? provenance?.providerId,
      modelId: raw.modelId ?? provenance?.modelId,
      thinkingLevel: raw.thinkingLevel ?? provenance?.thinkingLevel,
      harnessId: raw.harnessId ?? driverId
    }
    const index = session.messages.findIndex((current) => current.id === message.id)
    if (index === -1) session.messages.push(message)
    else session.messages[index] = message
  }
  session.messages.sort((left, right) => left.createdAt - right.createdAt)
}

/**
 * When a harness reports tokens but no dollar cost, fill in an estimate from
 * the local model-catalog pricing so usage reports aren't zero. Only applies
 * when cost is genuinely missing; a provider-reported cost is never replaced.
 */
export function estimateMissingCost(message: AgentMessage): void {
  if (typeof message.cost === 'number') return
  const estimated = estimateTokenCostUsd(message.modelId, message.providerId, message.tokens)
  if (estimated === null) return
  message.cost = estimated
  message.costProvenance = {
    source: 'model_catalog',
    sourceId: message.modelId,
    currency: 'USD',
    capturedAt: message.completedAt ?? message.createdAt ?? Date.now()
  }
}

/**
 * Apply one stream event to a transcript. Sessions keep their transcript on
 * the session record, but a harness-native child session has no app session
 * record of its own   the pi driver tracks delegated sub-agent transcripts
 * as a plain message list, and both paths must fold events identically so a
 * child transcript renders exactly like a root one.
 */
export function foldEventIntoMessages(messages: AgentMessage[], event: AgentEvent): void {
  if (event.type === 'message.part.updated') {
    const message = messages.findLast((candidate) => candidate.id === event.part.messageID)
    if (!message) return
    const index = message.parts.findLastIndex((part) => part.id === event.part.id)
    if (index === -1) message.parts.push(event.part)
    else message.parts[index] = event.part
    return
  }
  if (event.type === 'message.part.delta') {
    const message = messages.findLast((candidate) => candidate.id === event.messageId)
    const part = message?.parts.findLast((candidate) => candidate.id === event.partId)
    if (part && (part.type === 'text' || part.type === 'reasoning') && event.field === 'text') {
      part.text += event.delta
    }
    return
  }
  if (event.type === 'message.completed') {
    const message = messages.findLast((candidate) => candidate.id === event.messageId)
    if (message) {
      message.completedAt = Date.now()
      message.error = event.error
      if (event.tokens) message.tokens = event.tokens
      if (event.normalizedUsage) message.normalizedUsage = event.normalizedUsage
      if (event.contextWindow !== undefined) message.contextWindow = event.contextWindow
      if (event.contextUsed !== undefined) message.contextUsed = event.contextUsed
      if (event.contextEstimated !== undefined) message.contextEstimated = event.contextEstimated
      if (event.rateLimits) message.rateLimits = event.rateLimits
      if (event.credits) message.credits = event.credits
      if (event.bankedResets) message.bankedResets = event.bankedResets
      estimateMissingCost(message)
    }
  }
  if (event.type === 'usage.updated') {
    const message = messages.findLast((candidate) => candidate.id === event.messageId)
    if (message) {
      if (event.tokens) message.tokens = event.tokens
      if (event.normalizedUsage) message.normalizedUsage = event.normalizedUsage
      if (event.contextWindow !== undefined) message.contextWindow = event.contextWindow
      if (event.contextUsed !== undefined) message.contextUsed = event.contextUsed
      if (event.contextEstimated !== undefined) message.contextEstimated = event.contextEstimated
      if (event.cost !== undefined) message.cost = event.cost
      if (event.rateLimits) message.rateLimits = event.rateLimits
      if (event.credits) message.credits = event.credits
      if (event.bankedResets) message.bankedResets = event.bankedResets
      estimateMissingCost(message)
    }
  }
}

function interactionRequestId(
  driverId: string,
  kind: string,
  sessionId: string,
  providerId: string
): string {
  return `${driverId}-${kind}-${sessionId}-${providerId}`
    .replace(/[^a-zA-Z0-9._-]/gu, '-')
    .slice(0, 256)
}

function interactionKey(kind: string, sessionId: string, requestId: string): string {
  return `${kind}:${sessionId}:${requestId}`
}

/** Promote JSONL question/approval tool parts into the shared interaction stream. */
export function normalizeCliInteractionEvents(
  driverId: string,
  seen: Set<string>,
  sessionId: string,
  events: SessionAgentEvent[]
): SessionAgentEvent[] {
  const normalized: SessionAgentEvent[] = []
  for (const event of events) {
    normalized.push(event)
    if (event.type === 'question.asked') {
      seen.add(interactionKey('question', sessionId, event.requestId))
      continue
    }
    if (event.type !== 'message.part.updated') continue
    const part = event.part
    if (part.type === 'question') {
      const requestId = interactionRequestId(
        driverId,
        'question',
        sessionId,
        part.callID ?? part.id
      )
      const key = interactionKey('question', sessionId, requestId)
      if (seen.has(key)) continue
      seen.add(key)
      normalized.push({
        type: 'question.asked',
        sessionId,
        requestId,
        questions: [{ ...part.question, requestId }],
        tool: { messageID: part.messageID, callID: part.callID ?? part.id }
      })
      continue
    }
    if (part.type !== 'tool') continue
    const active = part.state.status === 'pending' || part.state.status === 'running'
    if (!active) continue
    const requestId = interactionRequestId(
      driverId,
      'interaction',
      sessionId,
      part.callID || part.id
    )
    if (isQuestionToolName(part.tool)) {
      const key = interactionKey('question', sessionId, requestId)
      if (seen.has(key)) continue
      seen.add(key)
      normalized.push({
        type: 'question.asked',
        sessionId,
        requestId,
        questions: normalizeAgentQuestions(part.state.input),
        tool: { messageID: part.messageID, callID: part.callID }
      })
      continue
    }
    if (!isPermissionToolName(part.tool)) continue
    const key = interactionKey('permission', sessionId, requestId)
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push({
      type: 'permission.asked',
      sessionId,
      permission: {
        id: requestId,
        sessionId,
        permission: part.tool,
        patterns: permissionPatterns(part.state.input),
        metadata: { tool: part.tool, input: part.state.input }
      }
    })
  }
  return normalized
}
