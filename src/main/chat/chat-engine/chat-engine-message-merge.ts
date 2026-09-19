import type { AgentMessage, ProviderCatalog, Thread } from '../../../lib/types'

/** One driver's catalog discovery: resolved catalogs, or an in-flight probe. */
export interface DriverDiscovery {
  catalogs: ProviderCatalog[] | undefined
  probe: Promise<ProviderCatalog[]>
}

export function mergeProviderCatalogs(catalogs: ProviderCatalog[]): ProviderCatalog[] {
  const merged = new Map<string, ProviderCatalog>()
  for (const catalog of catalogs) {
    // Key by harnessId:id   each harness exposes its own driver catalog. Two
    // harnesses may report the same provider id (e.g. codex and opencode both
    // expose `openai`); they must stay separate so model selection routes to
    // the harness that actually owns the model.
    const key = `${catalog.harnessId}:${catalog.id}`
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, {
        ...catalog,
        models: [...catalog.models]
      })
      continue
    }
    // Within the same harness, later catalogs may contribute additional models.
    const models = new Map(
      existing.models.map((model) => [`${model.providerId}:${model.id}`, model])
    )
    for (const model of catalog.models) {
      models.set(`${model.providerId}:${model.id}`, model)
    }
    existing.models = [...models.values()]
  }
  return [...merged.values()]
}

export function mergeAgentMessages(
  current: AgentMessage[],
  incoming: AgentMessage[]
): AgentMessage[] {
  const merged = new Map(current.map((message) => [message.id, message]))
  for (const message of incoming) {
    const existing = merged.get(message.id)
    // The on-disk user message is the presentation-safe source of truth. A
    // driver may receive additional hidden context under the same stable ID
    // (for example response annotations), which must never leak into the UI.
    if (existing?.role === 'user' && message.role === 'user') continue
    // Once a planning or dedicated-auditor answer has been reduced to working
    // trace, a later provider history load must not reintroduce terminal prose.
    if (
      existing?.role === 'assistant' &&
      existing.visibility === 'working_trace' &&
      message.role === 'assistant' &&
      message.visibility === 'conversation'
    ) {
      continue
    }
    merged.set(message.id, message)
  }
  return [...merged.values()].sort((left, right) => left.createdAt - right.createdAt)
}

export function classifyProviderMessages(
  messages: AgentMessage[],
  suppressTerminalAnswer = false
): AgentMessage[] {
  const latestUserIndex = suppressTerminalAnswer
    ? messages.findLastIndex((message) => message.role === 'user')
    : -1
  return messages.map((message, index) => {
    if (suppressTerminalAnswer && index > latestUserIndex && message.role === 'assistant') {
      return {
        ...message,
        origin: message.origin ?? 'provider',
        visibility: 'working_trace',
        parts: message.parts.filter((part) => part.type !== 'text')
      }
    }
    if (message.origin && message.visibility) return message
    const activityOnly =
      message.parts.length > 0 &&
      message.parts.every((part) => part.type === 'compaction' || part.type === 'subagent')
    if (message.role === 'user' && activityOnly) {
      return {
        ...message,
        origin: message.parts.some((part) => part.type === 'subagent') ? 'subagent' : 'compaction',
        visibility: 'working_trace'
      }
    }
    if (message.role === 'user') {
      return {
        ...message,
        origin: 'provider',
        visibility: 'hidden',
        parts: [],
        transportParts: message.parts,
        transportOrigin: 'provider'
      }
    }
    const compaction = message.parts.some(
      (part) => part.type === 'compaction' || part.type === 'compaction-summary'
    )
    return {
      ...message,
      origin: compaction ? 'compaction' : 'provider',
      visibility: compaction ? 'working_trace' : 'conversation'
    }
  })
}

export function isDedicatedAssignmentAuditorThread(thread: Thread | null | undefined): boolean {
  return (
    thread?.achievementRole === 'auditor' ||
    (thread?.assignmentId !== undefined &&
      thread.coordinatorThreadId !== undefined &&
      thread.assignmentRole === undefined)
  )
}

export function withoutTransportParts(message: AgentMessage): AgentMessage {
  const presentable = { ...message }
  delete presentable.transportParts
  delete presentable.transportOrigin
  return presentable
}

export function presentableMessages(
  messages: AgentMessage[],
  includeHiddenUserBoundaries = false
): AgentMessage[] {
  return messages
    .filter(
      (message) =>
        message.visibility === undefined ||
        message.visibility === 'conversation' ||
        message.visibility === 'working_trace' ||
        (includeHiddenUserBoundaries && message.visibility === 'hidden' && message.role === 'user')
    )
    .map((message) => {
      const presentable = withoutTransportParts(message)
      return includeHiddenUserBoundaries &&
        presentable.visibility === 'hidden' &&
        presentable.role === 'user'
        ? { ...presentable, visibility: 'working_trace' as const, parts: [] }
        : presentable
    })
}

/** Record which harness produced each message; drivers do not know their own id. */
export function stampHarnessId(messages: AgentMessage[], harnessId: string): AgentMessage[] {
  return messages.map((message) => (message.harnessId ? message : { ...message, harnessId }))
}

/** Record the account container and its label at the time the turn ran. */
export function stampAccount(
  messages: AgentMessage[],
  accountId: string,
  accountLabel: string
): AgentMessage[] {
  return messages.map((message) =>
    message.accountId ? message : { ...message, accountId, accountLabel }
  )
}

/**
 * Keep a message's persisted thinking level when the driver transcript omits it
 * (driver reloads and history loads never know the reasoning effort of past
 * turns). The on-disk mirror is the single source of truth for historical rows:
 * after a restart a driver can re-stamp an entire session with the current
 * turn's provenance, so any message already known to the mirror gets the
 * mirror's level   and a message the mirror never recorded a level for stays
 * unknown rather than inheriting the live turn's effort. Brand-new messages
 * (the turn being finalized) are not in the mirror, so their driver-stamped or
 * caller-stamped level is preserved.
 */
export function restoreMirrorThinkingLevel(
  merged: AgentMessage[],
  mirror: AgentMessage[]
): AgentMessage[] {
  if (mirror.length === 0) return merged
  const byId = new Map(mirror.map((message) => [message.id, message]))
  return merged.map((message) => {
    const persisted = byId.get(message.id)?.thinkingLevel
    if (persisted) {
      return message.thinkingLevel === persisted
        ? message
        : { ...message, thinkingLevel: persisted }
    }
    if (byId.has(message.id) && message.thinkingLevel) {
      return { ...message, thinkingLevel: undefined }
    }
    return message
  })
}

/** Keep historical account attribution immutable when a fresh account session
 *  was prefilled from the app mirror and reports those older messages again. */
export function restoreMirrorAccount(
  merged: AgentMessage[],
  mirror: AgentMessage[]
): AgentMessage[] {
  if (mirror.length === 0) return merged
  const byId = new Map(mirror.map((message) => [message.id, message]))
  return merged.map((message) => {
    const persisted = byId.get(message.id)
    if (!persisted) return message
    if (persisted.accountId) {
      return message.accountId === persisted.accountId &&
        message.accountLabel === persisted.accountLabel
        ? message
        : {
            ...message,
            accountId: persisted.accountId,
            accountLabel: persisted.accountLabel
          }
    }
    return message.accountId
      ? { ...message, accountId: undefined, accountLabel: undefined }
      : message
  })
}
