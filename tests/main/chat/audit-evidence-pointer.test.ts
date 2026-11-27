import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() }
}))

import { auditEvidencePointer } from '../../../src/main/chat/chat-engine/chat-engine-pure'

describe('auditEvidencePointer', () => {
  it('names the auditor thread id and the read_messages query that reads it', () => {
    const pointer = auditEvidencePointer('auditor-thread-7')
    expect(pointer).toContain('auditor-thread-7')
    expect(pointer).toContain('read_messages')
    expect(pointer).toContain('thread_id "auditor-thread-7"')
    expect(pointer).toContain('nextBeforeId')
  })
})
