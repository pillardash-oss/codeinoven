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

  it('does not claim workspace changes when a mutating tool omits its path', () => {
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

    expect(changedPathsFromTool('/project', part)).toEqual([])
  })

  // Regression: the Codex harness edits files through an inline `python3`
  // heredoc that reuses one `Path(...)` variable per file. The writer is a bare
  // variable, so no target was extracted, the turn claimed nothing, and
  // completion dropped every real edit from the changes card.
  it('extracts paths from a Codex inline script that writes through a Path variable', () => {
    const part: Extract<AgentPart, { type: 'tool' }> = {
      type: 'tool',
      id: 'part-script',
      messageID: 'message-script',
      callID: 'call-script',
      tool: 'command_execution',
      state: {
        status: 'completed',
        input: {
          command: `/bin/zsh -lc "python3 - <<'PY'
from pathlib import Path
p=Path('src/lib/assistant-authoring.ts');s=p.read_text();p.write_text(s)
p=Path('src/main/utilities/utility-orchestration-service.ts');s=p.read_text().replace('a','b');p.write_text(s)
p=Path('src/main/chat/chat-engine.ts');p.write_text('''import type { X } from 'y'\n''')
PY"`
        }
      }
    }

    expect(changedPathsFromTool('/project', part)).toEqual([
      'src/lib/assistant-authoring.ts',
      'src/main/utilities/utility-orchestration-service.ts',
      'src/main/chat/chat-engine.ts'
    ])
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
