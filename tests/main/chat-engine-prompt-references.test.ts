import { describe, expect, it } from 'vitest'
import { validatePromptReferences } from '../../src/main/chat/chat-engine/chat-engine-pure'

/**
 * A prompt reference is the chip a sent message keeps, so the identity that makes
 * the chip work has to survive main's validation: a selection keeps its kind, and
 * a conversation attached as context keeps the thread (and project) it names, or
 * the chip on a reloaded message can no longer open what it points at.
 */
describe('validatePromptReferences', () => {
  it('keeps the kind of a selection reference', () => {
    const [reference] = validatePromptReferences([
      { id: 'a', label: 'Selection 1', text: 'a passage', kind: 'file' }
    ])
    expect(reference.kind).toBe('file')
  })

  it('keeps the thread an attached conversation names', () => {
    const [reference] = validatePromptReferences([
      {
        id: 'thread-1',
        label: 'Why the build broke',
        text: 'thread-1',
        kind: 'thread',
        threadId: 'thread-1',
        projectId: 'project-1'
      }
    ])
    expect(reference).toMatchObject({
      id: 'thread-1',
      label: 'Why the build broke',
      kind: 'thread',
      threadId: 'thread-1',
      projectId: 'project-1'
    })
  })

  it('refuses a thread reference with no thread', () => {
    expect(() =>
      validatePromptReferences([{ id: 'a', label: 'Attached', text: 'a', kind: 'thread' }])
    ).toThrow(/thread/)
  })

  it('refuses a kind it does not know', () => {
    expect(() =>
      validatePromptReferences([
        // A kind from a newer renderer is a version mismatch, not a selection.
        { id: 'a', label: 'Selection 1', text: 'a passage', kind: 'carrier-pigeon' as never }
      ])
    ).toThrow(/known kind/)
  })

  it('sends a reference without a kind unchanged', () => {
    const [reference] = validatePromptReferences([
      { id: 'a', label: 'Selection 1', text: 'a passage' }
    ])
    expect(reference).toEqual({ id: 'a', label: 'Selection 1', text: 'a passage' })
  })
})
