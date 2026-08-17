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
})
