import { describe, expect, it } from 'vitest'
import { RemoteRpcDispatcher, type RemoteRpcServices } from './remote-rpc'
import type { Database } from '../database/database'
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
    expect(dispatcher.isAllowed('git:status')).toBe(false)
    expect(dispatcher.isAllowed('editors:detect')).toBe(false)
    expect(dispatcher.isAllowed('providerAccounts:beginLogin')).toBe(false)
  })

  it('rejects disallowed channels before touching any service', async () => {
    const dispatcher = makeDispatcher()
    const outcome = await dispatcher.dispatch({ id: 1, channel: 'git:status', args: [] })
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
})
