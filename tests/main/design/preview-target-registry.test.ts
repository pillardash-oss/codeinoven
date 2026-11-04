import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  previewFolderId,
  previewTargetId,
  type PreviewFolder,
  type PreviewTarget
} from '../../../src/lib/design/preview-target'
import { designScreenTabId } from '../../../src/main/browser/browser-service/design-screen-tab'
import { DirectoryPreviewService } from '../../../src/main/preview/directory-preview-service'
import { PreviewTargetRegistry } from '../../../src/main/design/preview-target-registry'

const roots: string[] = []
const services: DirectoryPreviewService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function scratchRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-preview-targets-'))
  roots.push(root)
  return root
}

/** The record file one registry reads and writes, in a folder of its own. */
async function recordFile(name = 'preview-sessions.json'): Promise<string> {
  return join(await scratchRoot(), name)
}

function targetOf(entry: string | null, threadId = 'thread-1'): PreviewTarget {
  return { projectId: 'project-1', threadId, directory: '.cio/designs/site', entry }
}

function folderOf(target: PreviewTarget): PreviewFolder {
  return { projectId: target.projectId, threadId: target.threadId, directory: target.directory }
}

describe('preview target identity', () => {
  it('names one screen, canvas and live preview stably, and apart', () => {
    const live = targetOf('index.html')
    expect(previewTargetId({ ...live })).toBe(previewTargetId(live))
    // A canvas, a live preview and the folder listing are three pages, not one.
    expect(previewTargetId(targetOf('__cio/canvas.html'))).not.toBe(previewTargetId(live))
    expect(previewTargetId(targetOf(null))).not.toBe(previewTargetId(live))
    // Two threads looking at the same file are looking at their own page.
    expect(previewTargetId(targetOf('index.html', 'thread-2'))).not.toBe(previewTargetId(live))
    // One design folder per screen identity, so a second design is a second page.
    expect(previewTargetId({ ...live, directory: '.cio/designs/other' })).not.toBe(
      previewTargetId(live)
    )
    // The tab a screen is shown in comes from the same identity, so the app that
    // derives a tab and the record that remembers one agree on "the same screen".
    expect(designScreenTabId(live)).toBe(designScreenTabId({ ...live }))
    expect(designScreenTabId(live)).toMatch(/^browser:screen:[0-9a-f]{32}$/u)
    expect(designScreenTabId(targetOf('about.html'))).not.toBe(designScreenTabId(live))
  })

  it('names a folder apart from the screens inside it', () => {
    const live = targetOf('index.html')
    // Every screen of one design, the canvas and the live preview share a folder,
    // which is what makes them share one preview server.
    expect(previewFolderId(folderOf(live))).toBe(previewFolderId(folderOf(targetOf('about.html'))))
    expect(previewFolderId(folderOf(live))).toBe(previewFolderId(folderOf(targetOf(null))))
    expect(previewFolderId(folderOf(live))).not.toBe(
      previewFolderId(folderOf(targetOf('index.html', 'thread-2')))
    )
    expect(previewFolderId(folderOf(live))).not.toBe(
      previewFolderId({ ...folderOf(live), directory: '.cio/designs/other' })
    )
  })
})

describe('preview target records', () => {
  it('answers the tab and the port a screen was given after a restart', async () => {
    const file = await recordFile()
    const target = targetOf('index.html')
    const serverRoot = '/projects/demo/.cio/designs/site'
    const first = new PreviewTargetRegistry(file)
    await first.rememberTab(target, 'browser:screen:AAAA')
    await first.rememberServer(folderOf(target), { root: serverRoot, port: 51_234 })

    const restarted = new PreviewTargetRegistry(file)
    await expect(restarted.tabFor(target, (id) => id === 'browser:screen:AAAA')).resolves.toBe(
      'browser:screen:AAAA'
    )
    await expect(restarted.portFor(folderOf(target), () => null)).resolves.toBe(51_234)
    // The port belongs to the folder, so every screen of the design reads it back.
    await expect(restarted.portFor(folderOf(targetOf('about.html')), () => null)).resolves.toBe(
      51_234
    )
  })

  it('drops a tab the browser no longer holds, and keeps the folder server', async () => {
    const file = await recordFile()
    const target = targetOf('index.html')
    const folder = folderOf(target)
    const registry = new PreviewTargetRegistry(file)
    await registry.rememberTab(target, 'browser:screen:AAAA')
    await registry.rememberServer(folder, {
      root: '/projects/demo/.cio/designs/site',
      port: 51_234
    })

    await expect(registry.tabFor(target, () => false)).resolves.toBeNull()
    await expect(registry.snapshot()).resolves.toMatchObject({ tabs: [] })
    // Other screens of the same design still share the folder's server.
    await expect(registry.portFor(folder, () => null)).resolves.toBe(51_234)
    // The drop is written, so a restart does not bring the dead tab back.
    const restarted = new PreviewTargetRegistry(file)
    await expect(restarted.tabFor(target, () => true)).resolves.toBeNull()
  })

  it('does not trust a remembered port once the folder is served elsewhere', async () => {
    const file = await recordFile()
    const folder = folderOf(targetOf('index.html'))
    const registry = new PreviewTargetRegistry(file)
    await registry.rememberServer(folder, {
      root: '/projects/demo/.cio/designs/site',
      port: 51_234
    })

    await expect(registry.portFor(folder, () => 52_000)).resolves.toBeNull()
    // Nothing is live in a fresh launch, which is exactly when the record is what
    // the app has to go on.
    await expect(registry.portFor(folder, () => null)).resolves.toBe(51_234)
  })

  it('forgets one thread and answers the folders no record names any more', async () => {
    const file = await recordFile()
    const registry = new PreviewTargetRegistry(file)
    const root = '/projects/demo/.cio/designs/shared'
    const mine = folderOf(targetOf('index.html', 'thread-1'))
    const theirs = folderOf(targetOf('index.html', 'thread-2'))
    await registry.rememberTab(targetOf('index.html', 'thread-1'), 'browser:screen:AAAA')
    await registry.rememberServer(mine, { root, port: 51_234 })
    await registry.rememberServer(theirs, { root, port: 51_234 })

    // Another thread is still looking at the same folder, so its server stays.
    await expect(registry.forgetThread('thread-1')).resolves.toEqual([])
    await expect(registry.forgetThread('thread-2')).resolves.toEqual([root])
    await expect(registry.snapshot()).resolves.toEqual({ tabs: [], servers: [] })
  })

  it('reads only the records it can trust, and survives a broken file', async () => {
    const file = await recordFile()
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        tabs: [
          {
            projectId: 'project-1',
            threadId: 'thread-1',
            directory: '.cio/designs/site',
            entry: 'untrusted.html',
            tabId: 'not-a-tab-id',
            updatedAt: 1
          },
          {
            projectId: 'project-1',
            threadId: 'thread-1',
            directory: '.cio/designs/site',
            entry: 'trusted.html',
            tabId: 'browser:screen:BBBB',
            updatedAt: 1
          }
        ],
        servers: [
          {
            projectId: 'project-1',
            threadId: 'thread-1',
            directory: '.cio/designs/one',
            root: '/projects/demo/.cio/designs/one',
            port: 80,
            updatedAt: 1
          },
          {
            projectId: 'project-1',
            threadId: 'thread-1',
            directory: '.cio/designs/two',
            root: '/projects/demo/.cio/designs/two',
            port: 51_234,
            updatedAt: 1
          }
        ]
      })
    )
    const registry = new PreviewTargetRegistry(file)
    const snapshot = await registry.snapshot()
    expect(snapshot.tabs.map((record) => record.entry)).toEqual(['trusted.html'])
    expect(snapshot.servers.map((record) => record.port)).toEqual([51_234])

    await writeFile(file, '{ this is not json')
    await expect(new PreviewTargetRegistry(file).snapshot()).resolves.toEqual({
      tabs: [],
      servers: []
    })
  })
})

describe('preview server reuse', () => {
  it('serves a folder again on the port it remembered, and falls back when it is taken', async () => {
    const firstRoot = await scratchRoot()
    const secondRoot = await scratchRoot()
    await writeFile(join(firstRoot, 'index.html'), '<h1>One</h1>')
    await writeFile(join(secondRoot, 'index.html'), '<h1>Two</h1>')

    const first = new DirectoryPreviewService()
    services.push(first)
    const registration = await first.open(firstRoot)
    expect(registration.started).toBe(true)
    const entry = `${registration.url}index.html`
    await expect((await fetch(entry)).text()).resolves.toContain('One')
    await first.dispose()

    // A restarted app asks for the port it remembers, so a browser tab restored
    // onto that origin still finds the design.
    const restored = new DirectoryPreviewService()
    services.push(restored)
    const again = await restored.open(firstRoot, { port: registration.port })
    expect(again.port).toBe(registration.port)
    await expect((await fetch(`${again.url}index.html`)).text()).resolves.toContain('One')

    // A port another folder is already using is a preference, not a promise.
    const other = new DirectoryPreviewService()
    services.push(other)
    const elsewhere = await other.open(secondRoot, { port: registration.port })
    expect(elsewhere.port).not.toBe(registration.port)
    expect(elsewhere.port).toBeGreaterThan(0)
    await expect((await fetch(`${elsewhere.url}index.html`)).text()).resolves.toContain('Two')
  })

  it('reuses one server for every screen of a folder', async () => {
    const root = await scratchRoot()
    await writeFile(join(root, 'index.html'), '<h1>One</h1>')
    const service = new DirectoryPreviewService()
    services.push(service)
    const first = await service.open(root)
    const second = await service.open(root, { port: 51_234 })
    expect(second.started).toBe(false)
    expect(second.port).toBe(first.port)
    expect(service.registrationFor(first.root)?.port).toBe(first.port)
    expect(service.size).toBe(1)
  })
})
