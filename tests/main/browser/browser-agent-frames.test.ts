import type { WebContents, WebFrameMain } from 'electron'
import { describe, expect, it } from 'vitest'

import {
  MAX_AGENT_FRAMES,
  agentFrameAt,
  agentFrameEntries,
  agentFrameOffset,
  agentFrameRefPrefix,
  agentRefFrameIndex,
  matchFrameRect,
  type AgentFrameEntry
} from '../../../src/main/browser/browser-service/browser-agent-frames'

/**
 * The documents one page is made of, without an Electron process.
 *
 * What these check is the contract every agent action depends on: a reference says
 * which document it came from, a frame's inset is measured through its parents, and
 * a frame the page no longer has is reported as gone rather than guessed at.
 */

interface FakeFrameInit {
  url?: string
  name?: string
  children?: FakeFrameInit[]
  detached?: boolean
}

interface FakeFrame {
  url: string
  name: string
  parent: FakeFrame | null
  frames: FakeFrame[]
  detached: boolean
}

function build(init: FakeFrameInit, parent: FakeFrame | null = null): FakeFrame {
  const frame: FakeFrame = {
    url: init.url ?? '',
    name: init.name ?? '',
    parent,
    frames: [],
    detached: init.detached === true
  }
  frame.frames = (init.children ?? []).map((child) => build(child, frame))
  return frame
}

function subtree(frame: FakeFrame): FakeFrame[] {
  return [frame, ...frame.frames.flatMap(subtree)]
}

function contentsWith(root: FakeFrameInit): WebContents {
  const main = build(root)
  return {
    mainFrame: { ...main, framesInSubtree: subtree(main) }
  } as unknown as WebContents
}

describe('agent frame references', () => {
  it('reads the document a reference names', () => {
    expect(agentRefFrameIndex('r12')).toBe(0)
    expect(agentRefFrameIndex('f2r7')).toBe(2)
    expect(agentRefFrameIndex('f12r100')).toBe(12)
  })

  it('refuses a string that is not a reference a snapshot reported', () => {
    expect(agentRefFrameIndex('r')).toBeNull()
    expect(agentRefFrameIndex('f2r')).toBeNull()
    expect(agentRefFrameIndex('#submit')).toBeNull()
    expect(agentRefFrameIndex('f2R7')).toBeNull()
  })

  it('gives the page its own document an empty prefix, and every frame its own', () => {
    expect(agentFrameRefPrefix(0)).toBe('')
    expect(agentFrameRefPrefix(1)).toBe('f1')
    expect(agentFrameRefPrefix(7)).toBe('f7')
  })
})

describe('agent frame enumeration', () => {
  it('lists the page first, then every frame beneath it', () => {
    const entries = agentFrameEntries(
      contentsWith({
        url: 'https://portal.example.com/',
        children: [
          {
            url: 'https://portal.example.com/blade',
            name: 'blade',
            children: [{ url: 'https://portal.example.com/deep' }]
          },
          { url: 'https://ads.example.com/slot' }
        ]
      })
    )
    expect(entries.map((entry) => entry.url)).toEqual([
      'https://portal.example.com/',
      'https://portal.example.com/blade',
      'https://portal.example.com/deep',
      'https://ads.example.com/slot'
    ])
    expect(entries.map((entry) => entry.index)).toEqual([0, 1, 2, 3])
    expect(entries.map((entry) => entry.name)).toEqual(['', 'blade', '', ''])
  })

  it('keeps one page with fifty frames to one bounded list', () => {
    const children = Array.from({ length: MAX_AGENT_FRAMES + 20 }, (_, index) => ({
      url: `https://ads.example.com/${index}`
    }))
    const entries = agentFrameEntries(contentsWith({ url: 'https://example.com/', children }))
    expect(entries).toHaveLength(MAX_AGENT_FRAMES)
  })

  it('leaves a detached frame out, because nothing can be read in it', () => {
    const entries = agentFrameEntries(
      contentsWith({
        url: 'https://example.com/',
        children: [
          { url: 'https://example.com/gone', detached: true },
          { url: 'https://example.com/live' }
        ]
      })
    )
    expect(entries.map((entry) => entry.url)).toEqual([
      'https://example.com/',
      'https://example.com/live'
    ])
  })

  it('answers with the frame a snapshot number names, and with null when it is gone', () => {
    const contents = contentsWith({
      url: 'https://example.com/',
      children: [{ url: 'https://example.com/blade' }]
    })
    expect(agentFrameAt(contents, 1)?.url).toBe('https://example.com/blade')
    expect(agentFrameAt(contents, 4)).toBeNull()
    expect(agentFrameAt(contents, -1)).toBeNull()
  })
})

describe('agent frame measurement', () => {
  function rect(index: number, x: number, y: number, width = 600, height = 400) {
    return { index, x, y, width, height, src: '', title: '' }
  }

  it('finds the frame element a child was loaded into by its address', () => {
    const parent = build({ url: 'https://example.com/' })
    const child = build({ url: 'https://example.com/blade' }, parent)
    parent.frames = [build({ url: 'https://ads.example.com/slot' }, parent), child]
    const rects = [
      { ...rect(0, 0, 0), src: 'https://ads.example.com/slot' },
      { ...rect(1, 40, 80), src: 'https://example.com/blade' }
    ]
    expect(
      matchFrameRect(rects, child as unknown as WebFrameMain, parent as unknown as WebFrameMain)
    ).toEqual(rects[1])
  })

  it('falls back to document order only when both sides agree on how many frames there are', () => {
    const parent = build({ url: 'https://example.com/' })
    const other = build({ url: 'https://example.com/other' }, parent)
    const child = build({ url: 'https://example.com/blade' }, parent)
    parent.frames = [other, child]
    const rects = [
      { ...rect(0, 1, 2), src: '' },
      { ...rect(1, 3, 4), src: '' }
    ]
    expect(
      matchFrameRect(rects, child as unknown as WebFrameMain, parent as unknown as WebFrameMain)
    ).toEqual(rects[1])
    expect(
      matchFrameRect(
        [rects[0]],
        child as unknown as WebFrameMain,
        parent as unknown as WebFrameMain
      )
    ).toBeNull()
  })

  it('adds every parent inset up to the page viewport, and asks the parent to reveal the frame', async () => {
    const main = build({ url: 'https://example.com/' })
    const outer = build({ url: 'https://example.com/outer' }, main)
    const inner = build({ url: 'https://example.com/inner' }, outer)
    main.frames = [outer]
    outer.frames = [inner]
    const seen: string[] = []
    const entry = { index: 2, frame: inner, url: inner.url, name: '', refPrefix: 'f2' }
    const run = async (frame: unknown, script: string) => {
      const reveal = script.includes('scrollIntoView')
      seen.push(reveal ? 'reveal' : 'rects')
      const measured =
        frame === (main as unknown)
          ? { ...rect(0, 10, 20), src: outer.url }
          : { ...rect(0, 5, 7), src: inner.url }
      return reveal ? measured : [measured]
    }
    await expect(
      agentFrameOffset(entry as unknown as AgentFrameEntry, main as unknown as WebFrameMain, run)
    ).resolves.toEqual({ x: 15, y: 27 })
    expect(seen).toEqual(['rects', 'reveal', 'rects', 'reveal'])
  })

  it('says it cannot measure a frame rather than answering with a point that misses', async () => {
    const main = build({ url: 'https://example.com/' })
    const child = build({ url: 'https://example.com/blade' }, main)
    main.frames = [child]
    const entry = { index: 1, frame: child, url: child.url, name: '', refPrefix: 'f1' }
    await expect(
      agentFrameOffset(
        entry as unknown as AgentFrameEntry,
        main as unknown as WebFrameMain,
        async () => []
      )
    ).resolves.toBeNull()
  })

  it('gives up on a frame whose parent cannot be followed', async () => {
    const main = build({ url: 'https://example.com/' })
    const entry = { index: 1, frame: main, url: main.url, name: '', refPrefix: '' }
    await expect(
      agentFrameOffset(
        entry as unknown as AgentFrameEntry,
        main as unknown as WebFrameMain,
        async () => []
      )
    ).resolves.toEqual({ x: 0, y: 0 })
  })
})
