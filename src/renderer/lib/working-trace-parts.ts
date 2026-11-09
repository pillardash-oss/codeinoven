import type { AgentPart } from '$shared/types'
import { isCodeModeToolName } from '$shared/agent-interactions'
import { isCompactionPart, traceSpanOfParts, type TraceSpan } from '$shared/working-trace-span'
import { subagentStatusIsTerminal } from './subagent-presentation'

export type SubagentPart = Extract<AgentPart, { type: 'subagent' }>
export type TraceTextPart = Extract<AgentPart, { type: 'text' }>

/** True when a part is a sub-agent step, so a list can be narrowed in one pass. */
export function isSubagentPart(part: AgentPart): part is SubagentPart {
  return part.type === 'subagent'
}

/**
 * The turn's delegation, from the durable fold plus whatever is mounted.
 *
 * The trace header may not learn about sub-agents from the mounted rows alone: a
 * trace mounts one bounded page at a time and sub-agents are spawned near the
 * start of a long turn, so the page on screen often holds none of them. The fold
 * therefore carries every sub-agent step of the turn beside the window, and this
 * merges it with the rows in view, keeping the fold's order.
 *
 * A mounted snapshot wins over the fold's copy, because the live stream is what
 * advances a worker (running, then completed) between two window reads. The one
 * exception is a finished worker: a stale `running` copy can never take back a
 * status the other side already reported as terminal.
 */
export function mergeTurnSubagents(
  turnWide: readonly SubagentPart[],
  mounted: readonly SubagentPart[]
): SubagentPart[] {
  const byId = new Map<string, SubagentPart>()
  const order: string[] = []
  for (const part of turnWide) {
    if (!byId.has(part.id)) order.push(part.id)
    byId.set(part.id, part)
  }
  for (const part of mounted) {
    const existing = byId.get(part.id)
    if (existing === undefined) {
      order.push(part.id)
      byId.set(part.id, part)
      continue
    }
    byId.set(part.id, subagentIsSettled(existing) ? existing : part)
  }
  const merged: SubagentPart[] = []
  for (const id of order) {
    const part = byId.get(id)
    if (part) merged.push(part)
  }
  return merged
}

/** True once a sub-agent step reported a terminal lifecycle state. */
function subagentIsSettled(part: SubagentPart): boolean {
  return subagentStatusIsTerminal(part.activity.status) || part.activity.time?.end !== undefined
}

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
    if (part.type === 'step-start') return false
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
 * One chain of thought in a turn's trace: the thinking and tool work an agent
 * runs, closed by the text it writes when it stops to report.
 */
export interface TraceChain {
  /**
   * Stable key for the chain. A chain that produced an output is keyed by that
   * output's id, because the text is the boundary that defines it and older
   * entries can only ever be added before it. A trailing chain with no output
   * yet is keyed by its first step.
   *
   * The first step is deliberately not the key for an output chain: paging an
   * older page into the window prepends steps to the chain the window starts
   * inside, which would change a first-step key and remount the chain  and
   * replay its fold  for nothing.
   */
  id: string
  /** Reasoning, tool, sub-agent, compaction and file entries behind the output. */
  steps: AgentPart[]
  /** The text this chain produced, or null while its work is still in flight. */
  output: TraceTextPart | null
}

/**
 * Group a turn's trace entries into chains of thought.
 *
 * A chain of thought is the work an agent does before it says something: the
 * reasoning and tool calls it runs, closed by the text it writes when it stops
 * to report. Grouping on the text is what keeps a long trace readable, because
 * each block the agent wrote is the outcome of the steps above it, so the trace
 * reads as a sequence of answered questions instead of one flat log.
 *
 * The turn's closing statement is not in this list (the transcript renders it),
 * so the steps that led to the answer form a trailing chain with no output.
 * Models that never reason still group correctly: their tool runs sit between
 * whatever running commentary the harness recorded as text.
 */
export function groupTraceIntoChains(parts: readonly AgentPart[]): TraceChain[] {
  const chains: TraceChain[] = []
  let steps: AgentPart[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      chains.push({ id: part.id, steps, output: part })
      steps = []
      continue
    }
    steps.push(part)
  }
  if (steps.length > 0) chains.push({ id: steps[0].id, steps, output: null })
  return chains
}

/**
 * Wall-clock window one step occupied, when the harness reported timestamps.
 * The span itself lives in shared code: the main process measures the whole
 * folded turn with the same helper, so the trace header and the rows under it
 * can never disagree.
 */
export type TraceChainSpan = TraceSpan

/** The wall-clock span a chain's steps occupied, or null when none reported one. */
export function traceChainSpan(chain: TraceChain): TraceChainSpan | null {
  return traceSpanOfParts(chain.steps)
}

/**
 * What a chain of thought holds, for the per-chain markers on its header: a
 * compaction, how many sub-agents it delegated to, and whether it ran code-mode
 * work. It lets a reader see where an action happened without opening the
 * steps, while the trace header keeps the turn-wide totals.
 */
export interface TraceChainMarkers {
  compacted: boolean
  subagentCount: number
  codeMode: boolean
}

export function traceChainMarkers(chain: TraceChain): TraceChainMarkers {
  let compacted = false
  let subagentCount = 0
  let codeMode = false
  for (const step of chain.steps) {
    if (isCompactionPart(step)) compacted = true
    else if (step.type === 'subagent') subagentCount += 1
    else if (step.type === 'tool' && (step.codeMode === true || isCodeModeToolName(step.tool))) {
      codeMode = true
    }
  }
  return { compacted, subagentCount, codeMode }
}

/**
 * The wall-clock span an entire trace occupied: the earliest start to the
 * latest end across every entry it holds. This is what the trace header shows
 * as the turn's total duration, so it reads the same whether the work arrived
 * as one chain or several.
 */
export function tracePartsSpan(parts: readonly AgentPart[]): TraceChainSpan | null {
  return traceSpanOfParts(parts)
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
