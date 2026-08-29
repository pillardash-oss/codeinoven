import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTestDb, destroyTestDb } from '../database/test-helper'
import { ProjectRepo } from '../../../src/main/database/repositories/project-repo'
import { ThreadRepo } from '../../../src/main/database/repositories/thread-repo'
import { AgentMessageRepo } from '../../../src/main/database/repositories/agent-message-repo'
import type { Database } from '../../../src/main/database/database'
import { CioDiagnosticsService } from '../../../src/main/utilities/cio-diagnostics-service'
import { APP_SLUG, ORG_SLUG } from '../../../src/lib/brand'

const temporaryPaths: string[] = []
const temporaryDatabases: Database[] = []
const originalHome = process.env.HOME
let configRoot = ''

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'codeinoven-cio-diagnostics-'))
  temporaryPaths.push(home)
  process.env.HOME = home
  configRoot = join(home, '.config', ORG_SLUG, APP_SLUG)
  mkdirSync(join(configRoot, 'logs'), { recursive: true })
})

afterEach(() => {
  process.env.HOME = originalHome
  for (const path of temporaryPaths.splice(0)) rmSync(path, { force: true, recursive: true })
  temporaryDatabases.splice(0).forEach(destroyTestDb)
})

async function createService(): Promise<CioDiagnosticsService> {
  const db = await createTestDb()
  temporaryDatabases.push(db)
  new ProjectRepo(db).upsert({
    id: 'project1',
    name: 'Test project',
    path: '/tmp/project1',
    source: 'local',
    providerId: 'openai',
    workflowId: 'default',
    threadLimit: 70,
    changeTrackingMode: 'manual',
    createdAt: Date.now(),
    updatedAt: Date.now()
  })
  const threadRepo = new ThreadRepo(db)
  threadRepo.upsert({
    id: 'thread-1',
    projectId: 'project1',
    providerId: 'openai',
    title: 'Broken checkout button',
    titleSource: 'auto',
    status: 'created',
    pinned: false,
    archived: false,
    read: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastActivity: Date.now(),
    workingDirectory: '/tmp/project1'
  })
  const messageRepo = new AgentMessageRepo(db)
  messageRepo.upsert(
    {
      id: 'msg-1',
      role: 'user',
      parts: [{ type: 'text', id: 'p1', messageID: 'msg-1', text: 'Checkout is broken' }],
      createdAt: 1_000
    },
    'thread-1'
  )
  messageRepo.upsert(
    {
      id: 'msg-2',
      role: 'assistant',
      parts: [
        {
          type: 'text',
          id: 'p2',
          messageID: 'msg-2',
          text: 'The crash came from src/checkout.ts with token=sk-abc123def456'
        }
      ],
      error: 'Provider request failed with Authorization Bearer abc.def.ghi',
      modelId: 'gpt-test',
      providerId: 'openai',
      createdAt: 2_000
    },
    'thread-1'
  )
  const names = new Map([['project1', 'Test project']])
  return new CioDiagnosticsService(db, () => names)
}

describe('CioDiagnosticsService', () => {
  it('finds a thread by id and by exact title', async () => {
    const service = await createService()
    const byId = await service.lookupThread('thread-1')
    expect(byId.matchedThread).toMatchObject({ id: 'thread-1', projectName: 'Test project' })
    expect(byId.candidates).toEqual([])

    const byTitle = await service.lookupThread('Broken Checkout Button')
    expect(byTitle.matchedThread).toMatchObject({ id: 'thread-1' })

    const miss = await service.lookupThread('nonexistent')
    expect(miss.matchedThread).toBeNull()
    expect(miss.candidates).toEqual([])
  })

  it('searches threads by title substring across projects', async () => {
    const service = await createService()
    const found = await service.searchThreads('checkout')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ id: 'thread-1', projectName: 'Test project' })
  })

  it('loads bounded redacted messages oldest-to-newest', async () => {
    const service = await createService()
    const messages = await service.loadThreadMessages('thread-1', 10)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user', text: 'Checkout is broken' })
    expect(messages[1]?.role).toBe('assistant')
    // Secrets in message bodies and errors are redacted.
    expect(messages[1]?.text).not.toContain('sk-abc123def456')
    expect(messages[1]?.text).toContain('[REDACTED]')
    expect(messages[1]?.error).not.toContain('abc.def.ghi')
    expect(messages[1]?.error).toContain('[REDACTED]')
  })

  it('returns no messages for an unknown thread', async () => {
    const service = await createService()
    expect(await service.loadThreadMessages('missing-thread', 10)).toEqual([])
  })

  it('reads bounded redacted entries from an allow-listed log file', async () => {
    writeFileSync(
      join(configRoot, 'logs', 'main.jsonl'),
      [
        JSON.stringify({ timestamp: '2026-08-29T10:00:00Z', level: 'info', message: 'started' }),
        JSON.stringify({
          timestamp: '2026-08-29T10:01:00Z',
          level: 'error',
          message: 'failed api_key=supersecret123'
        }),
        'not-json-garbage'
      ].join('\n')
    )
    const service = await createService()
    const result = await service.readLog('logs/main.jsonl', { level: 'error', limit: 10 })
    expect(result.file).toBe('logs/main.jsonl')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.level).toBe('error')
    expect(result.entries[0]?.message).toContain('[REDACTED]')
    expect(result.entries[0]?.message).not.toContain('supersecret123')
    expect(result.truncated).toBe(false)
  })

  it('rejects log files outside the allow-list', async () => {
    const service = await createService()
    await expect(service.readLog('../../etc/passwd')).rejects.toThrow(/not readable/iu)
    await expect(service.readLog('config.json')).rejects.toThrow(/not readable/iu)
  })

  it('returns empty entries when the log file does not exist', async () => {
    const service = await createService()
    const result = await service.readLog('logs/error.log')
    expect(result.entries).toEqual([])
    expect(result.truncated).toBe(false)
    expect(result.file).toBe('logs/error.log')
  })
})
