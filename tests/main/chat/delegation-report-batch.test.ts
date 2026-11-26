import { describe, expect, it } from 'vitest'
import {
  composeDelegationReportTurn,
  DELEGATION_REPORT_BATCH_MAX_CHARS,
  DELEGATION_REPORT_BATCH_MAX_ITEMS,
  parseDelegationReportQueue,
  selectDelegationReportBatch,
  type QueuedDelegationReport
} from '../../../src/main/chat/delegation/delegation-report-batch'

/**
 * Ten pawns finishing together is one parent reading a digest, not ten prompts
 * arriving at once.
 *
 * The queue exists because a delegated report is news for the agent that asked
 * for the work, and ten of them landing on one live session at the same second
 * used to cost that session its turn for every single line. These lock in how a
 * queue turns into a turn.
 */

function report(overrides: Partial<QueuedDelegationReport> = {}): QueuedDelegationReport {
  return {
    schemaVersion: 1,
    id: `report-${Math.random().toString(36).slice(2)}`,
    projectId: 'project-1',
    threadId: 'thread-1',
    kind: 'pawn',
    text: 'Pawn agent One finished its task.',
    action: 'Pawn finished · One',
    body: 'body of the report',
    createdAt: 1,
    ...overrides
  }
}

describe('parseDelegationReportQueue', () => {
  it('reads back a queue it wrote', () => {
    const items = [report({ id: 'a' }), report({ id: 'b', kind: 'dispatch' })]
    const parsed = parseDelegationReportQueue(
      { schemaVersion: 1, projectId: 'project-1', threadId: 'thread-1', items },
      'project-1',
      'thread-1'
    )
    expect(parsed.items.map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('drops a queue written for another thread', () => {
    const parsed = parseDelegationReportQueue(
      { schemaVersion: 1, projectId: 'project-1', threadId: 'other', items: [report()] },
      'project-1',
      'thread-1'
    )
    expect(parsed.items).toEqual([])
  })

  it('drops an unreadable item instead of delivering a blank report', () => {
    const parsed = parseDelegationReportQueue(
      {
        schemaVersion: 1,
        projectId: 'project-1',
        threadId: 'thread-1',
        items: [report({ id: 'good' }), { schemaVersion: 1, id: 'bad', text: '' }]
      },
      'project-1',
      'thread-1'
    )
    expect(parsed.items.map((item) => item.id)).toEqual(['good'])
  })
})

describe('selectDelegationReportBatch', () => {
  it('keeps the rest waiting once a batch is full', () => {
    const items = Array.from({ length: 10 }, (_, index) => report({ id: `r${index}` }))
    const { batch, rest } = selectDelegationReportBatch(items)
    expect(batch).toHaveLength(DELEGATION_REPORT_BATCH_MAX_ITEMS)
    expect(rest).toHaveLength(10 - DELEGATION_REPORT_BATCH_MAX_ITEMS)
  })

  it('never leaves an oversized report waiting for ever', () => {
    const huge = report({ id: 'huge', text: 'x'.repeat(DELEGATION_REPORT_BATCH_MAX_CHARS + 1) })
    const { batch } = selectDelegationReportBatch([huge, report({ id: 'next' })])
    // The first item always ships: a report bigger than the budget still gets
    // delivered, alone.
    expect(batch.map((item) => item.id)).toEqual(['huge'])
  })

  it('hands back an empty batch for an empty queue', () => {
    expect(selectDelegationReportBatch([])).toEqual({ batch: [], rest: [] })
  })
})

describe('composeDelegationReportTurn', () => {
  it('keeps a single report exactly as it was filed', () => {
    const single = report({ id: 'only' })
    expect(composeDelegationReportTurn([single])).toEqual({
      text: single.text,
      action: single.action,
      body: single.body
    })
  })

  it('says how many runs a batch carries before listing them', () => {
    const turn = composeDelegationReportTurn([
      report({ id: 'a', text: 'first report' }),
      report({ id: 'b', text: 'second report', kind: 'dispatch' })
    ])
    expect(turn.text).toContain('2 delegated runs finished')
    expect(turn.text).toContain('1 pawn report and 1 dispatched run')
    expect(turn.text).toContain('first report')
    expect(turn.text).toContain('second report')
    expect(turn.action).toContain('2 finished')
    expect(turn.body).toContain('body of the report')
  })
})
