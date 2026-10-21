import { describe, expect, it } from 'vitest'
import { formatTemporaryReferenceContext } from '../../src/main/chat/chat-engine/chat-engine-message-text'

/**
 * A side chat sends its selections as references, and the comment written on a
 * passage is the instruction that passage belongs to. Dropping it left the
 * harness quoting text with no idea what the user wanted done with it, so the
 * formatter has to carry it into the prompt.
 */
describe('formatTemporaryReferenceContext', () => {
  it('carries the comment written on a passage', () => {
    const context = formatTemporaryReferenceContext([
      { id: 'a', label: 'Selection 1', text: 'the quoted passage', comment: 'explain this bit' }
    ])
    expect(context).toContain('<selection 1>')
    expect(context).toContain('the quoted passage')
    expect(context).toContain('User comment: explain this bit')
  })

  it('sends a passage with no comment as context alone', () => {
    const context = formatTemporaryReferenceContext([
      { id: 'a', label: 'Selection 1', text: 'just the passage' }
    ])
    expect(context).toContain('just the passage')
    expect(context).not.toContain('User comment:')
  })

  it('numbers each passage and keeps the comment with its own text', () => {
    const context = formatTemporaryReferenceContext([
      { id: 'a', label: 'Selection 1', text: 'first', comment: 'about the first' },
      { id: 'b', label: 'Selection 2', text: 'second' }
    ])
    const first = context.indexOf('<selection 1>\nfirst\nUser comment: about the first')
    const second = context.indexOf('<selection 2>\nsecond')
    expect(first).toBeGreaterThanOrEqual(0)
    expect(second).toBeGreaterThan(first)
  })

  it('adds nothing when there is nothing to quote', () => {
    expect(formatTemporaryReferenceContext([])).toBe('')
    expect(formatTemporaryReferenceContext([{ id: 'a', label: 'Selection 1', text: '   ' }])).toBe(
      ''
    )
  })
})
