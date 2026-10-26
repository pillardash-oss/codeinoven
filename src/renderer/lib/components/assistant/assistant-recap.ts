import type { Assistant, AgentMessage } from '$shared/types'
import { assistantIsScheduled } from '$shared/types'
import {
  extractAssistantPlanDraft,
  extractKnowledgeDraft,
  type AssistantPlanDraft
} from './assistant-view'

export interface AssistantRecapDraft {
  knowledge: string
  plan: AssistantPlanDraft | null
  at: number
}

/** Instructions and settings must come from the same recap, even after a repair. */
export function latestAssistantRecap(
  messages: readonly AgentMessage[],
  textOf: (message: AgentMessage) => string
): AssistantRecapDraft | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'assistant') continue
    const text = textOf(message)
    const knowledge = extractKnowledgeDraft(text)
    if (knowledge) {
      return { knowledge, plan: extractAssistantPlanDraft(text), at: message.createdAt }
    }
  }
  return null
}

/**
 * A revision that deletes saved instructions instead of building on them.
 *
 * The editing contract asks the agent for the complete revised instruction set,
 * and the agent is a model reproducing a document from its own memory. The
 * cheapest way to answer an edit is therefore the wrong one: write a short fresh
 * block and call it the replacement. That is what happened on Ola's Getting
 * started thread: "take note of my name" came back as a single line against a
 * page of saved instructions, and the recap card offered Save on it. Nothing
 * compared the two documents, so the only thing standing between a trusted
 * one-pager and one sentence was the user reading the card closely.
 *
 * This is that comparison. It reports the saved lines the revision no longer
 * carries, and stays quiet for the edits meant to be small: a line added, a
 * clause tightened, a sentence reworded. The threshold is what keeps it a guard
 * rather than a speed bump   a save that drops a tenth of the document is an
 * edit, and one that drops a quarter of it is a replacement someone should have
 * to look at before it lands.
 */
export interface AssistantKnowledgeLoss {
  /** The saved lines this revision drops, in the order they were saved. */
  removed: readonly string[]
  /** How many lines of instructions are saved now. */
  previousLines: number
  /** How many lines the revision leaves. */
  nextLines: number
}

/** A save this broken is a deletion, not an edit: three lines and a quarter. */
const KNOWLEDGE_LOSS_MIN_LINES = 3
const KNOWLEDGE_LOSS_SHARE = 0.25

/** The distinct, non-empty lines of a knowledge document, trimmed for comparing. */
function knowledgeLines(markdown: string): string[] {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const raw of markdown.split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || seen.has(line)) continue
    seen.add(line)
    lines.push(line)
  }
  return lines
}

/**
 * What a revision would delete from the knowledge it replaces, or null when it
 * only adds to it or rewords too little to be a replacement.
 */
export function assistantKnowledgeLoss(
  previous: string,
  next: string
): AssistantKnowledgeLoss | null {
  const saved = knowledgeLines(previous)
  if (saved.length === 0) return null
  const kept = new Set(knowledgeLines(next))
  const removed = saved.filter((line) => !kept.has(line))
  if (removed.length < KNOWLEDGE_LOSS_MIN_LINES) return null
  if (removed.length < Math.ceil(saved.length * KNOWLEDGE_LOSS_SHARE)) return null
  return { removed, previousLines: saved.length, nextLines: kept.size }
}

/** Never commit an initial recap with a clock or reporting agreement half filled. */
export function assistantSetupRecapIssue(
  assistant: Pick<Assistant, 'scheduled' | 'schedule' | 'delivery' | 'priority'> | null,
  plan: AssistantPlanDraft | null
): string | null {
  if (!plan) return 'The recap is missing valid assistant settings.'
  const scheduled = plan.scheduled ?? (assistant ? assistantIsScheduled(assistant) : true)
  if (scheduled && !plan.schedule && !assistant?.schedule) {
    return 'The scheduled assistant is missing its agreed run times.'
  }
  const delivery = plan.delivery ?? assistant?.delivery
  const priority = plan.priority ?? assistant?.priority
  if (delivery && !priority) return 'The reporting agreement is missing timeliness and impact.'
  if (priority && !delivery) return 'The reporting agreement is missing its delivery channel.'
  return null
}
