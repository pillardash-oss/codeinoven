import type { AgentPart } from '$shared/types'

/**
 * Keep one renderable lifecycle state per part ID while preserving the order in
 * which each part first appeared. Harnesses may repeat a tool call as its state
 * advances, and keyed Svelte lists require those lifecycle IDs to be unique.
 */
export function latestWorkingTraceParts(parts: AgentPart[]): AgentPart[] {
  const latestParts: AgentPart[] = []
  const indexesById = new Map<string, number>()

  for (const part of parts) {
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
