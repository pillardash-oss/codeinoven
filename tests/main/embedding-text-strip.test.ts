import { describe, expect, it } from 'vitest'
import { stripCodeAndDiagrams } from '../../src/lib/search/embedding-text'

/**
 * A vector made mostly of syntax retrieves syntax.
 *
 * Windows used to embed fenced code and diagram source as ordinary prose, which
 * made a 4 K-character window need its whole 2047-token budget (7.6 s of one core,
 * measured) and lose its tail to the cap. These tests pin what leaves the document
 * and, just as importantly, what stays: inline identifiers and the conversation
 * around a block.
 */
describe('stripCodeAndDiagrams', () => {
  it('removes a fenced block and keeps the prose either side of it', () => {
    const text = [
      'We discussed the retry policy at length.',
      '```ts',
      'const delay = Math.min(backoff * attempt, 10_000)',
      '```',
      'Then the queue drained on its own.'
    ].join('\n')
    const stripped = stripCodeAndDiagrams(text)
    expect(stripped).toContain('We discussed the retry policy at length.')
    expect(stripped).toContain('Then the queue drained on its own.')
    expect(stripped).not.toContain('Math.min')
    expect(stripped).not.toContain('```')
  })

  it('removes mermaid source, which is how a diagram reaches a text part', () => {
    const text = 'Here is the flow.\n```mermaid\ngraph TD\n  A[click] --> B[queue]\n```\nIt blocks.'
    const stripped = stripCodeAndDiagrams(text)
    expect(stripped).not.toContain('graph TD')
    expect(stripped).not.toContain('-->')
    expect(stripped).toContain('Here is the flow.')
    expect(stripped).toContain('It blocks.')
  })

  it('removes inline svg artifact markup', () => {
    const text = 'The board:\n<svg viewBox="0 0 10 10"><rect width="10" /></svg>\nDone.'
    const stripped = stripCodeAndDiagrams(text)
    expect(stripped).not.toContain('<rect')
    expect(stripped).toContain('The board:')
    expect(stripped).toContain('Done.')
  })

  it('keeps inline code, which is a concept rather than a program', () => {
    const text = 'Set `retentionDays` to 90 and the sweep stops scanning `usage_events`.'
    expect(stripCodeAndDiagrams(text)).toBe(text)
  })

  it('removes every block in a window, not one region between the outer pair', () => {
    const text = 'a\n```\nfirst()\n```\nmiddle words here\n```\nsecond()\n```\nz'
    const stripped = stripCodeAndDiagrams(text)
    expect(stripped).not.toContain('first()')
    expect(stripped).not.toContain('second()')
    expect(stripped).toContain('middle words here')
  })

  it('handles tilde fences and a block at the very start or end', () => {
    const leading = '~~~\ncode()\n~~~\ntail prose'
    expect(stripCodeAndDiagrams(leading)).toBe('tail prose')
    const trailing = 'head prose\n```\ncode()\n```'
    expect(stripCodeAndDiagrams(trailing)).toBe('head prose')
  })

  it('leaves text that has no code untouched, byte for byte', () => {
    const text = 'Ordinary conversation.\n\nWith paragraph breaks and a `symbol`.'
    expect(stripCodeAndDiagrams(text)).toBe(text)
  })

  it('never fuses the words around a block into one token', () => {
    const stripped = stripCodeAndDiagrams('before\n```\nx\n```\nafter')
    expect(stripped).toContain('before')
    expect(stripped).toContain('after')
    expect(stripped).not.toContain('beforeafter')
  })
})
