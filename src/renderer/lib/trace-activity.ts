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

/** How much of the agent's own words the line carries before it stops reading as
 *  a status line. */
const MAX_PROSE_CHARS = 480

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

/**
 * The newest paragraph the agent wrote, which is what the line reports.
 *
 * A step's text arrives as one growing block: its opening line never changes, so
 * a line that drew the block whole would keep showing what the agent said
 * minutes ago while the sentence it just wrote sits far below. The blank line the
 * agent ends a thought with is the boundary between what it is saying now and
 * what it said before, so only the last of those blocks is shown. A single
 * paragraph too long for the line keeps its own ending, because the newest words
 * are what a reader is looking for.
 */
export function newestProseParagraph(text: string, maxChars = MAX_PROSE_CHARS): string {
  const paragraphs = text.split(/\n{2,}/)
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const paragraph = paragraphs[i]?.trim() ?? ''
    if (!paragraph) continue
    if (paragraph.length <= maxChars) return paragraph
    const tail = paragraph.slice(paragraph.length - maxChars)
    const firstSpace = tail.search(/\s/)
    return `…${(firstSpace === -1 ? tail : tail.slice(firstSpace + 1)).trimStart()}`
  }
  return ''
}

/** The actions as the one line the reader sees: `Read ×3 · Shell · Edit`. */
export function traceActivitySummary(actions: readonly TraceActivityAction[]): string {
  return actions
    .map((action) => (action.count > 1 ? `${action.label} ×${action.count}` : action.label))
    .join(' · ')
}
