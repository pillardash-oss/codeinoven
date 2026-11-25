// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResponseReferenceAnchor } from '$lib/stores/response-references.svelte'

const invoke = vi.hoisted(() => vi.fn())
const logRendererDev = vi.hoisted(() => vi.fn())

vi.mock('$lib/ipc.svelte', () => ({ invoke, subscribe: vi.fn(() => () => undefined) }))
vi.mock('$lib/system/renderer-logger', () => ({
  logRendererDev,
  logRendererError: vi.fn()
}))

const { applyComposerRelocation } = await import('$lib/components/chats/composer-relocation')
const { rendererRecovery } = await import('$lib/stores/renderer-recovery.svelte')
const { responseReferencesState } = await import('$lib/stores/response-references.svelte')

const PROJECT = 'project-one'

function pageReference(id: string, comment: string): ResponseReferenceAnchor {
  return {
    id,
    kind: 'page',
    label: 'Page element 1',
    text: `<element>\nselector: div.entry\n</element>`,
    comment,
    selector: 'div.entry',
    pageUrl: 'http://localhost:5174/',
    tabId: 'browser:page:one'
  }
}

function draftJson(references: readonly ResponseReferenceAnchor[]): string {
  return JSON.stringify({
    text: '',
    attachments: [],
    projectReferences: [],
    taskReferences: [],
    promptReferences: references,
    startAfterThreads: [],
    threadReferences: []
  })
}

/** What the destination's composer is drawn from: its committed draft. */
function destinationThread(threadId: string, draft: string | null) {
  return { id: threadId, projectId: PROJECT, draftJson: draft ?? undefined }
}

describe('applyComposerRelocation', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockImplementation(async (channel: string, _projectId: string, threadId: string) => {
      if (channel === 'thread:get') return destinationThread(threadId, null)
      return undefined
    })
  })

  it("joins the carried page comment to the destination's own, never in place of them", async () => {
    const sourceId = 'thread-source-page'
    const targetId = 'thread-target-page'
    const own = [
      pageReference('own-1', 'The drawer is too loud'),
      pageReference('own-2', 'This row has no breathing space')
    ]
    const carried = pageReference('carried-1', 'Align this with the button beside it')

    rendererRecovery.setPromptReferences(PROJECT, sourceId, [carried])
    // The destination has never been opened in this window, so its draft is the
    // one the row holds — the path that used to lose every page comment.
    invoke.mockImplementation(async (channel: string, _projectId: string, threadId: string) => {
      if (channel === 'thread:get') return destinationThread(threadId, draftJson(own))
      return undefined
    })

    await applyComposerRelocation({
      projectId: PROJECT,
      sourceThreadId: sourceId,
      targetThreadId: targetId,
      item: { kind: 'reference', reference: carried },
      mode: 'relocate'
    })

    const kept = responseReferencesState.forThread(PROJECT, targetId)
    expect(kept.map((entry) => entry.id)).toEqual(['own-1', 'own-2', 'carried-1'])
    expect(kept.filter((entry) => entry.kind === 'page')).toHaveLength(3)
    // The source gave the comment up.
    expect(rendererRecovery.draftPromptReferences(PROJECT, sourceId)).toHaveLength(0)
  })

  it('keeps the annotations the destination composer is showing even when its draft lacks them', async () => {
    const sourceId = 'thread-source-live'
    const targetId = 'thread-target-live'
    const own = pageReference('live-own-1', 'Where is my breathing space?')
    const carried = pageReference('live-carried-1', 'Divider missing here')

    rendererRecovery.setPromptReferences(PROJECT, sourceId, [carried])
    // The live store is what draws the destination's chips, and the row's draft
    // answers with none of them.
    responseReferencesState.setForThread(PROJECT, targetId, [own])

    await applyComposerRelocation({
      projectId: PROJECT,
      sourceThreadId: sourceId,
      targetThreadId: targetId,
      item: { kind: 'reference', reference: carried },
      mode: 'relocate'
    })

    expect(responseReferencesState.forThread(PROJECT, targetId).map((entry) => entry.id)).toEqual([
      'live-own-1',
      'live-carried-1'
    ])
  })
})
