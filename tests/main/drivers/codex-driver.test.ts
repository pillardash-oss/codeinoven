import { EventEmitter } from 'events'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import type { AgentEvent } from '../../../src/lib/types'
import { StorageEngine } from '../../../src/main/storage/storage-engine'
import {
  CodexDriver,
  mapCodexRateLimits,
  mapCodexUsage
} from '../../../src/main/drivers/codex-driver'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('child_process')>()
  return { ...original, spawn: spawnMock }
})

class FakeChild extends EventEmitter {
  private threadSequence = 0
  private turnSequence = 0
  threadReadResult: Record<string, unknown> = {}
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = {
    write: vi.fn((value: string) => {
      const payload = JSON.parse(value) as Record<string, unknown>
      const id = typeof payload['id'] === 'number' ? payload['id'] : undefined
      const method = typeof payload['method'] === 'string' ? payload['method'] : undefined
      if (id === undefined || !method) return true
      const params = payload['params'] as Record<string, unknown> | undefined
      const result =
        method === 'thread/start' || method === 'thread/resume'
          ? {
              thread: {
                id:
                  method === 'thread/resume'
                    ? params?.['threadId']
                    : `native-${++this.threadSequence}`
              }
            }
          : method === 'turn/start'
            ? {
                turn: {
                  id: `turn-${++this.turnSequence}`,
                  status: 'inProgress',
                  items: []
                }
              }
            : method === 'turn/steer'
              ? { turnId: 'turn-1' }
              : {}
      queueMicrotask(() =>
        this.emitPayload({ id, result: method === 'thread/read' ? this.threadReadResult : result })
      )
      return true
    }),
    end: vi.fn()
  }
  killed = false
  emitPayload(payload: Record<string, unknown>): void {
    this.stdout.emit('data', Buffer.from(`${JSON.stringify(payload)}\n`))
  }
  requests(): Array<Record<string, unknown>> {
    return this.stdin.write.mock.calls.map(
      ([value]) => JSON.parse(value) as Record<string, unknown>
    )
  }
  kill(): boolean {
    this.killed = true
    this.emit('exit', null, 'SIGTERM')
    return true
  }
}

const roots: string[] = []
afterEach(async () => {
  spawnMock.mockReset()
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function storage(): Promise<StorageEngine> {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-codex-driver-'))
  roots.push(root)
  const value = new StorageEngine(root)
  await value.initialize()
  return value
}

const settings = {
  harnessId: 'codex',
  providerId: 'openai',
  modelId: 'gpt-5.6-sol',
  thinkingLevel: 'medium' as const,
  permissionLevel: 'auto_review' as const,
  engineeringMode: false
}

describe.skipIf(process.platform === 'win32')('CodexDriver', () => {
  it('maps Codex collaboration items into a visible subagent lifecycle', async () => {
    const driver = new CodexDriver(await storage())
    const events: AgentEvent[] = []
    driver.onEvent((event) => events.push(event))
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const sessionId = await driver.createSession('/project', 'Codex')
    await driver.sendPrompt('/project', {
      sessionId,
      settings,
      text: 'Delegate research',
      attachments: []
    })

    child.emitPayload({
      method: 'item/started',
      params: {
        threadId: 'native-1',
        turnId: 'turn-1',
        item: {
          id: 'collab-1',
          type: 'collabToolCall',
          tool: 'spawnAgent',
          status: 'inProgress',
          senderThreadId: 'native-1',
          newThreadId: 'native-child-1',
          prompt: 'Inspect the renderer'
        }
      }
    })
    child.emitPayload({
      method: 'item/completed',
      params: {
        threadId: 'native-1',
        turnId: 'turn-1',
        item: {
          id: 'collab-1',
          type: 'collabToolCall',
          tool: 'spawnAgent',
          status: 'completed',
          senderThreadId: 'native-1',
          newThreadId: 'native-child-1',
          prompt: 'Inspect the renderer',
          output: 'Renderer inspected'
        }
      }
    })

    const activities = events
      .filter((event) => event.type === 'message.part.updated')
      .map((event) => event.part)
      .filter((part) => part.type === 'subagent')
      .map((part) => part.activity)
    expect(activities).toContainEqual(
      expect.objectContaining({
        status: 'running',
        childSessionId: 'native-child-1',
        providerTaskId: `${sessionId}:collab-1`
      })
    )
    expect(activities).toContainEqual(
      expect.objectContaining({
        status: 'completed',
        childSessionId: 'native-child-1',
        output: 'Renderer inspected'
      })
    )
    child.threadReadResult = {
      thread: {
        id: 'native-child-1',
        turns: [
          {
            id: 'child-turn-1',
            items: [
              {
                id: 'child-user-1',
                type: 'userMessage',
                content: [{ type: 'text', text: 'Inspect the renderer' }]
              },
              {
                id: 'child-answer-1',
                type: 'agentMessage',
                text: 'Renderer inspected'
              }
            ]
          }
        ]
      }
    }
    const childMessages = await driver.loadMessages('/project', 'native-child-1')
    expect(childMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', visibility: 'subagent_trace' }),
        expect.objectContaining({ role: 'assistant', visibility: 'subagent_trace' })
      ])
    )
    child.emit('exit', 0, null)
  })

  it('runs new and resumed turns through one shared app-server with the selected sandbox', async () => {
    const driver = new CodexDriver(await storage())
    const events: AgentEvent[] = []
    driver.onEvent((event) => events.push(event))
    const sharedChild = new FakeChild()
    spawnMock.mockReturnValue(sharedChild as unknown as ChildProcess)
    const sessionId = await driver.createSession('/project', 'Codex')
    await driver.sendPrompt('/project', {
      sessionId,
      settings,
      text: 'first',
      attachments: [],
      systemPrompt: 'Internal memory contract'
    })
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      'app-server',
      '--enable',
      'default_mode_request_user_input',
      '--listen',
      'stdio://'
    ])
    expect(sharedChild.requests()).toContainEqual(
      expect.objectContaining({
        method: 'thread/start',
        params: expect.objectContaining({
          developerInstructions: 'Internal memory contract'
        })
      })
    )
    expect(sharedChild.requests()).toContainEqual(
      expect.objectContaining({
        method: 'turn/start',
        params: expect.objectContaining({
          threadId: 'native-1',
          model: 'gpt-5.6-sol',
          input: [{ type: 'text', text: 'first', text_elements: [] }],
          sandboxPolicy: expect.objectContaining({ type: 'workspaceWrite' })
        })
      })
    )
    const eventsBeforeInputEcho = events.length
    sharedChild.emitPayload({
      method: 'item/started',
      params: {
        threadId: 'native-1',
        turnId: 'turn-1',
        item: {
          id: 'input-echo',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Internal memory contract\n\nfirst' }]
        }
      }
    })
    expect(events).toHaveLength(eventsBeforeInputEcho)
    sharedChild.emitPayload({
      id: 'permission-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'native-1',
        turnId: 'turn-1',
        command: 'rm -rf build/cache'
      }
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'permission.asked',
        sessionId,
        permission: expect.objectContaining({
          id: 'permission-1',
          permission: 'command',
          metadata: expect.objectContaining({ command: 'rm -rf build/cache' })
        })
      })
    )
    await driver.replyPermission('/project', 'permission-1', 'once', undefined, sessionId)
    expect(sharedChild.requests()).toContainEqual({
      id: 'permission-1',
      result: { decision: 'accept' }
    })
    sharedChild.emitPayload({
      id: 'question-1',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'native-1',
        turnId: 'turn-1',
        questions: [
          {
            id: 'scope',
            header: 'Scope',
            question: 'Which project should Codex update?',
            options: [{ label: 'Current project', description: 'Continue in this workspace.' }]
          }
        ]
      }
    })
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'question.asked',
        sessionId,
        requestId: 'question-1',
        questions: [
          expect.objectContaining({
            header: 'Scope',
            prompt: 'Which project should Codex update?',
            options: ['Current project']
          })
        ]
      })
    )
    await driver.replyToQuestion('/project', sessionId, 'question-1', [['Current project']])
    expect(sharedChild.requests()).toContainEqual({
      id: 'question-1',
      result: { answers: { scope: { answers: ['Current project'] } } }
    })
    sharedChild.emitPayload({
      method: 'error',
      params: {
        threadId: 'native-1',
        turnId: 'turn-1',
        willRetry: true,
        error: {
          message: 'The response stream disconnected.',
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } }
        }
      }
    })
    expect(events).toContainEqual({
      type: 'session.status',
      sessionId,
      status: {
        state: 'waiting',
        issue: {
          kind: 'network',
          message: 'The Codex connection was interrupted. Codex is retrying automatically.',
          rawError: 'The response stream disconnected.',
          harnessId: 'codex',
          retryable: true,
          statusCode: 502
        }
      }
    })
    sharedChild.emitPayload({
      method: 'item/started',
      params: {
        threadId: 'native-1',
        turnId: 'turn-1',
        item: { id: 'retry-command', type: 'commandExecution', command: 'bun test' }
      }
    })
    expect(events).toContainEqual({
      type: 'session.status',
      sessionId,
      status: { state: 'working' }
    })
    await driver.steerPrompt('/project', {
      sessionId,
      text: 'focus on tests',
      attachments: [],
      userMessageId: 'steer-1'
    })
    expect(sharedChild.requests()).toContainEqual({
      id: 4,
      method: 'turn/steer',
      params: {
        threadId: 'native-1',
        clientUserMessageId: 'steer-1',
        input: [{ type: 'text', text: 'focus on tests', text_elements: [] }],
        expectedTurnId: 'turn-1'
      }
    })
    const workerSessionId = await driver.createSession('/project', 'Worker')
    await driver.sendPrompt('/project', {
      sessionId: workerSessionId,
      settings,
      text: 'work concurrently',
      attachments: []
    })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(sharedChild.requests()).toContainEqual(
      expect.objectContaining({
        method: 'turn/start',
        params: expect.objectContaining({ threadId: 'native-2' })
      })
    )
    sharedChild.emitPayload({
      method: 'turn/completed',
      params: { threadId: 'native-1', turn: { id: 'turn-1', status: 'completed' } }
    })
    sharedChild.emitPayload({
      method: 'error',
      params: {
        threadId: 'native-2',
        turnId: 'turn-2',
        willRetry: false,
        error: {
          message: 'Codex reached the response retry limit.',
          codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 502 } }
        }
      }
    })
    sharedChild.emitPayload({
      method: 'turn/completed',
      params: {
        threadId: 'native-2',
        turn: {
          id: 'turn-2',
          status: 'failed',
          error: { message: 'Codex reached the response retry limit.' }
        }
      }
    })
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: 'session.error',
        sessionId: workerSessionId,
        error: 'Codex reached the response retry limit.'
      })
    })
    await driver.sendPrompt('/project', {
      sessionId,
      settings: { ...settings, permissionLevel: 'full_access' },
      text: 'second',
      attachments: []
    })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(sharedChild.requests()).toContainEqual({
      id: expect.any(Number),
      method: 'thread/resume',
      params: { threadId: 'native-1', developerInstructions: null }
    })
    expect(sharedChild.requests()).toContainEqual(
      expect.objectContaining({
        method: 'turn/start',
        params: expect.objectContaining({
          sandboxPolicy: { type: 'dangerFullAccess' }
        })
      })
    )
  })

  it('surfaces a Codex usage-limit failure as a quota issue with a retry time', async () => {
    // The message embeds a concrete reset time ("try again at …"). Fake the
    // Date clock only (never setTimeout) so the embedded reset time is always
    // in the future regardless of when the suite runs.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 7, 19, 12, 0, 0))
    const driver = new CodexDriver(await storage())
    const events: AgentEvent[] = []
    driver.onEvent((event) => events.push(event))
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const sessionId = await driver.createSession('/project', 'Codex')
    await driver.sendPrompt('/project', { sessionId, settings, text: 'go', attachments: [] })
    child.emitPayload({
      method: 'error',
      params: {
        threadId: 'native-1',
        turnId: 'turn-1',
        willRetry: false,
        error: {
          message:
            "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 20th, 2026 7:30 AM.",
          codexErrorInfo: 'usageLimitExceeded'
        }
      }
    })
    child.emitPayload({
      method: 'turn/completed',
      params: {
        threadId: 'native-1',
        turn: {
          id: 'turn-1',
          status: 'failed',
          error: {
            message:
              "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 20th, 2026 7:30 AM."
          }
        }
      }
    })
    await vi.waitFor(() => {
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session.error',
          sessionId,
          error: expect.stringContaining("You've hit your usage limit"),
          issue: expect.objectContaining({
            kind: 'quota',
            harnessId: 'codex',
            retryable: true
          })
        })
      )
    })
    const errorEvent = events.find(
      (event) => event.type === 'session.error' && event.sessionId === sessionId
    )
    expect(errorEvent && 'issue' in errorEvent ? errorEvent.issue?.retryAt : undefined).toEqual(
      new Date(2026, 7, 20, 7, 30, 0, 0).getTime()
    )
  })

  it('maps Codex tool and assistant items to render events', async () => {
    const driver = new CodexDriver(await storage())
    const events: AgentEvent[] = []
    driver.onEvent((event) => events.push(event))
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const sessionId = await driver.createSession('/project', 'Codex')
    await driver.sendPrompt('/project', { sessionId, settings, text: 'go', attachments: [] })
    child.emitPayload({
      method: 'item/started',
      params: { item: { id: 'cmd-1', type: 'commandExecution', command: 'bun test' } }
    })
    child.emitPayload({
      method: 'item/completed',
      params: {
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: 'bun test',
          status: 'completed',
          exitCode: 0
        }
      }
    })
    child.emitPayload({
      method: 'item/completed',
      params: { item: { id: 'msg-1', type: 'agentMessage', text: 'Done' } }
    })
    child.emitPayload({
      method: 'turn/plan/updated',
      params: {
        threadId: 'native-1',
        turnId: 'turn-1',
        explanation: 'Initial plan',
        plan: [
          { step: 'Inspect the driver', status: 'pending' },
          { step: 'Apply the fix', status: 'pending' }
        ]
      }
    })
    child.emitPayload({
      method: 'turn/plan/updated',
      params: {
        threadId: 'native-1',
        turnId: 'turn-1',
        explanation: 'Implementation plan',
        plan: [
          { step: 'Inspect the driver', status: 'completed' },
          { step: 'Apply the fix', status: 'inProgress' }
        ]
      }
    })
    child.emitPayload({
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed' } }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const messages = await driver.loadMessages('/project', sessionId)
    expect(messages).toEqual([
      expect.objectContaining({ role: 'user' }),
      expect.objectContaining({
        id: `${sessionId}:cmd-1`,
        role: 'assistant',
        parts: [expect.objectContaining({ type: 'tool', tool: 'command_execution' })]
      }),
      expect.objectContaining({ id: `${sessionId}:msg-1`, role: 'assistant' }),
      expect.objectContaining({
        id: `${sessionId}:turn-1:plan`,
        role: 'assistant',
        parts: [
          expect.objectContaining({
            type: 'tool',
            tool: 'plan_update',
            state: expect.objectContaining({
              input: {
                plan: [
                  { step: 'Inspect the driver', status: 'completed' },
                  { step: 'Apply the fix', status: 'inProgress' }
                ]
              }
            })
          })
        ]
      })
    ])
    expect(
      events
        .filter((event) => event.type === 'message.part.updated')
        .filter((event) => event.part.type === 'tool' && event.part.tool === 'plan_update')
        .map((event) => (event.part.type === 'tool' ? event.part.state.input['plan'] : undefined))
    ).toEqual([
      [
        { step: 'Inspect the driver', status: 'pending' },
        { step: 'Apply the fix', status: 'pending' }
      ],
      [
        { step: 'Inspect the driver', status: 'completed' },
        { step: 'Apply the fix', status: 'inProgress' }
      ]
    ])
  })

  it('passes only existing local attachment paths to Codex', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeinoven-codex-image-'))
    roots.push(root)
    const image = join(root, 'image.png')
    await writeFile(image, 'image')
    const driver = new CodexDriver(await storage())
    const firstChild = new FakeChild()
    const secondChild = new FakeChild()
    spawnMock
      .mockReturnValueOnce(firstChild as unknown as ChildProcess)
      .mockReturnValueOnce(secondChild as unknown as ChildProcess)
    const sessionId = await driver.createSession('/project', 'Codex')
    await driver.sendPrompt('/project', {
      sessionId,
      settings,
      text: 'look',
      attachments: [{ mime: 'image/png', url: image }]
    })
    expect(firstChild.requests()).toContainEqual(
      expect.objectContaining({
        method: 'turn/start',
        params: expect.objectContaining({
          input: expect.arrayContaining([{ type: 'localImage', path: image }])
        })
      })
    )
    firstChild.emitPayload({
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed' } }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(
      driver.sendPrompt('/project', {
        sessionId,
        settings,
        text: 'look',
        attachments: [{ mime: 'image/png', url: join(root, 'missing.png') }]
      })
    ).rejects.toThrow('readable local file')
  })
})

describe('Codex token usage normalization', () => {
  it('maps reported categories into normalized usage and preserves the raw total', () => {
    expect(
      mapCodexUsage({
        tokenUsage: {
          last: {
            input_tokens: 100,
            output_tokens: 30,
            reasoning_output_tokens: 10,
            cached_input_tokens: 40,
            cache_write_tokens: 5,
            total_tokens: 130
          },
          model_context_window: 200_000
        }
      })
    ).toEqual({
      aggregateTokens: {
        input: 100,
        output: 30,
        reasoning: 10,
        cacheRead: 40,
        cacheWrite: 5,
        total: 130
      },
      normalizedUsage: {
        uncachedInput: 60,
        cachedInput: 40,
        cacheWrite: 5,
        output: 30,
        reasoning: 10,
        rawProviderUsage: {
          input_tokens: 100,
          output_tokens: 30,
          reasoning_output_tokens: 10,
          cached_input_tokens: 40,
          cache_write_tokens: 5,
          total_tokens: 130
        },
        rawTotal: 130,
        totalSemantics: 'includes_cache'
      },
      contextUsed: 100,
      contextWindow: 200_000
    })
  })

  it('does not synthesize a comparable total when the provider reports none', () => {
    expect(
      mapCodexUsage({
        tokenUsage: {
          last: {
            input_tokens: 100,
            output_tokens: 30,
            cached_input_tokens: 40
          }
        }
      })
    ).toEqual({
      aggregateTokens: undefined,
      normalizedUsage: {
        uncachedInput: 60,
        cachedInput: 40,
        cacheWrite: null,
        output: 30,
        reasoning: null,
        rawProviderUsage: {
          input_tokens: 100,
          output_tokens: 30,
          cached_input_tokens: 40
        },
        rawTotal: null,
        totalSemantics: 'unavailable'
      },
      contextUsed: 100
    })
  })

  it('keeps unreported categories null while preserving a reported total', () => {
    expect(
      mapCodexUsage({
        tokenUsage: {
          last: {
            input_tokens: 50,
            total_tokens: 50
          }
        }
      })
    ).toEqual({
      aggregateTokens: {
        input: 50,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 50
      },
      normalizedUsage: {
        uncachedInput: 50,
        cachedInput: null,
        cacheWrite: null,
        output: null,
        reasoning: null,
        rawProviderUsage: { input_tokens: 50, total_tokens: 50 },
        rawTotal: 50,
        totalSemantics: 'includes_cache'
      },
      contextUsed: 50
    })
  })

  it('attaches no usage metadata when the provider reports no tokens', () => {
    expect(mapCodexUsage({ tokenUsage: { last: {} } })).toBeUndefined()
  })

  it('derives uncached input as input minus cached input', () => {
    expect(
      mapCodexUsage({
        tokenUsage: {
          last: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 20,
            total_tokens: 120
          }
        }
      })
    ).toEqual({
      aggregateTokens: {
        input: 100,
        output: 20,
        reasoning: 0,
        cacheRead: 40,
        cacheWrite: 0,
        total: 120
      },
      normalizedUsage: {
        uncachedInput: 60,
        cachedInput: 40,
        cacheWrite: null,
        output: 20,
        reasoning: null,
        rawProviderUsage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          output_tokens: 20,
          total_tokens: 120
        },
        rawTotal: 120,
        totalSemantics: 'includes_cache'
      },
      contextUsed: 100
    })
  })

  it('clamps uncached input to zero when cached input exceeds provider input', () => {
    expect(
      mapCodexUsage({
        tokenUsage: {
          last: {
            input_tokens: 30,
            cached_input_tokens: 40,
            total_tokens: 30
          }
        }
      })
    ).toEqual({
      aggregateTokens: {
        input: 30,
        output: 0,
        reasoning: 0,
        cacheRead: 40,
        cacheWrite: 0,
        total: 30
      },
      normalizedUsage: {
        uncachedInput: 0,
        cachedInput: 40,
        cacheWrite: null,
        output: null,
        reasoning: null,
        rawProviderUsage: {
          input_tokens: 30,
          cached_input_tokens: 40,
          total_tokens: 30
        },
        rawTotal: 30,
        totalSemantics: 'includes_cache'
      },
      contextUsed: 30
    })
  })

  it('leaves uncached input null when provider input is absent', () => {
    expect(
      mapCodexUsage({
        tokenUsage: {
          last: {
            cached_input_tokens: 40,
            output_tokens: 20,
            total_tokens: 60
          }
        }
      })
    ).toEqual({
      aggregateTokens: {
        input: 0,
        output: 20,
        reasoning: 0,
        cacheRead: 40,
        cacheWrite: 0,
        total: 60
      },
      normalizedUsage: {
        uncachedInput: null,
        cachedInput: 40,
        cacheWrite: null,
        output: 20,
        reasoning: null,
        rawProviderUsage: {
          cached_input_tokens: 40,
          output_tokens: 20,
          total_tokens: 60
        },
        rawTotal: 60,
        totalSemantics: 'includes_cache'
      },
      contextUsed: undefined
    })
  })

  it('reads generic input/output/reasoning aliases alongside camel and snake casing', () => {
    expect(
      mapCodexUsage({
        tokenUsage: {
          last: {
            input: 100,
            output: 30,
            reasoning: 10,
            cached_input_tokens: 40,
            total_tokens: 130
          }
        }
      })
    ).toEqual({
      aggregateTokens: {
        input: 100,
        output: 30,
        reasoning: 10,
        cacheRead: 40,
        cacheWrite: 0,
        total: 130
      },
      normalizedUsage: {
        uncachedInput: 60,
        cachedInput: 40,
        cacheWrite: null,
        output: 30,
        reasoning: 10,
        rawProviderUsage: {
          input: 100,
          output: 30,
          reasoning: 10,
          cached_input_tokens: 40,
          total_tokens: 130
        },
        rawTotal: 130,
        totalSemantics: 'includes_cache'
      },
      contextUsed: 100
    })
  })
})

describe.skipIf(process.platform === 'win32')('mapCodexRateLimits', () => {
  it('maps the backward-compatible single-bucket payload with window minutes', () => {
    const telemetry = mapCodexRateLimits({
      rateLimits: {
        limitId: 'codex',
        planType: 'prolite',
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_779_459_394 },
        secondary: { usedPercent: 18, windowDurationMins: 10_080, resetsAt: 1_779_826_837 }
      }
    })
    expect(telemetry.rateLimits).toHaveLength(2)
    const [primary, secondary] = telemetry.rateLimits
    expect(primary).toMatchObject({
      id: 'codex:codex:primary',
      label: '5-hour limit',
      usedPercent: 25,
      windowMinutes: 300,
      resetsAt: 1_779_459_394_000
    })
    expect(secondary).toMatchObject({
      label: 'Weekly limit',
      usedPercent: 18,
      windowMinutes: 10_080
    })
  })

  it('maps model-specific windows from rateLimitsByLimitId with a model suffix', () => {
    const telemetry = mapCodexRateLimits({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1 }
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1 }
        },
        spark: {
          limitId: 'spark',
          limitName: 'Codex Spark',
          primary: { usedPercent: 8, windowDurationMins: 300, resetsAt: 2 }
        }
      }
    })
    expect(telemetry.rateLimits).toHaveLength(2)
    const spark = telemetry.rateLimits.find((window) => window.id.startsWith('codex:spark'))
    expect(spark).toMatchObject({
      label: 'Codex Spark · 5-hour limit',
      model: 'Codex Spark',
      usedPercent: 8
    })
    const defaultWindow = telemetry.rateLimits.find((window) => window.id.startsWith('codex:codex'))
    expect(defaultWindow?.model).toBeUndefined()
  })

  it('extracts credits balance (decimal string) and plan type', () => {
    const telemetry = mapCodexRateLimits({
      rateLimits: {
        limitId: 'codex',
        planType: 'prolite',
        credits: { hasCredits: true, unlimited: false, balance: '766.76' },
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1 }
      }
    })
    expect(telemetry.credits).toEqual({
      hasCredits: true,
      unlimited: false,
      balance: 766.76,
      planType: 'prolite'
    })
  })

  it('reports unlimited credits without a numeric balance', () => {
    const telemetry = mapCodexRateLimits({
      rateLimits: {
        credits: { hasCredits: true, unlimited: true },
        primary: { usedPercent: 0 }
      }
    })
    expect(telemetry.credits).toEqual({ hasCredits: true, unlimited: true })
  })

  it('loads the native thread before requesting compaction so compact/start finds it', async () => {
    const driver = new CodexDriver(await storage())
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const sessionId = await driver.createSession('/project', 'Codex')
    await driver.sendPrompt('/project', { sessionId, settings, text: 'seed', attachments: [] })

    const compaction = driver.compactSession('/project', sessionId, settings)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const requests = child.requests()
    const resumeIndex = requests.findIndex((request) => request.method === 'thread/resume')
    const compactIndex = requests.findIndex((request) => request.method === 'thread/compact/start')
    expect(resumeIndex).toBeGreaterThanOrEqual(0)
    expect(compactIndex).toBeGreaterThanOrEqual(0)
    expect(resumeIndex).toBeLessThan(compactIndex)
    expect(requests[resumeIndex]).toEqual(
      expect.objectContaining({
        method: 'thread/resume',
        params: {
          threadId: 'native-1',
          developerInstructions: null
        }
      })
    )

    child.emitPayload({
      method: 'turn/completed',
      params: {
        threadId: 'native-1',
        turn: { id: 'compact-turn-1', status: 'completed' }
      }
    })
    await expect(compaction).resolves.toBeUndefined()
    child.emit('exit', 0, null)
  })

  it('surfaces the underlying codex error when a compaction turn fails', async () => {
    const driver = new CodexDriver(await storage())
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const sessionId = await driver.createSession('/project', 'Codex')
    await driver.sendPrompt('/project', { sessionId, settings, text: 'seed', attachments: [] })

    const compaction = driver.compactSession('/project', sessionId, settings)
    await new Promise((resolve) => setTimeout(resolve, 0))

    child.emitPayload({
      method: 'turn/completed',
      params: {
        threadId: 'native-1',
        turn: {
          id: 'compact-turn-1',
          status: 'failed',
          error: {
            message: 'Codex ran out of room in the model context window.'
          }
        }
      }
    })
    await expect(compaction).rejects.toThrow(
      'Codex compaction failed: Codex ran out of room in the model context window.'
    )
    child.emit('exit', 0, null)
  })
})

describe.skipIf(process.platform === 'win32')('CodexDriver readAccountUsage', () => {
  it('fetches account quota on demand via account/rateLimits/read', async () => {
    const child = new FakeChild()
    child.stdin.write.mockImplementation((value: string) => {
      const payload = JSON.parse(value) as Record<string, unknown>
      const id = typeof payload['id'] === 'number' ? payload['id'] : undefined
      const method = typeof payload['method'] === 'string' ? payload['method'] : undefined
      if (id === 1) {
        child.emitPayload({ id, result: { userAgent: 'probe' } })
        return true
      }
      if (id === 2 && method === 'account/rateLimits/read') {
        child.emitPayload({
          id,
          result: {
            rateLimits: {
              limitId: 'codex',
              primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_779_459_394 },
              credits: { hasCredits: true, unlimited: false, balance: '766.76' },
              planType: 'prolite'
            },
            rateLimitsByLimitId: {
              codex: {
                primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_779_459_394 },
                credits: { hasCredits: true, unlimited: false, balance: '766.76' },
                planType: 'prolite'
              },
              spark: {
                limitId: 'spark',
                limitName: 'GPT-5.3-Codex-Spark',
                primary: { usedPercent: 8, windowDurationMins: 300, resetsAt: 1_779_459_394 }
              }
            }
          }
        })
        return true
      }
      return true
    })
    spawnMock.mockReturnValueOnce(child as unknown as ChildProcess)
    const driver = new CodexDriver(await storage())
    const telemetry = await driver.readAccountUsage('/project')
    expect(telemetry?.rateLimits.length).toBeGreaterThan(0)
    const spark = telemetry?.rateLimits.find((window) => window.id.startsWith('codex:spark'))
    expect(spark).toMatchObject({
      label: 'GPT-5.3-Codex-Spark · 5-hour limit',
      usedPercent: 8
    })
    expect(telemetry?.credits).toEqual({
      hasCredits: true,
      unlimited: false,
      balance: 766.76,
      planType: 'prolite'
    })
  })
})
