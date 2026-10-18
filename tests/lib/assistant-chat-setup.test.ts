import { describe, expect, it } from 'vitest'
import {
  ASSISTANT_CHAT_SETUP_ACTION,
  ASSISTANT_MANUAL_SETUP_ACTION,
  assistantManualSetupPrompt
} from '$shared/assistant-chat-setup'

/**
 * The opening turn for a form-created assistant. The user typed the name and the
 * personality, so the assistant has to sound like them from its first line, ask
 * only what to call the user, and send work to a new task rather than this thread.
 */
describe('assistantManualSetupPrompt', () => {
  it('states the name and the personality the form supplied', () => {
    const prompt = assistantManualSetupPrompt({
      name: 'Engineer',
      personality: 'blunt and quick'
    })
    expect(prompt).toContain('called Engineer')
    expect(prompt).toContain('blunt and quick')
  })

  it('asks only what to call the user, and says where a task goes', () => {
    const prompt = assistantManualSetupPrompt({ name: 'Engineer', personality: 'blunt' })
    expect(prompt).toContain('what they would like you to call them')
    expect(prompt).toContain('one nickname is the whole introduction')
    expect(prompt).toContain('New task button')
    expect(prompt).toContain('Cmd/Ctrl+N')
    expect(prompt).toContain('Never invite them to give you work in this thread')
  })

  it('omits a personality it was not given', () => {
    const prompt = assistantManualSetupPrompt({ name: 'Engineer' })
    expect(prompt).toContain('called Engineer')
    expect(prompt).not.toContain('described how it should behave')
  })

  it('keeps its own visible line, apart from the create-by-chat opening', () => {
    expect(ASSISTANT_MANUAL_SETUP_ACTION).not.toBe(ASSISTANT_CHAT_SETUP_ACTION)
  })
})
