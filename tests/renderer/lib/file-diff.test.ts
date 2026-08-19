import { describe, expect, it } from 'vitest'
import { diffDetails, type DiffLine } from '../../../src/renderer/lib/components/files/file-diff'

/** Build `count` distinct, mostly-unique filler lines so line-shift tests are realistic. */
function filler(count: number, tag: string): string[] {
  return Array.from({ length: count }, (_, index) => `${tag}-line-${index}-${'x'.repeat(20)}`)
}

function changedKinds(diff: ReturnType<typeof diffDetails>): { added: number; deleted: number } {
  return {
    added: diff.lines.filter((line) => line.kind === 'added').length,
    deleted: diff.lines.filter((line) => line.kind === 'deleted').length
  }
}

function lineNumbersValid(lines: DiffLine[], beforeCount: number, afterCount: number): boolean {
  return lines.every((line) => {
    if (line.beforeLine !== undefined && (line.beforeLine < 1 || line.beforeLine > beforeCount)) {
      return false
    }
    if (line.afterLine !== undefined && (line.afterLine < 1 || line.afterLine > afterCount)) {
      return false
    }
    return true
  })
}

describe('diffDetails', () => {
  it('diffs a small file exactly', () => {
    const before = ['a', 'b', 'c', 'd']
    const after = ['a', 'B', 'c', 'd', 'e']
    const diff = diffDetails(before.join('\n'), after.join('\n'))
    expect(changedKinds(diff)).toEqual({ added: 2, deleted: 1 })
    expect(diff.lines).toContainEqual({ kind: 'deleted', text: 'b', beforeLine: 2 })
    expect(diff.lines).toContainEqual({ kind: 'added', text: 'B', afterLine: 2 })
    expect(diff.lines).toContainEqual({ kind: 'added', text: 'e', afterLine: 5 })
  })

  it('keeps a small edit inside a large file small (regression: whole-file noise)', () => {
    // ~1,400 lines — well past the old 500k-cell threshold that triggered the
    // naive prefix/suffix fallback, which used to render this as ~whole-file.
    const before = [...filler(700, 'head'), 'old-line', ...filler(700, 'tail')]
    const after = [...filler(700, 'head'), 'new-line', 'extra-line', ...filler(700, 'tail')]
    const diff = diffDetails(before.join('\n'), after.join('\n'))
    expect(changedKinds(diff)).toEqual({ added: 2, deleted: 1 })
    expect(lineNumbersValid(diff.lines, before.length, after.length)).toBe(true)
  })

  it('handles a one-line insertion in the middle of a very large file', () => {
    const before = filler(3_500, 'f')
    const after = [...before.slice(0, 1_750), 'inserted', ...before.slice(1_750)]
    const diff = diffDetails(before.join('\n'), after.join('\n'))
    expect(changedKinds(diff)).toEqual({ added: 1, deleted: 0 })
    expect(lineNumbersValid(diff.lines, before.length, after.length)).toBe(true)
  })

  it('handles a pure deletion in a large file', () => {
    const before = [...filler(1_000, 'f'), 'remove-me', ...filler(1_000, 'f')]
    const after = [...filler(1_000, 'f'), ...filler(1_000, 'f')]
    const diff = diffDetails(before.join('\n'), after.join('\n'))
    expect(changedKinds(diff)).toEqual({ added: 0, deleted: 1 })
    expect(lineNumbersValid(diff.lines, before.length, after.length)).toBe(true)
  })

  it('still reports a genuine large rewrite as large', () => {
    const before = filler(1_500, 'old')
    const after = filler(1_500, 'new')
    const diff = diffDetails(before.join('\n'), after.join('\n'))
    // The naive fallback marks the unmatched middle; the point is it must not
    // report the whole file as changed AND must keep line numbers in range.
    expect(changedKinds(diff)).not.toEqual({ added: 0, deleted: 0 })
    expect(lineNumbersValid(diff.lines, before.length, after.length)).toBe(true)
  })

  it('handles created and deleted files', () => {
    const created = diffDetails(undefined, 'a\nb\nc')
    expect(changedKinds(created)).toEqual({ added: 3, deleted: 0 })
    const deleted = diffDetails('a\nb\nc', undefined)
    expect(changedKinds(deleted)).toEqual({ added: 0, deleted: 3 })
  })
})
