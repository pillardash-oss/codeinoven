import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTestDb, destroyTestDb } from '../database/test-helper'
import { ProjectRepo } from '../../../src/main/database/repositories/project-repo'
import { ThreadRepo } from '../../../src/main/database/repositories/thread-repo'
import { DesignService } from '../../../src/main/design/design-service'
import type { DirectoryPreviewService } from '../../../src/main/preview/directory-preview-service'
import type { Database } from '../../../src/main/database/database'
import { APP_SLUG, ORG_SLUG } from '../../../src/lib/brand'

const temporaryPaths: string[] = []
let database: Database | undefined
let service: DesignService
let projectPath = ''
const projectId = 'project1'
const threadId = 'thread-design'

beforeEach(async () => {
  // The blob store behind a design's history is app data, so the app root is a
  // throwaway here too and no test writes into the real one.
  const home = mkdtempSync(join(tmpdir(), 'codeinoven-design-history-'))
  temporaryPaths.push(home)
  process.env.HOME = home
  mkdirSync(join(home, '.config', ORG_SLUG, APP_SLUG), { recursive: true })

  projectPath = realpathSync(mkdtempSync(join(tmpdir(), 'codeinoven-design-project-')))
  temporaryPaths.push(projectPath)
  mkdirSync(join(projectPath, '.cio', 'designs', 'hero'), { recursive: true })

  database = await createTestDb()
  new ProjectRepo(database).upsert({
    id: projectId,
    name: 'Design project',
    path: projectPath,
    source: 'local',
    providerId: 'openai',
    workflowId: 'default',
    threadLimit: 70,
    changeTrackingMode: 'manual',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  new ThreadRepo(database).upsert({
    id: threadId,
    projectId,
    providerId: 'openai',
    title: 'Hero design',
    titleSource: 'auto',
    status: 'created',
    pinned: false,
    archived: false,
    read: true,
    authoredWorkKind: 'design',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastActivity: Date.now(),
    workingDirectory: projectPath
  })
  service = new DesignService({
    database,
    previews: {} as DirectoryPreviewService,
    browser: () => null
  })
  // A real turn previews what it writes, and that preview is what makes the
  // folder the thread's current design; the timeline then defaults to it.
  service.recordPreview({
    projectId,
    threadId,
    directory: '.cio/designs/hero',
    entry: 'index.html',
    kind: 'design'
  })
})

afterEach(() => {
  if (database) destroyTestDb(database)
  database = undefined
  for (const path of temporaryPaths.splice(0)) rmSync(path, { force: true, recursive: true })
})

function screenPath(): string {
  return join(projectPath, '.cio', 'designs', 'hero', 'index.html')
}

describe('DesignService design history capability', () => {
  it('reads the timeline and rewinds an edit to a point that worked', async () => {
    writeFileSync(screenPath(), '<h1>Hero that worked</h1>', 'utf-8')

    const first = await service.historyCapability(projectId, threadId, {})
    expect(first.directory).toBe('.cio/designs/hero')
    expect(first.gitBacked).toBe(false)
    expect(first.totalRevisions).toBe(1)
    expect(first.currentRevision).toBe(1)

    writeFileSync(screenPath(), '<h1>Broken hero</h1>', 'utf-8')
    const second = await service.historyCapability(projectId, threadId, {})
    expect(second.totalRevisions).toBe(2)
    expect(second.currentRevision).toBe(2)

    const restored = await service.restoreCapability(projectId, threadId, { revision: 1 })
    expect(restored.restored.revision).toBe(1)
    expect(readFileSync(screenPath(), 'utf-8')).toContain('Hero that worked')
    // The broken state the agent left is still a point of its own, so the board's
    // Redo can return to it: a rewind never throws work away.
    expect(restored.history.currentRevision).toBe(1)
    expect(restored.history.totalRevisions).toBe(2)
    expect(restored.history.revisions.map((point) => point.revision)).toEqual([1, 2])
  })

  it('accepts a revisionId and refuses a point the timeline does not hold', async () => {
    writeFileSync(screenPath(), '<h1>First</h1>', 'utf-8')
    const first = await service.historyCapability(projectId, threadId, {})
    const revisionId = first.revisions[0]?.revisionId ?? ''
    expect(revisionId).not.toBe('')

    writeFileSync(screenPath(), '<h1>Second</h1>', 'utf-8')
    await service.historyCapability(projectId, threadId, {})
    await expect(
      service.restoreCapability(projectId, threadId, { revision: 'rev-missing' })
    ).rejects.toThrow(/No revision named/u)

    const restored = await service.restoreCapability(projectId, threadId, { revision: revisionId })
    expect(restored.restored.revisionId).toBe(revisionId)
    expect(readFileSync(screenPath(), 'utf-8')).toContain('First')
  })

  it('rewinds one screen alone, and lists the screens the timeline touched', async () => {
    const aboutPath = join(projectPath, '.cio', 'designs', 'hero', 'about.html')
    writeFileSync(screenPath(), '<h1>Hero v1</h1>', 'utf-8')
    writeFileSync(aboutPath, '<h1>About v1</h1>', 'utf-8')
    const first = await service.historyCapability(projectId, threadId, {})
    const heroPoint = first.screens.find((screen) => screen.path === 'index.html')
    expect(heroPoint).toMatchObject({ present: true, lastChangedRevision: 1 })

    writeFileSync(screenPath(), '<h1>Hero broken</h1>', 'utf-8')
    writeFileSync(aboutPath, '<h1>About v2</h1>', 'utf-8')
    await service.historyCapability(projectId, threadId, {})

    const page = await service.historyCapability(projectId, threadId, { page: 'index.html' })
    expect(page.page?.path).toBe('index.html')
    expect(page.page?.revisions.length).toBeGreaterThanOrEqual(2)

    await service.restoreCapability(projectId, threadId, {
      revision: page.page?.revisions[0]?.revision ?? 1,
      page: 'index.html'
    })
    expect(readFileSync(screenPath(), 'utf-8')).toContain('Hero v1')
    // The other screen was not part of that rewind.
    expect(readFileSync(aboutPath, 'utf-8')).toContain('About v2')
  })

  it('answers the same two operations for a composition folder', async () => {
    const videoThreadId = 'thread-video'
    new ThreadRepo(database as Database).upsert({
      id: videoThreadId,
      projectId,
      providerId: 'openai',
      title: 'Opening composition',
      titleSource: 'auto',
      status: 'created',
      pinned: false,
      archived: false,
      read: true,
      authoredWorkKind: 'video',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastActivity: Date.now(),
      workingDirectory: projectPath
    })
    const compositionPath = join(projectPath, '.cio', 'videos', 'opening', 'index.html')
    mkdirSync(join(projectPath, '.cio', 'videos', 'opening'), { recursive: true })
    writeFileSync(compositionPath, '<main>opening v1</main>', 'utf-8')
    service.recordPreview({
      projectId,
      threadId: videoThreadId,
      directory: '.cio/videos/opening',
      entry: 'index.html',
      kind: 'video'
    })

    const first = await service.historyCapability(projectId, videoThreadId, {})
    expect(first.directory).toBe('.cio/videos/opening')
    expect(first.totalRevisions).toBe(1)

    writeFileSync(compositionPath, '<main>opening wrecked</main>', 'utf-8')
    await service.historyCapability(projectId, videoThreadId, {})
    const restored = await service.restoreCapability(projectId, videoThreadId, { revision: 1 })
    expect(restored.restored.revision).toBe(1)
    expect(readFileSync(compositionPath, 'utf-8')).toContain('opening v1')
  })
})
