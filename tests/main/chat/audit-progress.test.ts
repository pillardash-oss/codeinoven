import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() }
}))

import {
  auditProgressStep,
  formatAuditProgressBrief
} from '../../../src/main/chat/chat-engine/chat-engine-pure'
import type { AgentPart } from '../../../src/lib/types'
import type { AuditProgressSummary } from '../../../src/main/chat/chat-engine/chat-engine-types'

type ToolPart = Extract<AgentPart, { type: 'tool' }>

function toolPart(
  tool: string,
  status: 'pending' | 'running' | 'completed' | 'error' | 'aborted',
  input: Record<string, unknown>
): ToolPart {
  return {
    type: 'tool',
    id: 'part-1',
    messageID: 'msg-1',
    callID: 'call-1',
    tool,
    state: { status, input }
  }
}

describe('auditProgressStep', () => {
  it('ignores a call that has not settled', () => {
    expect(auditProgressStep(toolPart('read', 'running', { path: 'src/a.ts' }), 1)).toBeNull()
  })

  it('records a settled call as an action and its subject, never the raw tool id', () => {
    expect(auditProgressStep(toolPart('Read', 'completed', { path: 'src/a.ts' }), 7)).toEqual({
      kind: 'step',
      at: 7,
      tool: 'Read',
      action: 'read a file',
      subject: 'src/a.ts',
      status: 'completed'
    })
  })

  it('keeps a failed command distinguishable from a completed one', () => {
    const step = auditProgressStep(toolPart('Bash', 'error', { command: 'bun run test' }), 9)
    expect(step?.status).toBe('error')
    expect(step?.action).toBe('ran a shell command')
    expect(step?.subject).toBe('bun run test')
  })

  it('caps an oversized subject so one dump cannot bloat the log', () => {
    const step = auditProgressStep(toolPart('Bash', 'completed', { command: 'x'.repeat(400) }), 1)
    expect(step?.subject.length).toBeLessThanOrEqual(201)
  })
})

describe('formatAuditProgressBrief', () => {
  function summary(steps: number, artifactPath = '.cio/specs/f/audit/progress/auditor.jsonl') {
    return {
      runId: 'run-1',
      auditKind: 'independent',
      startedAt: 1,
      artifactPath,
      steps: Array.from({ length: steps }, (_, index) => ({
        at: index,
        tool: 'Read',
        action: 'read a file',
        subject: `src/file-${index + 1}.ts`,
        status: 'completed' as const
      }))
    } satisfies AuditProgressSummary
  }

  it('says nothing when the previous run recorded no step', () => {
    expect(formatAuditProgressBrief(summary(0))).toBe('')
  })

  it('numbers the steps and names where the full log lives', () => {
    const brief = formatAuditProgressBrief(summary(2))
    expect(brief).toContain('recorded 2 finished steps')
    expect(brief).toContain('.cio/specs/f/audit/progress/auditor.jsonl')
    expect(brief).toContain('1. [completed] read a file: src/file-1.ts')
    expect(brief).toContain('2. [completed] read a file: src/file-2.ts')
    expect(brief).toContain('Continue from step 3')
  })

  it('keeps the newest steps when the log is long, and says how many it left out', () => {
    const brief = formatAuditProgressBrief(summary(100))
    expect(brief).toContain('The 40 earliest are left out here')
    // Numbering stays absolute, so "step 41" is the oldest line shown.
    expect(brief).toContain('41. [completed] read a file: src/file-41.ts')
    expect(brief).toContain('100. [completed] read a file: src/file-100.ts')
    expect(brief).not.toContain('src/file-40.ts')
  })
})
