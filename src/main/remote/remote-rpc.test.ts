import { describe, expect, it } from 'vitest'
import { RemoteRpcDispatcher, type RemoteRpcServices } from './remote-rpc'
import type { Database } from '../database/database'

const allowed = new Set([
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
  it('only allows the phone chat surface channels', () => {
    const dispatcher = makeDispatcher()
    for (const channel of allowed) {
      expect(dispatcher.isAllowed(channel)).toBe(true)
    }
    expect(dispatcher.isAllowed('ipcMain:any')).toBe(false)
    expect(dispatcher.isAllowed('dialog:pickFile')).toBe(false)
    expect(dispatcher.isAllowed('git:status')).toBe(false)
  })

  it('rejects disallowed channels before touching any service', async () => {
    const dispatcher = makeDispatcher()
    const outcome = await dispatcher.dispatch({ id: 1, channel: 'config:get', args: [] })
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
})
