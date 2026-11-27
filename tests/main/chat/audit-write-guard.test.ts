import { describe, expect, it, vi } from 'vitest'
import { auditWorktreeIssues } from '../../../src/main/chat/chat-engine/chat-engine-audit-write-guard'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() }
}))

describe('auditWorktreeIssues', () => {
  it('says nothing when the auditor left the tree alone', () => {
    expect(auditWorktreeIssues([])).toEqual([])
  })

  it('marks the report unverified and names what the auditor touched', () => {
    const issues = auditWorktreeIssues([
      'packages/convex-backend/src/convex/people/payroll/statutory/coverage.ts',
      'packages/convex-backend/src/convex/payrollSelfService.test.ts'
    ])
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('modified 2 project files')
    expect(issues[0]).toContain(
      'packages/convex-backend/src/convex/people/payroll/statutory/coverage.ts'
    )
    expect(issues[0]).toContain('packages/convex-backend/src/convex/payrollSelfService.test.ts')
    // The report is kept: the issue marks it, it never says the run was discarded.
    expect(issues[0]).toContain('treat its evidence as unverified')
    expect(issues[0]).not.toContain('discard')
  })

  it('bounds a long list instead of naming a whole tree', () => {
    const paths = Array.from({ length: 20 }, (_, index) => `src/file-${index + 1}.ts`)
    const [issue] = auditWorktreeIssues(paths)
    expect(issue).toContain('and 8 more')
    expect(issue).not.toContain('src/file-20.ts')
  })
})
