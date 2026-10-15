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
