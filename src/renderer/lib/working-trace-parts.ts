import type { AgentPart } from '$shared/types'

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
