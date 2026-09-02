import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() }
}))

vi.mock('../../../src/main/memory-service', () => ({
  MemoryService: class {},
  estimateTokens: (text: string) => Math.ceil(text.length / 4)
}))

import { formatHistoryRecap } from '../../src/main/chat/chat-engine'
import type { AgentMessage } from '../../src/lib/types'

function message(role: 'user' | 'assistant', text: string): AgentMessage {
  return {
    id: `${role}-${text.length}`,
    threadId: 'thread-1',
    projectId: 'project-1',
    role,
    parts: [{ type: 'text', id: 'p', text }],
    createdAt: 1,
    updatedAt: 1,
    transportParts: [{ type: 'text', id: 'p', text }],
    visibility: 'normal'
  } as unknown as AgentMessage
}

describe('formatHistoryRecap', () => {
  it('caps the restored transcript by the model input budget', () => {
    const messages = [message('user', 'u'.repeat(2_000)), message('assistant', 'a'.repeat(2_000))]
    const recap = formatHistoryRecap(messages, { maxInputTokens: 100 })
    // 4000 chars capped to 400 chars (100 tokens * 4).
    expect(recap).toContain('Transcript restored from history:')
    expect(recap).not.toContain('u'.repeat(2_000))
  })

  it('keeps the default 50k-token budget when no budget is given', () => {
    // 30k chars (~7.5k tokens) sits well under the 50k-token default, so the
    // whole message is preserved rather than tail-sliced to 24k characters.
    const messages = [message('user', 'x'.repeat(30_000)), message('assistant', 'ok')]
    const recap = formatHistoryRecap(messages, {})
    expect(recap).toContain('Transcript restored from history:')
    expect(recap).toContain('x'.repeat(30_000))
  })

  it('truncates past the default 50k-token budget when exceeded', () => {
    // 300k chars (~75k tokens) exceeds the 50k-token default, so the transcript
    // is capped to 200k characters and the full run is not preserved.
    const messages = [message('user', 'x'.repeat(300_000)), message('assistant', 'ok')]
    const recap = formatHistoryRecap(messages, {})
    expect(recap).not.toContain('x'.repeat(300_000))
  })
})
