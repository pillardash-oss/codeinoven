import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A newer open supersedes the one in flight, and the conversation is published
 * before the rest of the app reacts to it.
 *
 * Both are source rules rather than runtime behaviour: `ThreadMessages` reaches
 * IPC at import time, and the pane's selection is a component prop. What they
 * protect is the same thing - the work a click is not waiting for must not run
 * in front of the surface the click asked for.
 */

function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), 'src', 'renderer', 'lib', ...parts), 'utf8').replace(
    /\r\n/gu,
    '\n'
  )
}

describe('opening a thread', () => {
  it('drops a load the reader has navigated away from', () => {
    const store = source('stores', 'thread-messages.svelte.ts')
    // The generation is taken when the read starts...
    expect(store).toMatch(/const generation = this\.#openGeneration/u)
    // ...and compared before anything is published from it.
    expect(store).toMatch(
      /if \(generation !== this\.#openGeneration\) \{[\s\S]{0,160}span\.end\('abandoned'/u
    )
    expect(store).toMatch(/this\.#openGeneration \+= 1/u)
  })

  it('publishes the pane selection now and the app selection after the shell paints', () => {
    const workspace = source('stores', 'workspace.svelte.ts')
    expect(workspace).toMatch(/paneThread: Thread \| null = \$state\.raw\(null\)/u)
    expect(workspace).toMatch(/this\.paneThread = thread\n\s+afterShellPaint\(/u)
    const pane = source('components', 'workspace', 'Workspace.svelte')
    // The pane reads the immediate selection; everything else keeps the published
    // one, which is what keeps the app's reactions out of the click's flush.
    expect(pane).toMatch(/selectedThread=\{paneThread\}/u)
    expect(pane).toMatch(/const paneThread = \$derived\(workspaceState\.paneThread\)/u)
    expect(pane).toMatch(
      /const selectedThread = \$derived\(board\.openThreadFromSwitcher\.selectedThread\)/u
    )
  })
})
