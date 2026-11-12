import { describe, expect, it } from 'vitest'
import { recruitedAssistantIntro, recruitedAssistantKnowledge } from '$shared/assistant-recruit'

/**
 * A recruited teammate arrives complete.
 *
 * Don hires it while the user is talking to Don, on a thread the user never opens,
 * so nothing can be left to an interview: the knowledge is written from the brief
 * at creation, which is what makes the next dispatched run a real run instead of
 * another setup pass.
 */
describe('recruitedAssistantKnowledge', () => {
  it('opens with the Personality section and carries the brief', () => {
    const knowledge = recruitedAssistantKnowledge({
      name: 'Scout',
      purpose: 'Watches the reporting inbox',
      request: 'Summarise the inbox every morning'
    })

    // Every assistant's knowledge opens with the section the authoring contract
    // names, so the run contract finds the persona where it expects it.
    expect(knowledge.startsWith('# Scout')).toBe(true)
    expect(knowledge).toContain('## Personality')
    expect(knowledge).toContain('## What you are for')
    expect(knowledge).toContain('Watches the reporting inbox')
    expect(knowledge).toContain('## The work you were hired for')
    expect(knowledge).toContain('Summarise the inbox every morning')
  })

  it("carries Don's own instructions ahead of the shared behavior", () => {
    const knowledge = recruitedAssistantKnowledge({
      name: 'Scout',
      purpose: 'Watches the reporting inbox',
      instructions: '## Personality\n\nYou are dry and brief.'
    })

    expect(knowledge).toContain('## Your instructions')
    expect(knowledge).toContain('You are dry and brief.')
    expect(knowledge.indexOf('## Your instructions')).toBeLessThan(
      knowledge.indexOf('## How you work')
    )
  })

  it('keeps the one thing only the user decides on the question card', () => {
    const knowledge = recruitedAssistantKnowledge({
      name: 'Scout',
      purpose: 'Watches the reporting inbox'
    })

    expect(knowledge).toContain('credential or a sign-in')
    expect(knowledge).toContain('Never hand that back as a question')
  })

  it('leaves the work open when no single request was waiting', () => {
    const knowledge = recruitedAssistantKnowledge({
      name: 'Scout',
      purpose: 'Watches the reporting inbox'
    })

    expect(knowledge).toContain('No single request was waiting')
  })
})

describe('recruitedAssistantIntro', () => {
  it('names the teammate, what it was built for and the request it took', () => {
    const intro = recruitedAssistantIntro({
      name: 'Scout',
      purpose: 'Watches the reporting inbox',
      request: 'Summarise the inbox every morning'
    })

    expect(intro).toContain("I'm Scout.")
    expect(intro).toContain('Watches the reporting inbox')
    expect(intro).toContain('Summarise the inbox every morning')
    expect(intro).not.toContain('?')
  })
})
