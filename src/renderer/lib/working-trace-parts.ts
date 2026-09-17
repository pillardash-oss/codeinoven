import type { AgentPart } from '$shared/types'
import { subagentStatusIsTerminal } from './subagent-presentation'

export type SubagentPart = Extract<AgentPart, { type: 'subagent' }>

/**
 * Keep one renderable lifecycle state per part ID while preserving the order in
 * which each part first appeared. Harnesses may repeat a tool call as its state
 * advances, and keyed Svelte lists require those lifecycle IDs to be unique.
 *
 * Parts that render as nothing — empty text placeholders emitted at each step
 * start and step markers without a reason — are dropped first so the header
 * count always matches the number of visible trace entries.
 */
export function latestWorkingTraceParts(parts: AgentPart[]): AgentPart[] {
  const renderable = parts.filter((part) => {
    if (part.type === 'text') return part.text.trim().length > 0
    if (part.type === 'step-finish') return Boolean(part.reason)
    return true
  })
  const latestParts: AgentPart[] = []
  const indexesById = new Map<string, number>()

  for (const part of renderable) {
    const existingIndex = indexesById.get(part.id)
    if (existingIndex === undefined) {
      indexesById.set(part.id, latestParts.length)
      latestParts.push(part)
      continue
    }
    latestParts[existingIndex] = part
  }

  return latestParts
}

/**
 * A live turn must mount the trace shell even before its first part streams
 * in — otherwise a busy thread renders as a bare "Working..." line with no
 * card, instead of the spinner/header that tells the user something is
 * actually happening.
 */
export function shouldMountWorkingTrace(turnPartsLength: number, traceIsLive: boolean): boolean {
  return turnPartsLength > 0 || traceIsLive
}

/**
 * Fold one sub-agent lifecycle snapshot onto the previous one. A worker streams
 * partial activity (it starts before its model is known, its description is
 * refined, its output arrives at the end), so every later snapshot only fills
 * gaps and never erases what already landed.
 */
export function mergeSubagentParts(current: SubagentPart, update: SubagentPart): SubagentPart {
  const currentTime = current.activity.time
  const updateTime = update.activity.time
  const start = currentTime?.start ?? updateTime?.start
  return {
    ...current,
    activity: {
      ...current.activity,
      status: update.activity.status,
      agent: update.activity.agent || current.activity.agent,
      description:
        update.activity.description === 'Delegated task'
          ? current.activity.description
          : update.activity.description,
      prompt: update.activity.prompt ?? current.activity.prompt,
      childSessionId: update.activity.childSessionId ?? current.activity.childSessionId,
      providerTaskId: update.activity.providerTaskId ?? current.activity.providerTaskId,
      providerId: update.activity.providerId ?? current.activity.providerId,
      modelId: update.activity.modelId ?? current.activity.modelId,
      background: current.activity.background || update.activity.background,
      output: update.activity.output ?? current.activity.output,
      error: update.activity.error ?? current.activity.error,
      time: start !== undefined ? { start, end: updateTime?.end ?? currentTime?.end } : undefined
    }
  }
}

/**
 * A part has finished its lifecycle when its terminal status or an explicit end
 * timestamp is present. Terminal snapshots must always win part merges: letting
 * a stale `running` snapshot survive keeps tool durations ticking forever after
 * the call actually completed.
 */
function isTerminalWorkingPart(part: AgentPart): boolean {
  if (part.type === 'tool') {
    return (
      part.state.status === 'completed' ||
      part.state.status === 'error' ||
      part.state.time?.end !== undefined
    )
  }
  if (part.type === 'subagent') {
    return subagentStatusIsTerminal(part.activity.status) || part.activity.time?.end !== undefined
  }
  return false
}

/** Pick the snapshot of one part that carries the most complete lifecycle. */
function moreCompleteWorkingPart(current: AgentPart, incoming: AgentPart): AgentPart {
  if (
    current.type === incoming.type &&
    isTerminalWorkingPart(current) !== isTerminalWorkingPart(incoming)
  ) {
    // Whichever side carries the terminal lifecycle state wins, regardless of
    // which list was passed as "preferred".
    return isTerminalWorkingPart(incoming) ? incoming : current
  }
  if (
    current.type === incoming.type &&
    (current.type === 'text' || current.type === 'reasoning') &&
    (incoming.type === 'text' || incoming.type === 'reasoning')
  ) {
    if (incoming.text.startsWith(current.text) && incoming.text.length > current.text.length) {
      return incoming
    }
    if (current.text.startsWith(incoming.text) && current.text.length > incoming.text.length) {
      return current
    }
  }
  if (current.type === 'subagent' && incoming.type === 'subagent') {
    return mergeSubagentParts(current, incoming)
  }
  return current
}

/**
 * Merge two views of the same turn's parts, deduped by id and ordered by
 * `preferred` first-seen order.
 *
 * Order is the whole point: a working trace window is pinned to an entry and
 * only ever grows at its tail, so the assembled list must be in stream order.
 * The durable stream log is that order (the fold keeps first-seen order), and
 * parts only the mirror holds are appended after it. `preferred` never erases a
 * fallback copy: whichever snapshot carries the terminal lifecycle state or the
 * longer text wins.
 */
export function mergeWorkingParts(
  preferred: readonly AgentPart[],
  fallback: readonly AgentPart[]
): AgentPart[] {
  const byId: Map<string, AgentPart> = new Map()
  const order: string[] = []
  for (const part of preferred) {
    if (!byId.has(part.id)) order.push(part.id)
    byId.set(part.id, part)
  }
  for (const part of fallback) {
    const existing = byId.get(part.id)
    if (existing === undefined) {
      order.push(part.id)
      byId.set(part.id, part)
    } else {
      byId.set(part.id, moreCompleteWorkingPart(existing, part))
    }
  }
  const merged: AgentPart[] = []
  for (const id of order) {
    const part = byId.get(id)
    if (part) merged.push(part)
  }
  return merged
}
