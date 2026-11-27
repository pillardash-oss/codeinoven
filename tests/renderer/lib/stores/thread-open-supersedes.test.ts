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
    // The list's own highlight is the click, not a second flush: the sidebar is
    // given the immediate selection, so the row the user pressed with is the row
    // that reads as open.
    expect(pane).toMatch(/activeThreadId=\{activeThreadRowId\(paneThread\)\}/u)
    expect(pane).toMatch(/selectedThreadId=\{activeThreadRowId\(paneThread\)\}/u)
  })

  it('writes everything that is not the conversation after the conversation', () => {
    const workspace = source('stores', 'workspace.svelte.ts')
    const paneAssignedAt = workspace.indexOf('this.paneThread = thread')
    expect(paneAssignedAt).toBeGreaterThan(-1)
    // Each of these reaches its own subscribers, and each of them re-derives and
    // reads: in the click's flush they ran in front of the pane the click asked
    // for. They belong to the task after it, behind the guard that drops them
    // when the reader has already selected another thread.
    for (const call of [
      'recentVisits.recordThread(thread)',
      'relativeTimeClock.refresh()',
      'prewarmThreadOven(thread)',
      'scopeState.noteProjectBucket(',
      'gitState.notifyThreadOpened(project, thread)',
      'notificationPanelState.acknowledgeOpenThread(thread)',
      'contextSidebarState.activateThread('
    ]) {
      const at = workspace.indexOf(call, paneAssignedAt)
      expect(at, `${call} must exist after the pane selection`).toBeGreaterThan(paneAssignedAt)
      const before = workspace.slice(paneAssignedAt, at)
      const lastDeferral = before.lastIndexOf('afterShellPaint(')
      expect(lastDeferral, `${call} must run inside afterShellPaint`).toBeGreaterThan(-1)
      // The deferral it lives in skips itself once a newer open took over.
      expect(
        before.slice(lastDeferral).includes('if (this.paneThread !== thread) return'),
        `${call} must be behind the supersede guard`
      ).toBe(true)
    }
  })
})
