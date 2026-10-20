import { afterEach, describe, expect, it, vi } from 'vitest'
import { OvenRequestChannel, OvenServiceOutdated } from '../../../src/main/ovens/oven-request-channel'
import type { OvenSsh } from '../../../src/main/ovens/oven-ssh'

/**
 * A stand-in for the Oven's `attach` process.
 *
 * The channel owns process plumbing (spawn, stdin, chunked stdout, exit), so the
 * only honest way to test it is against a real child process that answers the way
 * the service does: one newline-terminated JSON line per request. A mock child
 * would prove the mock, not the channel.
 */
const ATTACH = `
const { createInterface } = require('node:readline')
const revision = process.env.REV ?? 'current'
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  if (!line.trim()) return
  const request = JSON.parse(line)
  const answer = (value) => process.stdout.write(JSON.stringify({ ok: true, value }) + '\\n')
  if (request.method === 'probe') return answer({ serviceRevision: revision })
  if (request.method === 'big') {
    // One answer delivered across many writes, the way a large file read arrives.
    const body = JSON.stringify({ ok: true, value: 'x'.repeat(Number(request.size)) }) + '\\n'
    const step = Math.ceil(body.length / Number(request.chunks))
    for (let index = 0; index < body.length; index += step)
      process.stdout.write(body.slice(index, index + step))
    return
  }
  if (request.method === 'slow') {
    return setTimeout(() => answer(request.value), Number(request.delay))
  }
  if (request.method === 'echo') return answer(request.value)
  return process.stdout.write(JSON.stringify({ ok: false, error: 'Unknown Oven request.' }) + '\\n')
})
`

function channelWith(env: Record<string, string> = {}, revision = 'current') {
  const prepare = vi.fn(async () => ({
    executable: process.execPath,
    args: ['-e', ATTACH],
    env: { ...process.env, ...env },
    dispose: async () => undefined
  }))
  // The channel asks which shell the Oven presents before it builds the launch;
  // a POSIX answer is the one that needs no Windows envelope here.
  const execute = vi.fn(async () => 'Linux')
  const ssh = { prepare, execute } as unknown as OvenSsh
  const channel = new OvenRequestChannel(ssh, async () => revision)
  return { channel, prepare, execute }
}

const opened: OvenRequestChannel[] = []

function open(env: Record<string, string> = {}, revision = 'current') {
  const { channel, prepare } = channelWith(env, revision)
  opened.push(channel)
  return { channel, prepare }
}

afterEach(() => {
  for (const channel of opened.splice(0)) channel.disposeAll()
})

describe('oven request channel', () => {
  it('answers pipelined requests in the order they were sent', async () => {
    const { channel, prepare } = open()
    const answers = await Promise.all([
      channel.request('oven-a', JSON.stringify({ method: 'echo', value: 1 })),
      channel.request('oven-a', JSON.stringify({ method: 'echo', value: 2 })),
      channel.request('oven-a', JSON.stringify({ method: 'echo', value: 3 }))
    ])
    expect(answers.map((answer) => JSON.parse(answer).value)).toEqual([1, 2, 3])
    // One process for three requests is the whole point: no per-request startup.
    expect(prepare).toHaveBeenCalledOnce()
  })

  it('reassembles one answer delivered in many chunks', async () => {
    const { channel } = open()
    const answer = await channel.request(
      'oven-a',
      JSON.stringify({ method: 'big', chunks: 64, size: 8192 })
    )
    expect(JSON.parse(answer).value).toHaveLength(8192)
  })

  it('refuses an answer larger than any operation may return', async () => {
    const { channel } = open()
    const pending = channel.request(
      'oven-a',
      JSON.stringify({ method: 'big', chunks: 64, size: 9 * 1024 * 1024 })
    )
    await expect(pending).rejects.toThrow('exceeded the size limit')
  })

  it('waits as long as the operation needs instead of the default timeout', async () => {
    const { channel } = open()
    const answer = await channel.request(
      'oven-a',
      JSON.stringify({ method: 'slow', delay: 120, value: 'done' }),
      5_000
    )
    expect(JSON.parse(answer).value).toBe('done')
  })

  it('replaces a session that stopped answering, and rejects what waited on it', async () => {
    const { channel, prepare } = open()
    await expect(
      channel.request('oven-a', JSON.stringify({ method: 'slow', delay: 400, value: null }), 80)
    ).rejects.toThrow('did not answer in time')
    // The next request starts a fresh session instead of trusting the dead one.
    const answer = await channel.request('oven-a', JSON.stringify({ method: 'echo', value: 7 }))
    expect(JSON.parse(answer).value).toBe(7)
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('reports an Oven whose running service is not this app own bundle', async () => {
    const { channel, prepare } = open({}, 'an-older-revision')
    await expect(
      channel.request('oven-a', JSON.stringify({ method: 'echo', value: 1 }))
    ).rejects.toBeInstanceOf(OvenServiceOutdated)
    // An outdated bundle is not a broken connection, so the session is closed
    // rather than counted against this Oven.
    expect(prepare).toHaveBeenCalledOnce()
  })

  it('keeps one session per Oven and never shares one across machines', async () => {
    const { channel, prepare } = open()
    await channel.request('oven-a', JSON.stringify({ method: 'echo', value: 'a' }))
    await channel.request('oven-b', JSON.stringify({ method: 'echo', value: 'b' }))
    await channel.request('oven-a', JSON.stringify({ method: 'echo', value: 'a2' }))
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(channel.isWarm('oven-a')).toBe(true)
    channel.dispose('oven-a')
    expect(channel.isWarm('oven-a')).toBe(false)
  })
})
