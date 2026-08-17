import { describe, expect, it } from 'vitest'
import { changedPathsFromTool } from '../../src/main/chat/chat-engine'
import type { AgentPart } from '../../src/lib/types'

describe('changedPathsFromTool', () => {
  it('extracts paths from apply_patch patchText input', () => {
    const part: Extract<AgentPart, { type: 'tool' }> = {
      type: 'tool',
      id: 'part-1',
      messageID: 'message-1',
      callID: 'call-1',
      tool: 'apply_patch',
      state: {
        status: 'completed',
        input: {
          patchText: `*** Begin Patch
*** Update File: src/changed.ts
@@
-before
+after
*** End Patch`
        }
      }
    }

    expect(changedPathsFromTool('/project', part)).toEqual(['src/changed.ts'])
  })

  it('signals incomplete attribution when a mutating tool omits its path', () => {
    const part: Extract<AgentPart, { type: 'tool' }> = {
      type: 'tool',
      id: 'part-2',
      messageID: 'message-2',
      callID: 'call-2',
      tool: 'write_file',
      state: {
        status: 'completed',
        input: { content: 'changed without a path' }
      }
    }

    expect(changedPathsFromTool('/project', part)).toBeNull()
  })

  it('extracts paths from Codex file-change items', () => {
    const part: Extract<AgentPart, { type: 'tool' }> = {
      type: 'tool',
      id: 'part-3',
      messageID: 'message-3',
      callID: 'call-3',
      tool: 'file_change',
      state: {
        status: 'completed',
        input: { changes: [{ path: 'src/codex-change.ts', kind: 'update' }] }
      }
    }

    expect(changedPathsFromTool('/project', part)).toEqual(['src/codex-change.ts'])
  })
})
