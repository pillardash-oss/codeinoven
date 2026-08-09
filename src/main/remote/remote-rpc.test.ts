import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { simpleGit } from 'simple-git'
import { RemoteRpcDispatcher, type RemoteRpcServices } from './remote-rpc'
import type { Database } from '../database/database'
import { ProjectRepo } from '../database/repositories/project-repo'
import { createTestDb, destroyTestDb } from '../database/test-helper'
import { REMOTE_ALLOWED_CHANNELS } from '../../lib/remote-rpc'

const coreAllowed = new Set([
  'project:list',
  'project:get',
  'thread:listAll',
  'thread:list',
  'thread:get',
  'thread:create',
  'thread:markRead',
  'thread:setArchived',
  'thread:setPinned',
  'thread:setStatus',
  'thread:updateSettings',
  'thread:setContextUsage',
  'thread:harnessUsage',
  'agent:loadMessages',
  'agent:listProviderSnapshot',
  'agent:getSessionStatus',
  'agent:ensureSession',
  'agent:sendPrompt',
  'agent:steerPrompt',
  'agent:abort',
  'agent:listPermissions',
  'agent:replyPermission',
  'agent:listQuestions',
  'agent:answerQuestion'
])

function makeDispatcher(overrides: Partial<RemoteRpcServices> = {}): RemoteRpcDispatcher {
  const chatEngine = {
    loadMessages: async () => [],
    deleteThreadSession: async () => undefined,
    listProviderSnapshot: async () => [],
    getSessionStatus: async () => null,
    ensureSession: async () => 'session-1',
    sendPrompt: async () => ({ id: 'm1', role: 'assistant', parts: [], createdAt: 0 }),
    steerPrompt: async () => ({ id: 'm2', role: 'assistant', parts: [], createdAt: 0 }),
    abort: async () => undefined,
    listPermissions: async () => [],
    replyPermission: async () => undefined,
    listQuestions: async () => [],
    answerQuestion: async () => undefined,
    ...overrides.chatEngine
  } as unknown as RemoteRpcServices['chatEngine']

  const database = overrides.database ?? ({} as Database)
  return new RemoteRpcDispatcher({ database, chatEngine, projectManager: overrides.projectManager })
}

describe('RemoteRpcDispatcher', () => {
  it('allows the desktop-reuse surface and nothing else', () => {
    const dispatcher = makeDispatcher()
    for (const channel of coreAllowed) {
      expect(dispatcher.isAllowed(channel)).toBe(true)
    }
    // The expanded surface — every channel the reused desktop components call.
    for (const channel of REMOTE_ALLOWED_CHANNELS) {
      expect(dispatcher.isAllowed(channel)).toBe(true)
    }
    expect(dispatcher.isAllowed('ipcMain:any')).toBe(false)
    expect(dispatcher.isAllowed('git:status')).toBe(true)
    expect(dispatcher.isAllowed('git:setCredential')).toBe(false)
    expect(dispatcher.isAllowed('editors:detect')).toBe(false)
    expect(dispatcher.isAllowed('providerAccounts:beginLogin')).toBe(false)
  })

  it('rejects disallowed channels before touching any service', async () => {
    const dispatcher = makeDispatcher()
    const outcome = await dispatcher.dispatch({ id: 1, channel: 'git:setCredential', args: [] })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain('not allowed')
  })

  it('routes agent:loadMessages through the chat engine', async () => {
    const chatEngine = {
      loadMessages: async () => [{ id: 'a', role: 'assistant', parts: [], createdAt: 1 }]
    } as unknown as RemoteRpcServices['chatEngine']
    const dispatcher = makeDispatcher({ chatEngine })
    const outcome = await dispatcher.dispatch({
      id: 2,
      channel: 'agent:loadMessages',
      args: ['proj-1', 'thread-1']
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok)
      expect(outcome.result).toEqual([{ id: 'a', role: 'assistant', parts: [], createdAt: 1 }])
  })

  it('propagates service errors as a failed result, never throwing', async () => {
    const chatEngine = {
      loadMessages: async () => {
        throw new Error('boom')
      }
    } as unknown as RemoteRpcServices['chatEngine']
    const dispatcher = makeDispatcher({ chatEngine })
    const outcome = await dispatcher.dispatch({
      id: 3,
      channel: 'agent:loadMessages',
      args: ['p', 't']
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toBe('boom')
  })

  it('routes agent:sendPrompt with presentation at the same index the renderer sends it', async () => {
    const calls: Array<unknown[]> = []
    const chatEngine = {
      sendPrompt: async (...args: unknown[]) => {
        calls.push(args)
        return { id: 'm1', role: 'assistant', parts: [], createdAt: 0 }
      }
    } as unknown as RemoteRpcServices['chatEngine']
    const dispatcher = makeDispatcher({ chatEngine })
    const presentation = { action: 'share', body: 'look here' }
    const taskReferences = [{ taskId: 't-1' }]
    const outcome = await dispatcher.dispatch({
      id: 4,
      channel: 'agent:sendPrompt',
      args: [
        'proj-1',
        'thread-1',
        { harnessId: 'opencode', model: 'gpt-5' },
        'hello',
        [],
        undefined,
        'msg-1',
        'ctx',
        [],
        [],
        presentation,
        taskReferences
      ]
    })
    expect(outcome.ok).toBe(true)
    expect(calls).toHaveLength(1)
    const routed = calls[0]
    expect(routed[0]).toBe('proj-1')
    expect(routed[1]).toBe('thread-1')
    expect(routed[3]).toBe('hello')
    expect(routed[10]).toBe('user')
    expect(routed[11]).toEqual(presentation)
    expect(routed[12]).toEqual(taskReferences)
  })

  it('routes git:status to the shared GitService for a real repository', async () => {
    const gitDir = await mkdtemp(join(tmpdir(), 'codeinoven-remote-git-'))
    const db = await createTestDb()
    try {
      const repo = simpleGit(gitDir)
      await repo.init({ '--initial-branch': 'main' })
      await writeFile(join(gitDir, 'file.txt'), 'hello\n', 'utf-8')
      await repo.add('.')
      await repo.commit('initial')

      const now = Date.now()
      new ProjectRepo(db).upsert({
        id: 'git-project',
        name: 'Git project',
        path: gitDir,
        source: 'local',
        providerId: 'openai',
        workflowId: 'default',
        threadLimit: 70,
        changeTrackingMode: 'git',
        createdAt: now,
        updatedAt: now
      })

      const dispatcher = makeDispatcher({ database: db })
      const outcome = await dispatcher.dispatch({
        id: 9,
        channel: 'git:status',
        args: ['git-project']
      })
      expect(outcome.ok).toBe(true)
      if (outcome.ok) expect(outcome.result).toMatchObject({ branch: 'main' })
    } finally {
      destroyTestDb(db)
      await rm(gitDir, { recursive: true, force: true })
    }
  })

  it('rejects git:setCredential over the bridge — the vault stays desktop-only', async () => {
    const dispatcher = makeDispatcher()
    const outcome = await dispatcher.dispatch({
      id: 10,
      channel: 'git:setCredential',
      args: ['git-project', 'ghp_secret']
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain('not allowed')
  })
})
