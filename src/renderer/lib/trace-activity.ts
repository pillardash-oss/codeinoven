import { toolActionLabel } from '$shared/tool-action-label'
import type { AgentPart } from '$shared/types'
import { groupTraceIntoChains, latestWorkingTraceParts } from './working-trace-parts'

/** One kind of action the step in flight performed, and how often. */
export interface TraceActivityAction {
  label: string
  count: number
}

/** What the line under the transcript should say about the work happening now. */
export interface TraceActivityLine {
  /** The newest words the agent wrote when its step's work was done, or ''. */
  prose: string
  /** The step in flight, oldest first, consecutive repeats counted. */
  actions: TraceActivityAction[]
}

/** How much of a model-written action phrase the line carries before it stops
 *  reading as a summary and starts reading as a paragraph. */
const MAX_LABEL_CHARS = 48

/** Shorten one label to what the line can show without cutting the newest off. */
function shortenedLabel(label: string): string {
  const trimmed = label.trim()
  return trimmed.length > MAX_LABEL_CHARS ? `${trimmed.slice(0, MAX_LABEL_CHARS - 1)}…` : trimmed
}

/**
 * The action a single step performed, in the app's own vocabulary.
 *
 * It reads the label the step's own trace row carries, so the line and the row
 * it summarizes can never disagree. A call whose action cannot be named without
 * repeating a raw tool name contributes nothing rather than an identifier the
 * reader would not recognize.
 */
export function traceActivityAction(part: AgentPart): string | null {
  if (part.type === 'tool') {
    const label =
      part.actionLabel ??
      toolActionLabel({
        tool: part.tool,
        input: part.state.input,
        title: part.state.title,
        titleIsSubject: part.state.titleIsSubject,
        output: part.state.output,
        codeMode: part.codeMode
      })
    return label ? shortenedLabel(label) : null
  }
  if (part.type === 'reasoning') return 'Thinking'
  if (part.type === 'subagent') return 'Delegated'
  if (part.type === 'compaction' || part.type === 'compaction-summary') return 'Compacted context'
  return null
}

/**
 * What the line under the transcript says about the turn in flight.
 *
 * A turn reads as a sequence of steps that each end in the agent saying what it
 * found, so the line reports the newest of those two things: the words the
 * agent just wrote, and failing that, the shape of the work it is doing now.
 * The turn's closing message replaces it, which is why the line only ever
 * describes work that has not been answered yet.
 */
export function traceActivityLine(parts: AgentPart[], maxActions = 3): TraceActivityLine {
  const chain = groupTraceIntoChains(latestWorkingTraceParts(parts)).at(-1)
  const prose = chain?.output?.text.trim() ? (chain.output.text ?? '') : ''
  const actions: TraceActivityAction[] = []
  for (const step of chain?.steps ?? []) {
    const label = traceActivityAction(step)
    if (!label) continue
    const previous = actions.at(-1)
    if (previous?.label === label) previous.count += 1
    else actions.push({ label, count: 1 })
  }
  return { prose, actions: actions.slice(-maxActions) }
}

/** The actions as the one line the reader sees: `Read ×3 · Shell · Edit`. */
export function traceActivitySummary(actions: readonly TraceActivityAction[]): string {
  return actions
    .map((action) => (action.count > 1 ? `${action.label} ×${action.count}` : action.label))
    .join(' · ')
}
