/**
 * Integration test for the Pi session host core (phase 1 of the resource
 * optimization workstream, `.cio/work/pi-session-host/plan.md`).
 *
 * A local OpenAI-compatible SSE server stands in for the model and echoes a
 * per-session marker, so content bleed-through between sessions would be
 * visible. Two sessions share one host process: created, prompted
 * concurrently, read back, and one disposed. No credentials, no network.
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import { runSessionHost } from '../../../src/main/drivers/pi/session-host/run'
import type { SessionHostRuntime } from '../../../src/main/drivers/pi/session-host/run'
import type {
  HostCommand,
  HostEventEnvelope,
  HostResponseEnvelope
} from '../../../src/main/drivers/pi/session-host/protocol'

const RESPONSE_TIMEOUT_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function isEventType(event: unknown, type: string): boolean {
  return isRecord(event) && stringOf(event, 'type') === type
}

/** Assistant text of a `get_messages` payload, without a single type cast. */
function assistantText(payload: unknown): string {
  if (!Array.isArray(payload)) return ''
  const chunks: string[] = []
  for (const message of payload) {
    if (!isRecord(message) || message['role'] !== 'assistant') continue
    const content = message['content']
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (isRecord(part) && part['type'] === 'text') {
        const text = stringOf(part, 'text')
        if (text !== undefined) chunks.push(text)
      }
    }
  }
  return chunks.join('\n')
}

/** Data of a successful response, throwing on an error response. */
function responseData(response: HostResponseEnvelope): unknown {
  if (!response.ok) throw new Error(`host request failed: ${response.error}`)
  return response.data
}

class HostTestClient {
  private buffer = ''
  private readonly lines: unknown[] = []

  constructor(
    private readonly input: PassThrough,
    output: PassThrough
  ) {
    output.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString()
      const parts = this.buffer.split('\n')
      this.buffer = parts.pop() ?? ''
      for (const part of parts) {
        const trimmed = part.trim()
        if (trimmed.length > 0) this.lines.push(JSON.parse(trimmed) as unknown)
      }
    })
  }

  send(id: string, sessionId: string | undefined, command: HostCommand): void {
    this.input.write(
      `${JSON.stringify({
        type: 'request',
        id,
        ...(sessionId === undefined ? {} : { sessionId }),
        command
      })}\n`
    )
  }

  async response(id: string): Promise<HostResponseEnvelope> {
    return this.waitFor(
      (line): line is HostResponseEnvelope =>
        isRecord(line) && stringOf(line, 'type') === 'response' && stringOf(line, 'id') === id
    )
  }

  async event(sessionId: string, eventType: string): Promise<HostEventEnvelope> {
    return this.waitFor(
      (line): line is HostEventEnvelope =>
        isRecord(line) &&
        stringOf(line, 'type') === 'event' &&
        stringOf(line, 'sessionId') === sessionId &&
        isEventType(line['event'], eventType),
      RESPONSE_TIMEOUT_MS
    )
  }

  private async waitFor<T>(
    predicate: (line: unknown) => line is T,
    timeoutMs = RESPONSE_TIMEOUT_MS
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.lines.find(predicate)
      if (found !== undefined) return found
      if (Date.now() >= deadline) throw new Error('timed out waiting for a host line')
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    }
  }
}

interface FakeProvider {
  server: Server
  baseUrl: string
}

function createFakeProvider(): Promise<FakeProvider> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString()
      })
      request.on('end', () => {
        const match = body.match(/MARKER-([A-Z])/u)
        const marker = match ? `M${match[1]}` : 'M?'
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        const write = (payload: unknown): void => {
          response.write(`data: ${JSON.stringify(payload)}\n\n`)
        }
        let step = 0
        const tick = (): void => {
          if (step >= 20) {
            write({
              id: 'probe',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'probe-1',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 20, total_tokens: 21 }
            })
            response.write('data: [DONE]\n\n')
            response.end()
            return
          }
          step += 1
          write({
            id: 'probe',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'probe-1',
            choices: [
              {
                index: 0,
                delta: {
                  ...(step === 1 ? { role: 'assistant' } : {}),
                  content: `${marker}-${step} `
                },
                finish_reason: null
              }
            ]
          })
          setTimeout(tick, 2)
        }
        tick()
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error('fake provider did not bind a TCP port')
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/v1` })
    })
  })
}

/** A providers extension in the same shape the app generates per session. */
function providersSource(baseUrl: string): string {
  return `export default function probeProviders(pi) {
  pi.registerProvider('probe', {
    name: 'Probe Provider',
    baseUrl: ${JSON.stringify(baseUrl)},
    apiKey: 'local',
    api: 'openai-completions',
    models: [
      {
        id: 'probe-1',
        name: 'Probe Model',
        reasoning: false,
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }
    ]
  })
}
`
}

describe('Pi session host core', () => {
  const scratch = join(process.cwd(), '.cio', 'tmp', 'session-host-test')
  let server: Server | null = null
  let runtime: SessionHostRuntime | null = null

  afterAll(async () => {
    runtime?.host.dispose()
    runtime?.stop()
    if (server !== null) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()))
      })
    }
    rmSync(scratch, { recursive: true, force: true })
  })

  it('hosts two sessions with isolated turns and disposes one', async () => {
    const fake = await createFakeProvider()
    server = fake.server
    rmSync(scratch, { recursive: true, force: true })
    const projectDir = join(scratch, 'project')
    const agentDir = join(scratch, 'agent')
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(agentDir, { recursive: true })
    const providersPath = join(scratch, 'providers.ts')
    writeFileSync(providersPath, providersSource(fake.baseUrl))

    const input = new PassThrough()
    const output = new PassThrough()
    runtime = runSessionHost(input, output)
    const client = new HostTestClient(input, output)

    client.send('create-a', 'session-a', {
      type: 'create_session',
      cwd: projectDir,
      agentDir,
      extensionPaths: [providersPath],
      model: { provider: 'probe', id: 'probe-1' }
    })
    client.send('create-b', 'session-b', {
      type: 'create_session',
      cwd: projectDir,
      agentDir,
      extensionPaths: [providersPath],
      model: { provider: 'probe', id: 'probe-1' }
    })
    const createdA = await client.response('create-a')
    const createdB = await client.response('create-b')
    expect(createdA.ok).toBe(true)
    expect(createdB.ok).toBe(true)
    expect(responseData(createdA)).not.toEqual(responseData(createdB))

    client.send('list', undefined, { type: 'list_sessions' })
    const listed = await client.response('list')
    const entries = responseData(listed)
    expect(Array.isArray(entries)).toBe(true)
    expect(Array.isArray(entries) ? entries.length : 0).toBe(2)

    client.send('prompt-a', 'session-a', {
      type: 'prompt',
      message: 'Answer with MARKER-A only.'
    })
    client.send('prompt-b', 'session-b', {
      type: 'prompt',
      message: 'Answer with MARKER-B only.'
    })
    const promptA = await client.response('prompt-a')
    const promptB = await client.response('prompt-b')
    expect(promptA.ok).toBe(true)
    expect(promptB.ok).toBe(true)

    await client.event('session-a', 'agent_end')
    await client.event('session-b', 'agent_end')

    client.send('messages-a', 'session-a', { type: 'get_messages' })
    client.send('messages-b', 'session-b', { type: 'get_messages' })
    const messagesA = await client.response('messages-a')
    const messagesB = await client.response('messages-b')
    const textA = assistantText(responseData(messagesA))
    const textB = assistantText(responseData(messagesB))
    expect(textA).toContain('MA-20')
    expect(textA).not.toContain('MB-')
    expect(textB).toContain('MB-20')
    expect(textB).not.toContain('MA-')

    client.send('state-a', 'session-a', { type: 'get_state' })
    const stateA = await client.response('state-a')
    const state = responseData(stateA)
    expect(isRecord(state) && stringOf(state, 'sessionId') === 'session-a').toBe(true)
    expect(isRecord(state) && state['isStreaming'] === false).toBe(true)

    client.send('dispose-a', 'session-a', { type: 'dispose_session' })
    const disposed = await client.response('dispose-a')
    expect(disposed.ok).toBe(true)
    client.send('state-a-again', 'session-a', { type: 'get_state' })
    const stateAfterDispose = await client.response('state-a-again')
    expect(stateAfterDispose.ok).toBe(false)
    client.send('list-again', undefined, { type: 'list_sessions' })
    const listedAgain = await client.response('list-again')
    const remaining = responseData(listedAgain)
    expect(Array.isArray(remaining) ? remaining.length : 0).toBe(1)
  }, 60_000)
})
