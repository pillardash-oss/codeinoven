import { describe, expect, it } from 'vitest'
import {
  ASSISTANT_CHAT_SETUP_ACTION,
  ASSISTANT_MANUAL_SETUP_ACTION,
  assistantManualSetupPrompt
} from '$shared/assistant-chat-setup'

/**
 * The opening turn for a form-created assistant. The user typed the name and the
 * description, so the assistant opens as the name they chose and uses the
 * description to orient itself, asks how they want it to behave and what to call
 * them, and sends work to a new task rather than this thread.
 */
describe('assistantManualSetupPrompt', () => {
  it('states the name and the description the form supplied', () => {
    const prompt = assistantManualSetupPrompt({
      name: 'Engineer',
      description: 'Keeps my repos tidy'
    })
    expect(prompt).toContain('called Engineer')
    expect(prompt).toContain('Keeps my repos tidy')
  })

  it('asks how to behave and what to call the user, and says where a task goes', () => {
    const prompt = assistantManualSetupPrompt({ name: 'Engineer', description: 'blunt' })
    expect(prompt).toContain('what they would like you to call them')
    expect(prompt).toContain('one nickname is the whole introduction')
    expect(prompt).toContain('starting with how they want you to behave')
    expect(prompt).toContain('New task button')
    expect(prompt).toContain('Cmd/Ctrl+N')
    expect(prompt).toContain('Never invite them to give you work in this thread')
  })

  it('omits a description it was not given', () => {
    const prompt = assistantManualSetupPrompt({ name: 'Engineer' })
    expect(prompt).toContain('called Engineer')
    expect(prompt).not.toContain('they described what it is for')
  })

  it('keeps its own visible line, apart from the create-by-chat opening', () => {
    expect(ASSISTANT_MANUAL_SETUP_ACTION).not.toBe(ASSISTANT_CHAT_SETUP_ACTION)
  })
})
