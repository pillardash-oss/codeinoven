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

  // Regression: the same inline script is normally reached through
  // `cd <project> && python3 - <<'PY'`. The heredoc scanner only recognized a
  // command that started the string, followed `;`, or followed a newline, so
  // the chained form produced no write target and the card dropped the edit.
  it('extracts paths from a python heredoc chained after cd with &&', () => {
    const part: Extract<AgentPart, { type: 'tool' }> = {
      type: 'tool',
      id: 'part-chained-script',
      messageID: 'message-chained-script',
      callID: 'call-chained-script',
      tool: 'bash',
      state: {
        status: 'completed',
        input: {
          command: `cd /project && python3 - <<'PY'
p='packages/shared/src/ui/floating-panel.ts'
s=open(p).read()
s=s.replace('a','b')
open(p,'w').write(s)
PY
sed -n 44,60p packages/shared/src/ui/floating-panel.ts`
        }
      }
    }

    expect(changedPathsFromTool('/project', part)).toEqual([
      'packages/shared/src/ui/floating-panel.ts'
    ])
  })

  // Regression: the chained command usually `cd`s into a subdirectory first.
  // The heredoc prefix consumed only the second `&` of the `&&` operator, which
  // left a dangling `&&` that the working-directory reader refuses to end a
  // `cd` on: the body's relative target resolved against the project root, the
  // turn proved nothing about the file it wrote, and its card came up empty.
  it('extracts a heredoc target against the subdirectory it runs in', () => {
    const part: Extract<AgentPart, { type: 'tool' }> = {
      type: 'tool',
      id: 'part-subdir-script',
      messageID: 'message-subdir-script',
      callID: 'call-subdir-script',
      tool: 'bash',
      state: {
        status: 'completed',
        input: {
          command: `cd /project/tools/generator && python3 - <<'PY'
p='out/schema.ts'
s=open(p).read()
open(p,'w').write(s)
PY
cd /project && git status --porcelain`
        }
      }
    }

    expect(changedPathsFromTool('/project', part)).toEqual(['tools/generator/out/schema.ts'])
  })

  // Regression: an inline script that edits several places commonly wraps the
  // write in a helper, `def edit(p, a, b)` plus `edit('app/attachments.ts', ...)`.
  // Only the definition writes, and only the call names the file, so neither was
  // read and the turn proved nothing it had just changed.
  it('extracts the target of a helper that writes through its first parameter', () => {
    const part: Extract<AgentPart, { type: 'tool' }> = {
      type: 'tool',
      id: 'part-helper-script',
      messageID: 'message-helper-script',
      callID: 'call-helper-script',
      tool: 'bash',
      state: {
        status: 'completed',
        input: {
          command: `cd apps/application/src/lib/design/journal && python3 - <<'EOF'
def edit(p,a,b):
    s=open(p).read(); assert a in s,(p,a); open(p,'w').write(s.replace(a,b,1))
edit('app/attachments.ts',"old","new")
edit('viewer/carousel.ts',"one","two")
open('attachments/mini.ts','w').write('audit')
EOF`
        }
      }
    }

    expect(changedPathsFromTool('/project', part)).toEqual([
      'apps/application/src/lib/design/journal/attachments/mini.ts',
      'apps/application/src/lib/design/journal/app/attachments.ts',
      'apps/application/src/lib/design/journal/viewer/carousel.ts'
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
