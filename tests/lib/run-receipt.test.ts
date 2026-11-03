import { describe, expect, it } from 'vitest'
import {
  boundedTail,
  checksFromToolCalls,
  formatLineCounts,
  receiptSummaryLine,
  shapeRunReceipt,
  summarizeFiles,
  type RunReceiptToolCall
} from '../../src/lib/run-receipt'
import type { RunReceiptFile } from '../../src/lib/types'

/**
 * Receipt shaping is pure and total: every list defaults to empty, every flag is
 * explicit, and no number is invented. These cases pin the rules a renderer
 * depends on rather than the text of any one screen.
 */

function file(overrides: Partial<RunReceiptFile> = {}): RunReceiptFile {
  return {
    path: 'src/a.ts',
    status: 'modified',
    additions: 3,
    deletions: 1,
    binary: false,
    ...overrides
  }
}

describe('shapeRunReceipt', () => {
  it('derives totals and check counts from the facts it was given', () => {
    const receipt = shapeRunReceipt({
      state: 'ready',
      projectId: 'project1',
      threadId: 'thread1',
      scope: { projectId: 'project1', scopeBucketId: 'default', scopeName: 'Default', branch: 'dev' },
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      commits: [
        { hash: 'b'.repeat(40), shortHash: 'bbbbbbb', subject: 'A commit', author: 'Ada', at: 1 }
      ],
      files: [file(), file({ path: 'src/b.ts', status: 'added', additions: 10, deletions: 0 })],
      uncommitted: [file({ path: 'src/c.ts', additions: 2, deletions: 2 })],
      checks: [
        { command: 'bun run test', outcome: 'passed' },
        { command: 'bun run lint', outcome: 'failed', exitCode: 1 }
      ],
      readAt: 42
    })
    expect(receipt.totals).toEqual({ count: 2, additions: 13, deletions: 1 })
    expect(receipt.uncommittedTotals).toEqual({ count: 1, additions: 2, deletions: 2 })
    expect(receipt.checkCounts).toEqual({ passed: 1, failed: 1, aborted: 0 })
    expect(receipt.truncated).toEqual({ commits: false, files: false, uncommitted: false })
  })

  it('is total: an empty input still answers every question', () => {
    const receipt = shapeRunReceipt({
      state: 'ready',
      projectId: 'project1',
      threadId: 'thread1',
      scope: { projectId: 'project1', scopeBucketId: 'default', scopeName: 'Default', branch: null },
      baseSha: null,
      headSha: null,
      readAt: 1
    })
    expect(receipt.commits).toEqual([])
    expect(receipt.files).toEqual([])
    expect(receipt.uncommitted).toEqual([])
    expect(receipt.checks).toEqual([])
    expect(receipt.totals).toEqual({ count: 0, additions: 0, deletions: 0 })
    expect(receipt.checkCounts).toEqual({ passed: 0, failed: 0, aborted: 0 })
  })

  it('keeps a truncation flag explicit rather than silently capping', () => {
    const receipt = shapeRunReceipt({
      state: 'ready',
      projectId: 'p',
      threadId: 't',
      scope: { projectId: 'p', scopeBucketId: 'default', scopeName: 'Default', branch: null },
      baseSha: null,
      headSha: null,
      files: [file()],
      truncated: { files: true },
      readAt: 1
    })
    expect(receipt.truncated.files).toBe(true)
    expect(receipt.truncated.commits).toBe(false)
  })

  it('counts a binary file as zero lines instead of a bogus total', () => {
    expect(summarizeFiles([file({ binary: true, additions: 0, deletions: 0 })])).toEqual({
      count: 1,
      additions: 0,
      deletions: 0
    })
  })
})

describe('formatLineCounts', () => {
  it('states only the signs that carry a count', () => {
    expect(formatLineCounts({ count: 1, additions: 4, deletions: 0 })).toBe('+4')
    expect(formatLineCounts({ count: 1, additions: 0, deletions: 9 })).toBe('−9')
    expect(formatLineCounts({ count: 1, additions: 4, deletions: 9 })).toBe('+4 −9')
    expect(formatLineCounts({ count: 0, additions: 0, deletions: 0 })).toBe('none')
    expect(formatLineCounts({ count: 1, additions: 0, deletions: 0 })).toBe('no line changes')
  })
})

describe('receiptSummaryLine', () => {
  const base = {
    state: 'ready' as const,
    projectId: 'p',
    threadId: 't',
    scope: { projectId: 'p', scopeBucketId: 'default', scopeName: 'Default', branch: null },
    baseSha: null,
    headSha: null,
    readAt: 1
  }

  it('states files, commits, checks and the uncommitted remainder', () => {
    const receipt = shapeRunReceipt({
      ...base,
      files: [file()],
      commits: [
        { hash: 'h', shortHash: 'hhhhhhh', subject: 's', author: 'a', at: 1 },
        { hash: 'i', shortHash: 'iiiiiii', subject: 's', author: 'a', at: 2 }
      ],
      checks: [{ command: 'bun run test', outcome: 'passed' }],
      uncommitted: [file()],
      readAt: 1
    })
    expect(receiptSummaryLine(receipt)).toBe(
      '1 file +3 −1 · 2 commits · 1 check passed · 1 uncommitted'
    )
  })

  it('says a failed check failed rather than counting a pass', () => {
    const receipt = shapeRunReceipt({
      ...base,
      checks: [
        { command: 'a', outcome: 'failed' },
        { command: 'b', outcome: 'passed' }
      ],
      readAt: 1
    })
    expect(receiptSummaryLine(receipt)).toBe('No files changed · 1 check failed')
  })

  it('never claims a finished run for a non-ready state', () => {
    expect(receiptSummaryLine(shapeRunReceipt({ ...base, state: 'running', readAt: 1 }))).toBe(
      'Run in progress'
    )
    expect(receiptSummaryLine(shapeRunReceipt({ ...base, state: 'no-base', readAt: 1 }))).toBe(
      'No starting commit recorded'
    )
    expect(
      receiptSummaryLine(shapeRunReceipt({ ...base, state: 'parked', reason: 'the scope is missing', readAt: 1 }))
    ).toBe('Parked: the scope is missing')
    expect(
      receiptSummaryLine(shapeRunReceipt({ ...base, state: 'error', reason: 'git failed', readAt: 1 }))
    ).toBe('Could not read: git failed')
  })
})

describe('checksFromToolCalls', () => {
  function call(overrides: Partial<RunReceiptToolCall> = {}): RunReceiptToolCall {
    return {
      tool: 'bash',
      status: 'completed',
      input: { command: 'bun run test' },
      ...overrides
    }
  }

  it('records a real exit status and a bounded tail', () => {
    const { checks } = checksFromToolCalls([
      call({ status: 'error', metadata: { exitCode: 1 }, output: 'boom' })
    ])
    expect(checks).toHaveLength(1)
    expect(checks[0]?.outcome).toBe('failed')
    expect(checks[0]?.exitCode).toBe(1)
    expect(checks[0]?.tail).toBe('boom')
  })

  it('treats a completed call with a non-zero exit code as failed', () => {
    const { checks } = checksFromToolCalls([call({ metadata: { exit_code: 2 } })])
    expect(checks[0]?.outcome).toBe('failed')
  })

  it('reports an aborted command as aborted, never as passed', () => {
    const { checks } = checksFromToolCalls([call({ status: 'aborted' })])
    expect(checks[0]?.outcome).toBe('aborted')
  })

  it('ignores a call that never reached a terminal state', () => {
    expect(checksFromToolCalls([call({ status: 'pending' })]).checks).toEqual([])
    expect(checksFromToolCalls([call({ status: 'running' })]).checks).toEqual([])
  })

  it('ignores a tool that ran no command', () => {
    expect(checksFromToolCalls([call({ tool: 'read', input: { path: 'a' } })]).checks).toEqual([])
  })

  it('yields no checks for a prose-only run', () => {
    expect(checksFromToolCalls([])).toEqual({ checks: [], total: 0, truncated: false })
  })

  it('cuts the list at its bound and says so', () => {
    const calls = Array.from({ length: 3 }, (_, index) =>
      call({ input: { command: `bun run check-${index}` } })
    )
    const result = checksFromToolCalls(calls, { commits: 1, files: 1, checks: 2, checkTail: 10 })
    expect(result.checks).toHaveLength(2)
    expect(result.truncated).toBe(true)
    expect(result.total).toBe(3)
  })
})

describe('boundedTail', () => {
  it('keeps the end of the output, cut at a line boundary, and names the cut', () => {
    // Ten characters of `line one\nline two\nline three` start mid-line, so the
    // tail begins at the next whole line rather than mid-word.
    expect(boundedTail('line one\nline two\nline three', 10)).toBe('… line three')
  })

  it('returns undefined for empty output rather than an empty string', () => {
    expect(boundedTail(undefined, 10)).toBeUndefined()
    expect(boundedTail('   \n ', 10)).toBeUndefined()
  })

  it('leaves output under the bound untouched', () => {
    expect(boundedTail('short', 100)).toBe('short')
  })
})
