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
})
