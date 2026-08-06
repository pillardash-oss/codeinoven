import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { APP_SLUG, ORG_SLUG } from '../lib/brand'
import type { Project, Thread } from '../lib/types'
import { DiagnosticsService, type DiagnosticsMetadata } from './diagnostics-service'
import type { Database } from './database/database'
import { createTestDb, destroyTestDb } from './database/test-helper'
import { ProjectRepo } from './database/repositories/project-repo'
import { ThreadRepo } from './database/repositories/thread-repo'

const temporaryPaths: string[] = []
const testDatabases: Database[] = []
const originalHome = process.env.HOME

const metadata: DiagnosticsMetadata = {
  appName: 'CodeInOven',
  appVersion: '0.1.0',
  platform: 'darwin',
  platformRelease: '25.0.0',
  architecture: 'arm64',
  electronVersion: '43.2.0'
}

async function createTestEnvironment(): Promise<{
  home: string
  configRoot: string
  database: Database
}> {
  const home = await mkdtemp(join(tmpdir(), 'codeinoven-diagnostics-home-'))
  temporaryPaths.push(home)
  process.env.HOME = home
  const configRoot = join(home, '.config', ORG_SLUG, APP_SLUG)
  await mkdir(join(configRoot, 'logs'), { recursive: true })
  const database = await createTestDb()
  testDatabases.push(database)
  return { home, configRoot, database }
}

afterEach(async () => {
  process.env.HOME = originalHome
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
  for (const database of testDatabases.splice(0)) destroyTestDb(database)
})

describe('DiagnosticsService', () => {
  it('returns recent redacted logs and metadata-only project/thread summaries', async () => {
    const { configRoot, database } = await createTestEnvironment()
    const now = 1_700_000_000_000
    const project: Project = {
      id: 'project-1',
      name: 'apiKey=project-secret',
      path: '/private/source/path',
      source: 'local',
      providerId: 'opencode',
      workflowId: 'default',
      threadLimit: 70,
      changeTrackingMode: 'git',
      createdAt: now,
      updatedAt: now
    }
    const thread: Thread = {
      id: 'thread-1',
      projectId: project.id,
      providerId: 'opencode',
      title: 'User prompt contents must not be exported',
      titleSource: 'manual',
      status: 'failed',
      pinned: false,
      archived: false,
      read: true,
      sessionId: 'private-session-id',
      createdAt: now,
      updatedAt: now,
      lastActivity: now,
      workingDirectory: '/private/source/path'
    }
    new ProjectRepo(database).upsert(project)
    new ThreadRepo(database).upsert(thread)
    await writeFile(
      join(configRoot, 'logs', 'main.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-01-01T00:00:00.000Z',
          level: 'info',
          message: 'old message'
        }),
        JSON.stringify({
          timestamp: '2026-01-02T00:00:00.000Z',
          level: 'error',
          message: 'Authorization: Bearer top-secret apiKey=also-secret'
        }),
        '{partial'
      ].join('\n'),
      'utf-8'
    )
    await writeFile(
      join(configRoot, 'logs', 'permission-events.jsonl'),
      `${JSON.stringify({
        requestId: 'request-secret',
        sessionId: 'session-secret',
        projectId: project.id,
        threadId: thread.id,
        driverId: 'opencode',
        permission: 'bash',
        patterns: ['/private/source/path', 'cat password.txt'],
        reason: 'token=reason-secret',
        risk: 'high',
        reply: 'reject',
        decidedBy: 'user',
        timestamp: now
      })}\n`,
      'utf-8'
    )

    const report = await new DiagnosticsService(database).createReport(metadata, {
      logLimit: 1,
      now: () => new Date('2026-07-26T12:00:00.000Z')
    })
    const serialized = JSON.stringify(report)

    expect(report.generatedAt).toBe('2026-07-26T12:00:00.000Z')
    expect(report.logs).toEqual([
      {
        timestamp: '2026-01-02T00:00:00.000Z',
        level: 'error',
        message: 'Authorization: [REDACTED] apiKey=[REDACTED]'
      }
    ])
    expect(report.permissionEvents).toEqual([
      {
        timestamp: now,
        projectId: project.id,
        threadId: thread.id,
        driverId: 'opencode',
        permission: 'bash',
        risk: 'high',
        reply: 'reject',
        decidedBy: 'user'
      }
    ])
    expect(report.projects[0]?.threads[0]).toMatchObject({
      id: thread.id,
      status: 'failed',
      hasSession: true
    })
    expect(report.projects[0]).not.toHaveProperty('path')
    expect(report.projects[0]?.threads[0]).not.toHaveProperty('title')
    expect(serialized).not.toContain('project-secret')
    expect(serialized).not.toContain('top-secret')
    expect(serialized).not.toContain('also-secret')
    expect(serialized).not.toContain('request-secret')
    expect(serialized).not.toContain('session-secret')
    expect(serialized).not.toContain('/private/source/path')
    expect(serialized).not.toContain('User prompt contents')
    expect(serialized).not.toContain('reason-secret')
  })

  it('writes an atomic JSON report only to an explicit safe destination', async () => {
    const { home, database } = await createTestEnvironment()
    const exportDirectory = join(home, 'exports')
    await mkdir(exportDirectory)
    const destination = join(exportDirectory, 'diagnostics.json')
    const service = new DiagnosticsService(database)

    await expect(service.writeReport(destination, metadata)).resolves.toBe(destination)
    const report = JSON.parse(await readFile(destination, 'utf-8')) as {
      schemaVersion: number
      metadata: { appName: string }
    }
    expect(report.schemaVersion).toBe(1)
    expect(report.metadata.appName).toBe('CodeInOven')

    await expect(service.writeReport('relative/diagnostics.json', metadata)).rejects.toThrow(
      'absolute path'
    )
    await expect(
      service.writeReport(`${exportDirectory}/../escaped.json`, metadata)
    ).rejects.toThrow('parent traversal')

    const target = join(exportDirectory, 'target.json')
    const link = join(exportDirectory, 'linked.json')
    await service.writeReport(target, metadata)
    await symlink(target, link)
    await expect(service.writeReport(link, metadata)).rejects.toThrow('regular file')
  })
})
