/**
 * The RPC transport seam: the same `PiRpcClient` speaks to a local child through
 * `localRpcTransport` and to any other peer through an injected one.
 *
 * The last test spawns a real `#!/bin/sh` script as the local child, so the
 * default path (spawn, frame, parse, report the exit) is covered end to end.
 * Everything else is in memory: no network, no SSH, no `pi` install.
 */
import { ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import type { PreparedHarnessInvocation } from '../../../src/main/drivers/harness-runtime'
import { PiRpcClient } from '../../../src/main/drivers/pi-rpc-client'
import { localRpcTransport, type RpcTransport } from '../../../src/main/drivers/pi-rpc-transport'

/** A child with the surface the transport uses, driven by the test instead of a process. */
class FakeChild extends ChildProcess {
  override readonly stdin = new PassThrough()
  override readonly stdout = new PassThrough()
  override readonly stderr = new PassThrough()
  override killed = false
  override exitCode: number | null = null
  override signalCode: NodeJS.Signals | null = null
  override pid = 4321
  override spawnargs: string[] = []
  override spawnfile = 'fake-pi'
  killCalls = 0

  override kill(): boolean {
    this.killCalls += 1
    this.killed = true
    return true
  }
}

const tick = (ms = 0): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Wait for something a callback reports, without guessing a fixed delay. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the peer')
    await tick(10)
  }
}

function invocation(command: string, env: NodeJS.ProcessEnv = { ...process.env }) {
  const prepared: PreparedHarnessInvocation = {
    command,
    args: ['--mode', 'rpc'],
    env,
    shell: false,
    runtime: {
      command,
      executable: command,
      resolvedPath: command,
      target: { kind: 'native' }
    }
  }
  return prepared
}

function objectOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`expected a JSON object, got ${String(value)}`)
  return value as Record<string, unknown>
}

function lineOf(line: string | undefined): Record<string, unknown> {
  if (line === undefined) throw new Error('nothing was written to the peer')
  return objectOf(JSON.parse(line) as unknown)
}

interface FakeTransport {
  transport: RpcTransport
  written: string[]
  closed: number
  emit(line: string): void
}

function fakeTransport(): FakeTransport {
  const lineHandlers: ((line: string) => void)[] = []
  const state: FakeTransport = {
    written: [],
    closed: 0,
    transport: {
      write: async (line: string) => {
        state.written.push(line)
      },
      onLine: (handler) => lineHandlers.push(handler),
      onStderr: () => undefined,
      onExit: () => undefined,
      close: async () => {
        state.closed += 1
      }
    },
    emit: (line: string) => {
      for (const handler of lineHandlers) handler(line)
    }
  }
  return state
}

describe('localRpcTransport', () => {
  it('reassembles a line the child writes in pieces and splits on either ending', async () => {
    const child = new FakeChild()
    const transport = localRpcTransport(child)
    const lines: string[] = []
    transport.onLine((line) => lines.push(line))

    child.stdout.write('{"type":"resp')
    child.stdout.write('onse"}\r\n{"type":"event"}\n')
    await tick()

    expect(lines).toEqual(['{"type":"response"}', '{"type":"event"}'])
  })

  it('forwards stderr text as the child wrote it', async () => {
    const child = new FakeChild()
    const transport = localRpcTransport(child)
    const chunks: string[] = []
    transport.onStderr((text) => chunks.push(text))

    child.stderr.write('boom: missing dependency\n')
    await tick()

    expect(chunks.join('')).toBe('boom: missing dependency\n')
  })

  it('writes exactly one newline per line', async () => {
    const child = new FakeChild()
    const transport = localRpcTransport(child)
    const received: string[] = []
    child.stdin.setEncoding('utf8')
    child.stdin.on('data', (chunk: string) => received.push(chunk))

    await transport.write('{"type":"get_state","id":"1"}')

    expect(received.join('')).toBe('{"type":"get_state","id":"1"}\n')
  })

  it('reports the peer exit exactly once', async () => {
    const child = new FakeChild()
    const transport = localRpcTransport(child)
    const codes: (number | null)[] = []
    transport.onExit((code) => codes.push(code))

    // A real child emits both; the bundled Pi host emits only `exit`.
    child.emit('exit', 7, null)
    child.emit('close', 7, null)
    child.emit('error', new Error('gone'))
    await tick()

    expect(codes).toEqual([7])
  })

  it('reports a launch failure as an error and an exit', async () => {
    const child = new FakeChild()
    const transport = localRpcTransport(child)
    const errors: string[] = []
    const codes: (number | null)[] = []
    transport.onError?.((error) => errors.push(error.message))
    transport.onExit((code) => codes.push(code))

    child.emit('error', new Error('spawn pi ENOENT'))
    await tick()

    expect(errors).toEqual(['spawn pi ENOENT'])
    expect(codes).toEqual([null])
  })

  it('closes once: ends stdin, then kills a child still running', async () => {
    const child = new FakeChild()
    const transport = localRpcTransport(child)
    const finished = new Promise<void>((resolve) => child.stdin.once('finish', resolve))

    const first = transport.close()
    expect(transport.close()).toBe(first)
    await first
    await finished

    expect(child.killed).toBe(true)
    expect(child.killCalls).toBe(1)
    expect(child.stdin.writableEnded).toBe(true)
  })

  it('leaves a child that ends during the grace period alone', async () => {
    const child = new FakeChild()
    const transport = localRpcTransport(child)
    transport.onExit(() => undefined)

    const closing = transport.close()
    child.emit('exit', 0, null)
    await closing

    expect(child.killCalls).toBe(0)
  })
})

describe('PiRpcClient over a transport', () => {
  it('correlates a response with the id of the request that wrote it', async () => {
    const fake = fakeTransport()
    const client = new PiRpcClient({
      invocation: invocation('unspawned-pi'),
      transport: fake.transport
    })

    const pending = client.getState()
    await tick()
    const request = lineOf(fake.written[0])
    expect(request['type']).toBe('get_state')

    fake.emit(
      JSON.stringify({ type: 'response', id: request['id'], success: true, data: { model: 'x' } })
    )

    await expect(pending).resolves.toEqual({ model: 'x' })
    client.dispose()
    expect(fake.closed).toBe(1)
  })

  it('delivers an agent event record to onEvent and a dialog to onUiRequest', () => {
    const fake = fakeTransport()
    const events: Record<string, unknown>[] = []
    const dialogs: Record<string, unknown>[] = []
    const client = new PiRpcClient({
      invocation: invocation('unspawned-pi'),
      transport: fake.transport,
      onEvent: (record) => events.push(record),
      onUiRequest: (record) => dialogs.push(record)
    })

    fake.emit('')
    fake.emit(JSON.stringify({ type: 'message_update', text: 'hello' }))
    fake.emit(JSON.stringify({ type: 'extension_ui_request', id: 'q1', method: 'confirm' }))

    expect(events).toEqual([{ type: 'message_update', text: 'hello' }])
    expect(dialogs).toEqual([{ type: 'extension_ui_request', id: 'q1', method: 'confirm' }])
    client.dispose()
  })

  it('fails a pending request when the client is disposed', async () => {
    const fake = fakeTransport()
    const client = new PiRpcClient({
      invocation: invocation('unspawned-pi'),
      transport: fake.transport
    })

    const pending = client.newSession()
    client.dispose()

    await expect(pending).rejects.toThrow('Pi process disposed')
    expect(fake.closed).toBe(1)
  })
})

describe('PiRpcClient without a transport', () => {
  const directories: string[] = []

  afterAll(async () => {
    for (const directory of directories) await rm(directory, { recursive: true, force: true })
  })

  // The fixture is a POSIX shell script, so this proves the spawn path on the
  // platforms that path is native to; Windows runs the bundled utility host.
  it.skipIf(process.platform === 'win32')(
    'still spawns a local child and speaks the protocol over its pipes',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'codeinoven-pi-rpc-'))
      directories.push(directory)
      const script = join(directory, 'pi')
      await writeFile(
        script,
        [
          '#!/bin/sh',
          'read -r line',
          'printf \'{"type":"response","id":1,"success":true,"data":{"spawned":true}}\\n\'',
          // Let the write reach the client before the process ends, so this test
          // is about the spawn path and not about exit/stdout ordering.
          'sleep 0.2',
          'exit 3',
          ''
        ].join('\n'),
        { mode: 0o755 }
      )

      const exits: (number | null)[] = []
      const client = new PiRpcClient({
        invocation: invocation(script),
        onExit: (code) => exits.push(code)
      })

      await expect(client.getState()).resolves.toEqual({ spawned: true })
      await waitFor(() => exits.length > 0)
      expect(exits).toEqual([3])
      // That pid proves the default path really spawned a child of its own.
      expect(client.process.pid).toBeGreaterThan(0)
      client.dispose()
    }
  )
})
