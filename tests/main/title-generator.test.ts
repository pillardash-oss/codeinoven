import { describe, expect, it } from 'vitest'
import {
  buildTitlePrompt,
  deriveTitleFromText,
  sanitizeGeneratedTitle,
  TITLE_INPUT_MAX
} from '../../src/main/chat/title-generator'

describe('thread title helpers', () => {
  it('caps the message a title request carries', () => {
    // Every title call is a disposable model turn paid per fresh thread, so a
    // pasted wall of content must never reach it whole.
    const prompt = buildTitlePrompt('x'.repeat(1_000))

    expect(prompt).toContain('<MSG_START>')
    expect(prompt).toContain('<MSG_END>')
    expect(prompt).toContain('x'.repeat(TITLE_INPUT_MAX))
    expect(prompt).not.toContain('x'.repeat(TITLE_INPUT_MAX + 1))
  })

  it('strips a label, quotes and trailing punctuation from a model reply', () => {
    expect(sanitizeGeneratedTitle('Title: "Fix the invoice preview."')).toBe(
      'Fix the invoice preview'
    )
    expect(sanitizeGeneratedTitle('**Retry the failing CI run**')).toBe('Retry the failing CI run')
  })

  it('stores a long title whole instead of baking an ellipsis into the row', () => {
    // The header truncates visually; a stored cut is not reversible. This is the
    // regression the fallback derivation already fixed.
    const long = 'Restore the comment indicator on a design thread inside the browser panel'
    expect(sanitizeGeneratedTitle(long)).toBe(long)
    expect(deriveTitleFromText(long)).toBe(long)
  })

  it('rejects an empty reply and a paragraph of chatter', () => {
    expect(sanitizeGeneratedTitle('   \n\n  ')).toBeNull()
    expect(sanitizeGeneratedTitle('word '.repeat(120))).toBeNull()
  })

  it('derives a fallback from the first non-empty line with markdown stripped', () => {
    expect(deriveTitleFromText('\n\n- ## Fix the invoice preview\nmore text')).toBe(
      'Fix the invoice preview'
    )
  })
})
