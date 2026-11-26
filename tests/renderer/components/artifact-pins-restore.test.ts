// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount, tick } from 'svelte'
import ArtifactInspector from '$lib/components/markdown/ArtifactInspector.svelte'
import { PanZoom } from '$lib/pan-zoom.svelte'
import { artifactKeyFor } from '$lib/artifact-element-reference'
import {
  responseReferencesState,
  type ResponseReferenceAnchor
} from '$lib/stores/response-references.svelte'

vi.mock('$lib/ipc.svelte', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  subscribe: () => () => {},
  subscribeGuarded: () => () => {}
}))

vi.mock('$lib/stores/renderer-recovery.svelte', () => ({
  rendererRecovery: {
    setPromptReferences: () => {},
    draftPromptReferences: () => []
  }
}))

const projectId = 'project-1'
const threadId = 'thread-1'
const code = '<div class="card"><button class="cta">Buy</button></div>'
const artifactKey = artifactKeyFor('html', code)

function pick(selector: string, id: string): ResponseReferenceAnchor {
  return {
    id,
    kind: 'html',
    label: 'HTML artifact element: div.card',
    text: 'HTML artifact element: div.card',
    selector,
    artifactKey
  }
}

const instances: ReturnType<typeof mount>[] = []

function render(picks: ResponseReferenceAnchor[]): void {
  const target = document.createElement('div')
  document.body.append(target)
  flushSync()
  instances.push(
    mount(ArtifactInspector, {
      target,
      props: {
        code,
        kind: 'html',
        enabled: false,
        artifactKey,
        projectId,
        threadId,
        picks,
        editingId: null,
        onEditClosed: () => {},
        onExit: () => {},
        panZoom: new PanZoom(),
        fill: false
      }
    })
  )
  flushSync()
}

/** The pins the surface drew back on the artifact it mounted. */
function pins(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[aria-label^="Comment on"]'))
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  responseReferencesState.clearThread(projectId, threadId)
})

afterEach(async () => {
  for (const instance of instances.splice(0)) await unmount(instance)
  responseReferencesState.clearThread(projectId, threadId)
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('an artifact reopens carrying the comments already made on it', () => {
  it('draws a pin for a pick the thread already holds', async () => {
    render([pick('.card', 'reference-1')])
    await tick()
    await tick()
    flushSync()
    expect(pins()).toHaveLength(1)
  })

  it('draws no pin for an element the artifact no longer has', async () => {
    render([pick('.missing', 'reference-1')])
    await tick()
    await tick()
    flushSync()
    expect(pins()).toHaveLength(0)
  })
})
