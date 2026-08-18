import { EventEmitter } from 'events'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import type { AgentEvent } from '../../../src/lib/types'
import { StorageEngine } from '../../../src/main/storage/storage-engine'
import { ClaudeCodeDriver, mapClaudeCodeRecord } from '../../../src/main/drivers/claude-code-driver'
import type {
  CliLineParseContext,
  CliLineParseResult
} from '../../../src/main/drivers/persistent-cli-driver'

const spawnMock = vi.hoisted(() => vi.fn())
const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({ spawn: spawnMock, execFile: execFileMock }))
// Default: resolve the pre-flight `claude auth status` probe as authenticated so
// existing sendPrompt tests exercise the real turn path unchanged.
execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback) =>
  callback(null, JSON.stringify({ loggedIn: true }))
)

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  authConfirmed = false
  stdin = {
    write: vi.fn((_input: unknown) => {
      // Model the real CLI: the first stream record (message_start) proves
      // authentication, releasing the credential-refresh gate immediately.
      if (!this.authConfirmed) {
        this.authConfirmed = true
        this.stdout.emit(
          'data',
          Buffer.from('{"type":"stream_event","event":{"type":"message_start"}}\n')
        )
      }
    }),
    end: vi.fn()
  }
  killed = false

  kill(): boolean {
    this.killed = true
    this.emit('exit', null, 'SIGTERM')
    return true
  }
}

const roots: string[] = []
afterEach(async () => {
  spawnMock.mockReset()
  execFileMock.mockReset()
  execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback) =>
    callback(null, JSON.stringify({ loggedIn: true }))
  )
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function storage(): Promise<StorageEngine> {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-claude-driver-'))
  roots.push(root)
  const instance = new StorageEngine(root)
  await instance.initialize()
  return instance
}

describe('ClaudeCodeDriver', () => {
  it('uses realtime stream-json input, steers, and persists the native session', async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const driver = new ClaudeCodeDriver(await storage())
    const sessionId = await driver.createSession('/project', 'Claude thread')
    await driver.sendPrompt('/project', {
      sessionId,
      text: 'Read the project',
      attachments: [],
      allowedTools: ['question', 'read'],
      settings: {
        harnessId: 'claude-code',
        providerId: 'anthropic',
        modelId: 'sonnet',
        thinkingLevel: 'medium',
        permissionLevel: 'auto_review',
        engineeringMode: false
      }
    })
    expect(spawnMock).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining([
        '-p',
        '--output-format',
        'stream-json',
        '--input-format',
        'stream-json',
        '--permission-prompt-tool',
        'stdio',
        '--verbose',
        '--include-partial-messages',
        '--model',
        'sonnet',
        '--tools',
        'AskUserQuestion,Read',
        '--permission-mode',
        'manual'
      ]),
      expect.objectContaining({
        env: expect.objectContaining({
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
          CLAUDE_CODE_ENABLE_TODO_TOOLS: '1'
        })
      })
    )
    expect(child.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Read the project' },
        parent_tool_use_id: null
      })}\n`
    )
    expect(child.stdin.end).not.toHaveBeenCalled()
    await driver.steerPrompt('/project', {
      sessionId,
      text: 'Focus on the renderer',
      attachments: [],
      userMessageId: 'steer-1'
    })
    expect(child.stdin.write).toHaveBeenLastCalledWith(
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Focus on the renderer' },
        parent_tool_use_id: null,
        priority: 'now'
      })}\n`
    )
    child.stdout.emit(
      'data',
      Buffer.from(
        '{"type":"system","subtype":"init","session_id":"native-1"}\n{"type":"result","subtype":"success","session_id":"native-1"}\n'
      )
    )
    expect(child.stdin.end).toHaveBeenCalledOnce()
    child.emit('exit', 0, null)
    const next = new FakeChild()
    spawnMock.mockReturnValue(next as unknown as ChildProcess)
    await driver.sendPrompt('/project', {
      sessionId,
      text: 'Continue',
      attachments: [],
      settings: {
        harnessId: 'claude-code',
        providerId: 'anthropic',
        modelId: 'sonnet',
        thinkingLevel: 'medium',
        permissionLevel: 'auto_review',
        engineeringMode: false
      }
    })
    expect(spawnMock).toHaveBeenLastCalledWith(
      'claude',
      expect.arrayContaining(['--resume', 'native-1', '--permission-mode', 'manual']),
      expect.any(Object)
    )
    next.emit('exit', 0, null)
  })

  it('does not serialize unrelated Claude process startup', async () => {
    const mainChild = new FakeChild()
    const titleChild = new FakeChild()
    spawnMock
      .mockReturnValueOnce(mainChild as unknown as ChildProcess)
      .mockReturnValueOnce(titleChild as unknown as ChildProcess)
    const driver = new ClaudeCodeDriver(await storage())
    const mainSessionId = await driver.createSession('/project', 'Main thread')
    const titleSessionId = await driver.createSession('/project', 'Thread title')
    const settings = {
      harnessId: 'claude-code',
      providerId: 'anthropic',
      modelId: 'haiku',
      thinkingLevel: 'minimal',
      permissionLevel: 'auto_review',
      engineeringMode: false
    } as const

    await driver.sendPrompt('/project', {
      sessionId: mainSessionId,
      text: 'Main request',
      attachments: [],
      settings
    })
    const titleStart = driver.sendPrompt('/project', {
      sessionId: titleSessionId,
      text: 'Generate title',
      attachments: [],
      settings
    })

    await titleStart
    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(mainChild.killed).toBe(false)
    mainChild.emit('exit', 0, null)
    titleChild.emit('exit', 0, null)
  })

  it('maps tool use, results, and quota failures into events', async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const driver = new ClaudeCodeDriver(await storage())
    const events: AgentEvent[] = []
    driver.onEvent((event) => events.push(event))
    const sessionId = await driver.createSession('/project', 'Claude thread')
    await driver.sendPrompt('/project', {
      sessionId,
      text: 'Run tests',
      attachments: [],
      settings: {
        harnessId: 'claude-code',
        providerId: 'anthropic',
        modelId: '',
        thinkingLevel: 'low',
        permissionLevel: 'auto_review',
        engineeringMode: false
      }
    })
    child.stdout.emit(
      'data',
      Buffer.from(
        '{"type":"assistant","session_id":"native-1","message":{"id":"assistant-1","content":[{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"bun run test"}}]}}\n{"type":"user","session_id":"native-1","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"ok"}]}}\n{"type":"result","subtype":"error_during_execution","result":"You\'ve hit your session limit · resets 3:40pm (Africa/Lagos)","session_id":"native-1"}\n'
      )
    )
    child.emit('exit', 1, null)
    expect(events.map((event) => event.type)).toContain('message.part.updated')
    expect(events.map((event) => event.type)).toContain('message.completed')
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'message.completed',
        issue: expect.objectContaining({ kind: 'quota', retryAt: expect.any(Number) })
      })
    )
    expect(
      events.some(
        (event) => event.type === 'session.error' && event.error?.includes('process exited')
      )
    ).toBe(false)
  })

  it('maps Claude authentication_failed metadata to a structured authentication issue', () => {
    const result = mapClaudeCodeRecord(
      {
        type: 'assistant',
        error: 'authentication_failed',
        session_id: 'native-auth',
        message: {
          id: 'assistant-auth',
          content: [{ type: 'text', text: 'Provider-supplied failure text' }]
        }
      },
      {
        sessionId: 'title-session',
        session: {
          id: 'title-session',
          title: 'Thread title',
          projectPathHash: 'hash',
          messages: [],
          createdAt: 1,
          updatedAt: 1
        }
      }
    )

    expect(result?.events).toContainEqual(
      expect.objectContaining({
        type: 'message.completed',
        issue: expect.objectContaining({ kind: 'authentication' })
      })
    )
  })

  it('streams supported prompt attachments as Claude content blocks', async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const root = await mkdtemp(join(tmpdir(), 'codeinoven-claude-attachment-'))
    roots.push(root)
    const image = join(root, 'a.png')
    await writeFile(image, Buffer.from('image-bytes'))
    const driver = new ClaudeCodeDriver(await storage())
    const sessionId = await driver.createSession('/project', 'Claude thread')
    await driver.sendPrompt('/project', {
      sessionId,
      text: 'Inspect this',
      attachments: [{ mime: 'image/png', url: image, filename: 'a.png' }],
      settings: {
        harnessId: 'claude-code',
        providerId: 'anthropic',
        modelId: '',
        thinkingLevel: 'low',
        permissionLevel: 'auto_review',
        engineeringMode: false
      }
    })
    expect(child.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect this' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: Buffer.from('image-bytes').toString('base64')
              }
            }
          ]
        },
        parent_tool_use_id: null
      })}\n`
    )
    child.emit('exit', 0, null)
  })

  it('surfaces current Claude task tools so the shared todo UI can aggregate them', async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const driver = new ClaudeCodeDriver(await storage())
    const events: AgentEvent[] = []
    driver.onEvent((event) => events.push(event))
    const sessionId = await driver.createSession('/project', 'Claude thread')
    await driver.sendPrompt('/project', {
      sessionId,
      text: 'Plan the work',
      attachments: [],
      settings: {
        harnessId: 'claude-code',
        providerId: 'anthropic',
        modelId: '',
        thinkingLevel: 'low',
        permissionLevel: 'auto_review',
        engineeringMode: false
      }
    })
    child.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          type: 'assistant',
          session_id: 'native-1',
          message: {
            id: 'assistant-1',
            content: [
              {
                type: 'tool_use',
                id: 'tool-task-1',
                name: 'TaskCreate',
                input: {
                  subject: 'Wire UI',
                  description: 'Connect the shared todo card.',
                  activeForm: 'Wiring UI'
                }
              }
            ]
          }
        })}\n`
      )
    )
    const part = events
      .filter((event) => event.type === 'message.part.updated')
      .map((event) => event.part)
      .find((candidate) => candidate.type === 'tool' && candidate.tool === 'TaskCreate')
    expect(part).toBeDefined()
    child.emit('exit', 0, null)
  })

  it('surfaces a native can_use_tool control_request as permission.asked and replies correctly', async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const driver = new ClaudeCodeDriver(await storage())
    const events: AgentEvent[] = []
    driver.onEvent((event) => events.push(event))
    const sessionId = await driver.createSession('/project', 'Claude thread')
    await driver.sendPrompt('/project', {
      sessionId,
      text: 'Delete a file',
      attachments: [],
      settings: {
        harnessId: 'claude-code',
        providerId: 'anthropic',
        modelId: '',
        thinkingLevel: 'low',
        permissionLevel: 'auto_review',
        engineeringMode: false
      }
    })
    child.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          type: 'control_request',
          request_id: 'perm-1',
          session_id: 'native-1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'rm file.txt' }
          }
        })}\n`
      )
    )
    const permissionEvent = events.find((event) => event.type === 'permission.asked')
    expect(permissionEvent).toBeDefined()
    if (!permissionEvent || permissionEvent.type !== 'permission.asked')
      throw new Error('unreachable')
    expect(permissionEvent.permission.permission).toBe('Bash')

    await driver.replyPermission(
      '/project',
      permissionEvent.permission.id,
      'once',
      undefined,
      sessionId
    )
    const lastWrite = child.stdin.write.mock.calls.at(-1)?.[0] as string
    expect(lastWrite).toBeDefined()
    const parsed = JSON.parse(lastWrite)
    expect(parsed.type).toBe('control_response')
    expect(parsed.response.request_id).toBe('perm-1')
    expect(parsed.response.response.behavior).toBe('allow')
    expect(parsed.response.response.updatedInput).toEqual({ command: 'rm file.txt' })

    child.emit('exit', 0, null)
  })

  it('carries a "provide alternative" reply as a deny + message on the live process, without killing it', async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const driver = new ClaudeCodeDriver(await storage())
    const events: AgentEvent[] = []
    driver.onEvent((event) => events.push(event))
    const sessionId = await driver.createSession('/project', 'Claude thread')
    await driver.sendPrompt('/project', {
      sessionId,
      text: 'Delete a file',
      attachments: [],
      settings: {
        harnessId: 'claude-code',
        providerId: 'anthropic',
        modelId: '',
        thinkingLevel: 'low',
        permissionLevel: 'auto_review',
        engineeringMode: false
      }
    })
    child.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          type: 'control_request',
          request_id: 'perm-2',
          session_id: 'native-1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'rm file.txt' }
          }
        })}\n`
      )
    )
    const permissionEvent = events.find((event) => event.type === 'permission.asked')
    expect(permissionEvent).toBeDefined()
    if (!permissionEvent || permissionEvent.type !== 'permission.asked')
      throw new Error('unreachable')

    // Mirrors ChatEngine.replyPermission: an alternative always resolves as 'reject'
    // and carries the user's instruction as the SDK's canUseTool `message` field, so
    // Claude denies the tool call but keeps streaming the same turn (see
    // src/main/chat/chat-engine.ts:6887-6900) instead of the process being killed.
    await driver.replyPermission(
      '/project',
      permissionEvent.permission.id,
      'reject',
      'Use the archive folder instead of deleting the file.',
      sessionId
    )
    const lastWrite = child.stdin.write.mock.calls.at(-1)?.[0] as string
    expect(lastWrite).toBeDefined()
    const parsed = JSON.parse(lastWrite)
    expect(parsed.type).toBe('control_response')
    expect(parsed.response.request_id).toBe('perm-2')
    expect(parsed.response.response.behavior).toBe('deny')
    expect(parsed.response.response.message).toBe(
      'Use the archive folder instead of deleting the file.'
    )
    // The process must still be alive: this is a continuation, not an abort.
    expect(child.killed).toBe(false)

    child.emit('exit', 0, null)
  })

  it('waits for complete AskUserQuestion input and upgrades its native reply transport', async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const driver = new ClaudeCodeDriver(await storage())
    const events: AgentEvent[] = []
    driver.onEvent((event) => events.push(event))
    const sessionId = await driver.createSession('/project', 'Claude thread')
    await driver.sendPrompt('/project', {
      sessionId,
      text: 'Pick an approach',
      attachments: [],
      settings: {
        harnessId: 'claude-code',
        providerId: 'anthropic',
        modelId: '',
        thinkingLevel: 'low',
        permissionLevel: 'auto_review',
        engineeringMode: false
      }
    })
    child.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          type: 'stream_event',
          session_id: 'native-1',
          event: {
            type: 'message_start',
            message: { id: 'assistant-1', content: [] }
          }
        })}\n${JSON.stringify({
          type: 'stream_event',
          session_id: 'native-1',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'tool-question-1',
              name: 'AskUserQuestion',
              input: {}
            }
          }
        })}\n`
      )
    )
    expect(events.some((event) => event.type === 'question.asked')).toBe(false)

    child.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          type: 'assistant',
          session_id: 'native-1',
          message: {
            id: 'assistant-1',
            content: [
              {
                type: 'tool_use',
                id: 'tool-question-1',
                name: 'AskUserQuestion',
                input: {
                  questions: [{ question: 'Which approach?', options: ['A', 'B'] }]
                }
              }
            ]
          }
        })}\n`
      )
    )
    const questionEvent = events.find((event) => event.type === 'question.asked')
    expect(questionEvent).toBeDefined()
    if (!questionEvent || questionEvent.type !== 'question.asked') throw new Error('unreachable')
    expect(questionEvent.questions[0]?.prompt).toBe('Which approach?')

    child.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          type: 'control_request',
          request_id: 'question-1',
          session_id: 'native-1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'AskUserQuestion',
            input: {
              questions: [{ question: 'Which approach?', options: ['A', 'B'] }]
            }
          }
        })}\n`
      )
    )
    const questionEvents = events.filter((event) => event.type === 'question.asked')
    expect(questionEvents).toHaveLength(2)
    expect(questionEvents[1]?.requestId).toBe(questionEvent.requestId)

    await driver.replyToQuestion('/project', sessionId, questionEvent.requestId, [['A']])
    const lastWrite = child.stdin.write.mock.calls.at(-1)?.[0] as string
    expect(lastWrite).toBeDefined()
    const parsed = JSON.parse(lastWrite)
    expect(parsed.type).toBe('control_response')
    expect(parsed.response.request_id).toBe('question-1')
    expect(parsed.response.response).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Which approach?': 'A' } }
    })

    child.emit('exit', 0, null)
  })
})

describe('mapClaudeCodeRecord rate limits', () => {
  const context: CliLineParseContext = {
    sessionId: 'sess-1',
    session: {
      id: 'sess-1',
      title: 'Test',
      projectPathHash: 'hash',
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          parts: [],
          createdAt: 1,
          harnessId: 'claude-code'
        }
      ],
      createdAt: 1,
      updatedAt: 1
    }
  }

  it('maps five_hour / seven_day windows to friendly labels with window minutes', () => {
    const result = mapClaudeCodeRecord(
      {
        type: 'rate_limit_event',
        session_id: 'native-1',
        rate_limit_info: {
          five_hour: {
            status: 'allowed',
            used_percentage: 37,
            resets_at: 1_786_089_600,
            window_duration_mins: 300
          },
          seven_day: {
            status: 'allowed',
            used_percentage: 64,
            resets_at: 1_786_507_200,
            window_duration_mins: 10_080
          }
        }
      },
      context
    )
    const usage = result?.events?.find((event) => event.type === 'usage.updated')
    const rateLimits = usage && 'rateLimits' in usage ? usage.rateLimits : undefined
    expect(rateLimits).toHaveLength(2)
    const fiveHour = rateLimits?.find((limit) => limit.id === 'five_hour')
    const weekly = rateLimits?.find((limit) => limit.id === 'seven_day')
    expect(fiveHour).toMatchObject({
      label: '5-hour limit',
      usedPercent: 37,
      windowMinutes: 300,
      resetsAt: 1_786_089_600_000
    })
    expect(weekly).toMatchObject({
      label: 'Weekly limit',
      usedPercent: 64,
      windowMinutes: 10_080
    })
  })

  it('converts fractional utilization to a percentage', () => {
    const result = mapClaudeCodeRecord(
      {
        type: 'rate_limit_event',
        session_id: 'native-1',
        rate_limit_info: {
          five_hour: { status: 'allowed', utilization: 0.21 }
        }
      },
      context
    )
    const usage = result?.events?.find((event) => event.type === 'usage.updated')
    const rateLimits = usage && 'rateLimits' in usage ? usage.rateLimits : undefined
    expect(rateLimits?.[0]).toMatchObject({ label: '5-hour limit', usedPercent: 21 })
  })
})

describe('mapClaudeCodeRecord api_retry', () => {
  const context: CliLineParseContext = {
    sessionId: 'sess-retry',
    session: {
      id: 'sess-retry',
      title: 'Retry',
      projectPathHash: 'hash',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }
  }

  function retryEvent(overrides: Record<string, unknown> = {}): CliLineParseResult | null {
    return mapClaudeCodeRecord(
      {
        type: 'system',
        subtype: 'api_retry',
        session_id: 'native-retry',
        attempt: 1,
        max_retries: 4,
        retry_delay_ms: 8_000,
        error_status: 529,
        error: 'overloaded',
        ...overrides
      },
      context
    )
  }

  function waitingIssue(result: CliLineParseResult | null) {
    const event = result?.events?.[0]
    if (event?.type !== 'session.status') return undefined
    const { status } = event
    return status.state === 'waiting' ? status.issue : undefined
  }

  it('labels overloaded server retries as provider_unavailable, not a usage limit', () => {
    const issue = waitingIssue(retryEvent())
    expect(issue).toMatchObject({
      kind: 'provider_unavailable',
      harnessId: 'claude-code',
      retryable: true,
      statusCode: 529
    })
    expect(issue?.retryAt).toBeGreaterThan(Date.now())
  })

  it('labels 429 rate-limit retries as rate_limit with a retry time', () => {
    const issue = waitingIssue(
      retryEvent({ error: 'rate_limit', error_status: 429, retry_delay_ms: 15_000 })
    )
    expect(issue?.kind).toBe('rate_limit')
    expect(issue?.statusCode).toBe(429)
    expect(issue?.retryAt).toBeGreaterThan(Date.now())
  })

  it('labels connection retries (null error_status) as network', () => {
    const issue = waitingIssue(retryEvent({ error: 'unknown', error_status: null }))
    expect(issue?.kind).toBe('network')
    expect(issue?.statusCode).toBeUndefined()
  })

  it('omits retryAt when the retry is immediate', () => {
    const issue = waitingIssue(retryEvent({ retry_delay_ms: 0 }))
    expect(issue?.kind).toBe('provider_unavailable')
    expect(issue?.retryAt).toBeUndefined()
  })
})

describe('ClaudeCodeDriver readAccountUsage', () => {
  it('maps the get_usage control response to rate-limit windows', async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const driver = new ClaudeCodeDriver(await storage())
    const promise = driver.readAccountUsage('/project')
    await vi.waitFor(() =>
      expect(spawnMock).toHaveBeenCalledWith(
        'claude',
        ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'],
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'ignore'] })
      )
    )
    const written = child.stdin.write.mock.calls.map(([value]) => JSON.parse(value as string))
    expect(written[0]).toMatchObject({
      type: 'control_request',
      request: { subtype: 'get_usage' }
    })
    child.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: 'usage',
            response: {
              subscription_type: 'pro',
              rate_limits_available: true,
              rate_limits: {
                five_hour: { utilization: 26, resets_at: '2026-08-07T16:00:00+00:00' },
                seven_day: { utilization: 29, resets_at: '2026-08-07T14:59:59+00:00' },
                extra_usage: { is_enabled: false, utilization: null },
                limits: [{ kind: 'session', percent: 100 }],
                spend: { percent: 0, enabled: false },
                member_dashboard_available: false
              }
            }
          }
        })}\n`
      )
    )
    child.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: 'context',
            response: { maxTokens: 967000, totalTokens: 21401, model: 'claude-sonnet-5' }
          }
        })}\n`
      )
    )
    const telemetry = await promise
    expect(telemetry?.rateLimits).toHaveLength(2)
    const fiveHour = telemetry?.rateLimits.find((limit) => limit.id === 'five_hour')
    expect(fiveHour).toMatchObject({ label: '5-hour limit', usedPercent: 26 })
    // Account-state keys with no window utilization/reset must be dropped.
    expect(telemetry?.rateLimits.map((limit) => limit.id)).not.toContain('extra_usage')
    expect(telemetry?.rateLimits.map((limit) => limit.id)).not.toContain('limits')
    expect(telemetry?.rateLimits.map((limit) => limit.id)).not.toContain('spend')
    // The get_context_usage control supplies the live context window.
    expect(telemetry?.contextWindow).toBe(967000)
    expect(telemetry?.contextUsed).toBe(21401)
  })

  it('returns null when plan rate limits are unavailable', async () => {
    const child = new FakeChild()
    spawnMock.mockReturnValue(child as unknown as ChildProcess)
    const driver = new ClaudeCodeDriver(await storage())
    const promise = driver.readAccountUsage('/project')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: 'usage',
            response: { rate_limits_available: false, rate_limits: null }
          }
        })}\n`
      )
    )
    await expect(promise).resolves.toBeNull()
  })
})
