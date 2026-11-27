import { describe, expect, it, vi } from 'vitest'
import { AuditModifiedWorktreeError } from '../../../src/main/chat/chat-engine/chat-engine-audit-write-guard'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() }
}))

describe('AuditModifiedWorktreeError', () => {
  it('names the files the audit changed and says the run is discarded', () => {
    const error = new AuditModifiedWorktreeError([
      'packages/convex-backend/src/convex/people/payroll/statutory/coverage.ts',
      'packages/convex-backend/src/convex/payrollSelfService.test.ts'
    ])
    expect(error.message).toContain('modified the project it was auditing')
    expect(error.message).toContain(
      '- packages/convex-backend/src/convex/people/payroll/statutory/coverage.ts'
    )
    expect(error.message).toContain(
      '- packages/convex-backend/src/convex/payrollSelfService.test.ts'
    )
    expect(error.message).toContain('discarded instead of saved')
    expect(error.paths).toHaveLength(2)
  })

  it('bounds a long list instead of printing a whole tree', () => {
    const paths = Array.from({ length: 20 }, (_, index) => `src/file-${index + 1}.ts`)
    const message = new AuditModifiedWorktreeError(paths).message
    expect(message).toContain('…and 8 more')
    expect(message).not.toContain('src/file-20.ts')
  })
})
