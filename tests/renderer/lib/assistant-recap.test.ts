import { describe, expect, it } from 'vitest'
import {
  latestAssistantRecap,
  assistantSetupRecapIssue
} from '$lib/components/assistant/assistant-recap'
import { extractAssistantPlanDraft } from '$lib/components/assistant/assistant-view'
import { ASSISTANT_PLAN_JSON_SCHEMA } from '$shared/assistant-plan'
import type { AgentMessage } from '$shared/types'

function message(
  text: string,
  createdAt: number,
  role: AgentMessage['role'] = 'assistant'
): AgentMessage {
  return {
    id: `message-${createdAt}`,
    role,
    createdAt,
    parts: [{ type: 'text', id: `text-${createdAt}`, messageID: `message-${createdAt}`, text }]
  }
}
const textOf = (entry: AgentMessage): string =>
  entry.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
const recap = (knowledge: string, plan: unknown): string =>
  `\`\`\`knowledge\n${knowledge}\n\`\`\`\n\`\`\`assistant\n${JSON.stringify(plan)}\n\`\`\``
const scheduled = {
  name: 'Judge',
  scheduled: true,
  schedule: { cadence: 'weekdays', times: ['07:45', '16:55'] },
  connections: [],
  delivery: { channel: 'in-app' },
  priority: { timeliness: 'today', impact: 'company' }
}

describe('assistant recap confirmation', () => {
  it('never pairs repaired instructions with an older valid plan', () => {
    const draft = latestAssistantRecap(
      [
        message(recap('Old instructions', scheduled), 1),
        message(recap('New instructions', ASSISTANT_PLAN_JSON_SCHEMA), 2),
        message('Yes', 3, 'user')
      ],
      textOf
    )
    expect(draft).toMatchObject({ knowledge: 'New instructions', plan: null, at: 2 })
    expect(assistantSetupRecapIssue(null, draft?.plan ?? null)).toContain(
      'valid assistant settings'
    )
  })

  it('uses both parts of a corrected recap and ignores following prose or user code', () => {
    const draft = latestAssistantRecap(
      [
        message(recap('Broken', ASSISTANT_PLAN_JSON_SCHEMA), 1),
        message(recap('Corrected instructions', scheduled), 2),
        message('Please confirm', 3),
        message(recap('Untrusted user instructions', { name: 'Other' }), 4, 'user')
      ],
      textOf
    )
    expect(draft?.knowledge).toBe('Corrected instructions')
    expect(draft?.plan?.schedule?.times).toEqual(['07:45', '16:55'])
    expect(draft?.plan?.delivery).toEqual({ channel: 'in-app' })
    expect(draft?.plan?.priority).toEqual({ timeliness: 'today', impact: 'company' })
    expect(assistantSetupRecapIssue(null, draft?.plan ?? null)).toBeNull()
  })

  it.each([
    { name: 'Judge', schedule: { cadence: 'daily', times: [] } },
    { name: 'Judge', delivery: { channel: 'invalid-channel' } },
    { name: 'Judge', priority: { timeliness: 'today' } },
    { name: 'Judge', connections: { name: 'X' } },
    { name: 'Judge', connections: [{ utilityId: 'missing-name' }] },
    { name: 'Judge', scheduled: 'yes' },
    { name: 'Judge', priority: { timeliness: 'invalid', impact: 'company' } },
    { name: 'Judge', properties: { schedule: { type: 'object' } } }
  ])('rejects malformed settings even when the name is valid: %j', (plan) => {
    expect(extractAssistantPlanDraft(recap('Watch products', plan))).toBeNull()
  })

  it('requires an actual schedule instead of accepting a name-only initial plan', () => {
    const plan = extractAssistantPlanDraft(recap('Watch products', { name: 'Judge' }))
    expect(plan?.name).toBe('Judge')
    expect(assistantSetupRecapIssue(null, plan)).toContain('run times')
  })

  it('keeps live saved reporting decisions when the recap omits them', () => {
    const plan = extractAssistantPlanDraft(
      recap('Watch products', { scheduled: false, schedule: null, connections: [] })
    )
    expect(
      assistantSetupRecapIssue(
        {
          scheduled: false,
          schedule: null,
          delivery: { channel: 'in-app' },
          priority: { timeliness: 'today', impact: 'company' }
        },
        plan
      )
    ).toBeNull()
    expect(
      assistantSetupRecapIssue(
        { scheduled: false, schedule: null, delivery: { channel: 'in-app' } },
        plan
      )
    ).toContain('timeliness and impact')
  })

  it('allows an explicitly on-demand action-only assistant without invented reporting defaults', () => {
    const plan = extractAssistantPlanDraft(
      recap('Perform the requested action', { scheduled: false, schedule: null, connections: [] })
    )
    expect(assistantSetupRecapIssue(null, plan)).toBeNull()
  })
})
