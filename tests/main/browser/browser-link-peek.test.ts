import { describe, expect, it, vi } from 'vitest'

// The relay's only dependency is the logger, and the main-process logger reaches
// `fs` and `path`, which this run does not need.
vi.mock('../../../src/main/system/logger', () => ({ Logger: { dev: () => {} } }))

import type { WebContents, WebFrameMain } from 'electron'
import {
  BrowserLinkPeek,
  parseLinkPeekReport,
  type BrowserLinkPeekRequest
} from '../../../src/main/browser/browser-service/browser-link-peek'

/**
 * The Option-click relay is the only thing standing between that gesture and
 * Chromium's own meaning for it, which is a download of the link. These exercise
 * where it is installed and what it does with a report: every frame a page holds
 * is covered, and a frame's report is marked as coming from the frame's own
 * pixels rather than the page's.
 *
 * A page-side click cannot be produced honestly here (nothing is trusted outside
 * a real renderer), so the script's own behaviour on a trusted event is verified
 * against Electron directly; see `.cio/work/take-a-peek/plan.md`.
 */

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** A page-side world: it holds the observer, and main waits on a report in it. */
class FakeFrame {
  detached = false
  readonly scripts: string[] = []
  readonly waits: Array<ReturnType<typeof deferred<unknown>>> = []
  readonly listeners = new Map<string, Array<() => void>>()
  framesInSubtree: FakeFrame[] = []

  on(event: string, listener: () => void): this {
    const bucket = this.listeners.get(event) ?? []
    bucket.push(listener)
    this.listeners.set(event, bucket)
    return this
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener()
  }

  executeJavaScript(code: string): Promise<unknown> {
    return this.serve(code)
  }

  /** The install answers true; the wait is what a report later settles. */
  private serve(code: string): Promise<unknown> {
    this.scripts.push(code)
    if (!code.includes('.wait()')) return Promise.resolve(true)
    const wait = deferred<unknown>()
    this.waits.push(wait)
    return wait.promise
  }

  /** A report from this frame's document, which its outstanding wait receives. */
  report(value: unknown): void {
    this.waits.shift()?.resolve(value)
  }

  get armedWaits(): number {
    return this.waits.length
  }
}

class FakeContents {
  readonly isolated: string[] = []
  readonly isolatedWaits: Array<ReturnType<typeof deferred<unknown>>> = []
  readonly listeners = new Map<
    string,
    Array<(event: unknown, details: { frame: FakeFrame | null }) => void>
  >()

  constructor(readonly mainFrame: FakeFrame) {}

  isDestroyed(): boolean {
    return false
  }

  executeJavaScriptInIsolatedWorld(
    _worldId: number,
    scripts: ReadonlyArray<{ code: string }>
  ): Promise<unknown> {
    const code = scripts[0]?.code ?? ''
    this.isolated.push(code)
    if (!code.includes('.wait()')) return Promise.resolve(true)
    const wait = deferred<unknown>()
    this.isolatedWaits.push(wait)
    return wait.promise
  }

  on(
    event: string,
    listener: (event: unknown, details: { frame: FakeFrame | null }) => void
  ): this {
    const bucket = this.listeners.get(event) ?? []
    bucket.push(listener)
    this.listeners.set(event, bucket)
    return this
  }

  emitFrameCreated(frame: FakeFrame): void {
    for (const listener of this.listeners.get('frame-created') ?? []) listener(null, { frame })
  }

  report(value: unknown): void {
    this.isolatedWaits.shift()?.resolve(value)
  }
}

/** One macrotask boundary, so a promise chain of any depth has certainly run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function asContents(contents: FakeContents): WebContents {
  return contents as unknown as WebContents
}

function asFrame(frame: FakeFrame): WebFrameMain {
  return frame as unknown as WebFrameMain
}

const PEEK_REPORT = { url: 'https://example.com/thing', x: 40, y: 24 }

describe('link peek relay', () => {
  it('observes the page and every frame it holds', async () => {
    const main = new FakeFrame()
    const child = new FakeFrame()
    main.framesInSubtree = [main, child]
    const contents = new FakeContents(main)
    new BrowserLinkPeek({ onPeek: () => {} }).install(asContents(contents))
    await settle()
    // The top document runs in its own isolated world; a frame beside its page.
    expect(contents.isolated.length).toBe(2)
    expect(child.scripts.length).toBe(2)
    expect(child.armedWaits).toBe(1)
  })

  it('names the click the top document reported', async () => {
    const main = new FakeFrame()
    main.framesInSubtree = [main]
    const contents = new FakeContents(main)
    const seen: BrowserLinkPeekRequest[] = []
    new BrowserLinkPeek({ onPeek: (_contents, request) => seen.push(request) }).install(
      asContents(contents)
    )
    await settle()
    contents.report(PEEK_REPORT)
    await settle()
    expect(seen).toEqual([{ ...PEEK_REPORT, frameRelative: false }])
  })

  it('marks a frame’s report as frame-relative and keeps listening in that frame', async () => {
    const main = new FakeFrame()
    const child = new FakeFrame()
    main.framesInSubtree = [main, child]
    const contents = new FakeContents(main)
    const seen: BrowserLinkPeekRequest[] = []
    new BrowserLinkPeek({ onPeek: (_contents, request) => seen.push(request) }).install(
      asContents(contents)
    )
    await settle()
    child.report(PEEK_REPORT)
    await settle()
    expect(seen).toEqual([{ ...PEEK_REPORT, frameRelative: true }])
    // The document is still there, so the next click must be waited for too.
    expect(child.armedWaits).toBe(1)
  })

  it('covers a frame the page creates later', async () => {
    const main = new FakeFrame()
    main.framesInSubtree = [main]
    const contents = new FakeContents(main)
    new BrowserLinkPeek({ onPeek: () => {} }).install(asContents(contents))
    await settle()
    const late = new FakeFrame()
    contents.emitFrameCreated(late)
    await settle()
    expect(late.armedWaits).toBe(1)
  })

  it('re-arms the top document on a navigation without stacking frame observers', async () => {
    const main = new FakeFrame()
    const child = new FakeFrame()
    main.framesInSubtree = [main, child]
    const contents = new FakeContents(main)
    const relay = new BrowserLinkPeek({ onPeek: () => {} })
    relay.install(asContents(contents))
    await settle()
    const childScripts = child.scripts.length
    // The page navigated: the frames it embeds are the same frames, and only the
    // top document is a new one.
    relay.install(asContents(contents))
    await settle()
    expect(child.scripts.length).toBe(childScripts)
    expect(contents.isolatedWaits.length).toBe(2)
  })

  it('stops reporting once the page is released', async () => {
    const main = new FakeFrame()
    const child = new FakeFrame()
    main.framesInSubtree = [main, child]
    const contents = new FakeContents(main)
    const seen: BrowserLinkPeekRequest[] = []
    const relay = new BrowserLinkPeek({ onPeek: (_contents, request) => seen.push(request) })
    relay.install(asContents(contents))
    await settle()
    relay.release(asContents(contents))
    child.report(PEEK_REPORT)
    contents.report(PEEK_REPORT)
    await settle()
    expect(seen).toEqual([])
  })
})

describe('link peek reports', () => {
  it('describes which coordinate space a report came from', () => {
    expect(parseLinkPeekReport({ url: 'https://example.com/a', x: 4, y: 9 }, true)).toEqual({
      url: 'https://example.com/a',
      x: 4,
      y: 9,
      frameRelative: true
    })
    expect(parseLinkPeekReport({ url: 'https://example.com/a', x: 4, y: 9 })).toEqual({
      url: 'https://example.com/a',
      x: 4,
      y: 9,
      frameRelative: false
    })
  })

  it('refuses a report that is not one', () => {
    expect(parseLinkPeekReport(null)).toBeNull()
    expect(parseLinkPeekReport('https://example.com')).toBeNull()
    expect(parseLinkPeekReport({ url: 'javascript:alert(1)', x: 1, y: 2 })).toBeNull()
    expect(parseLinkPeekReport({ url: 'https://example.com', x: -1, y: 2 })).toBeNull()
    expect(parseLinkPeekReport({ url: 'https://example.com', x: '4', y: 2 })).toBeNull()
    expect(parseLinkPeekReport({ url: 'https://example.com', x: 1 })).toBeNull()
  })
})

// `asFrame` documents that the fake stands in for Electron's frame type.
void asFrame
