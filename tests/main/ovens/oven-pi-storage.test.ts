import { describe, expect, it } from 'vitest'
import type { OvenWorkspaceRequest, OvenWorkspaceResult } from '../../../src/lib/ovens'
import {
  OvenPiStorage,
  OVEN_PI_STORAGE_CHUNK_BYTES,
  type OvenPiStorageService
} from '../../../src/main/ovens/oven-pi-storage'

const OVEN = 'oven-6a1f0d3c'
const ROOT = '/home/ova/.config/pillardash/codeinoven/ovens/pi-status'
const HANDOFF = 'runtime/cio-core-tools/session-1/gateway-handoff.json'
const CHUNK = OVEN_PI_STORAGE_CHUNK_BYTES

function missing(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
    code: 'ENOENT'
  })
}

/**
 * The Oven's file API, in memory.
 *
 * Only the operations a handoff store may use exist, so an unexpected call is a
 * test failure rather than a silently accepted request, and every call is kept
 * so a test can assert the order and the offsets a write actually used.
 */
class FakeOven implements OvenPiStorageService {
  readonly calls: OvenWorkspaceRequest[] = []
  readonly files = new Map<string, Buffer>()
  readonly directories = new Set<string>()
  /** Fail one request, to prove a failure is surfaced instead of hidden. */
  fail: ((input: OvenWorkspaceRequest) => boolean) | null = null

  async workspace(id: string, input: OvenWorkspaceRequest): Promise<OvenWorkspaceResult> {
    expect(id).toBe(OVEN)
    if (this.fail?.(input)) throw new Error('The Oven service stopped answering.')
    this.calls.push(input)
    switch (input.operation) {
      case 'mkdir':
        this.directories.add(input.path)
        return { root: input.root }
      case 'read': {
        const data = this.files.get(input.path)
        if (!data) throw missing(`${input.root}/${input.path}`)
        return {
          root: input.root,
          data: data.subarray(input.offset, input.offset + CHUNK).toString('base64'),
          size: data.length
        }
      }
      case 'write': {
        if (input.exclusive && this.files.has(input.path)) throw new Error('EEXIST')
        const current = this.files.get(input.path) ?? Buffer.alloc(0)
        const data = Buffer.from(input.data, 'base64')
        const next = Buffer.alloc(Math.max(current.length, input.offset + data.length))
        current.copy(next)
        data.copy(next, input.offset)
        this.files.set(input.path, next)
        return { root: input.root }
      }
      case 'replace': {
        const staged = this.files.get(input.staged)
        if (!staged) throw missing(`${input.root}/${input.staged}`)
        this.files.delete(input.staged)
        this.files.set(input.path, staged)
        return { root: input.root }
      }
      case 'move': {
        const data = this.files.get(input.path)
        if (!data) throw missing(`${input.root}/${input.path}`)
        if (this.files.has(input.to)) throw new Error('The destination already exists on the Oven.')
        this.files.delete(input.path)
        this.files.set(input.to, data)
        return { root: input.root }
      }
      default:
        throw new Error(`Unexpected workspace operation: ${input.operation}`)
    }
  }

  /** Every write request's staged path, in the order the Oven received them. */
  writeCalls(): Array<{ path: string; offset: number }> {
    return this.calls.flatMap((call) =>
      call.operation === 'write' ? [{ path: call.path, offset: call.offset }] : []
    )
  }
}

function storageFor(oven: FakeOven, root: string = ROOT): OvenPiStorage {
  return new OvenPiStorage({ service: oven, ovenId: OVEN, root })
}

describe('OvenPiStorage', () => {
  it('resolves a relative handoff path under the Oven root', () => {
    const storage = storageFor(new FakeOven(), `${ROOT}/`)
    expect(storage.resolve(HANDOFF)).toBe(`${ROOT}/${HANDOFF}`)
    // Paths built with `path.join` on Windows arrive backslash-separated.
    expect(storage.resolve('runtime\\cio-core-tools\\session-1\\stop-request.json')).toBe(
      `${ROOT}/runtime/cio-core-tools/session-1/stop-request.json`
    )
    expect(storage.resolve('./runtime//cio-core-tools/session-1/stop-request.json')).toBe(
      `${ROOT}/runtime/cio-core-tools/session-1/stop-request.json`
    )
  })

  it('refuses a path that leaves the root', () => {
    const storage = storageFor(new FakeOven())
    for (const path of ['../escape.json', 'runtime/../../escape.json', 'a/..', '/etc/passwd']) {
      expect(() => storage.resolve(path)).toThrow(/Refusing/u)
    }
    expect(() => storage.resolve('')).toThrow(/needs a relative path/u)
    expect(() => storage.resolve('C:\\handoff.json')).toThrow(/Refusing an absolute/u)
  })

  it('refuses a root that is not an absolute Oven path', () => {
    expect(() => storageFor(new FakeOven(), 'relative/root')).toThrow(/absolute Oven path/u)
  })

  it('reads a missing handoff file as absent', async () => {
    const oven = new FakeOven()
    await expect(storageFor(oven).readRaw(HANDOFF)).resolves.toBeNull()
    expect(oven.writeCalls()).toEqual([])
  })

  it('round-trips text, non-ASCII included', async () => {
    const oven = new FakeOven()
    const storage = storageFor(oven)
    const content = JSON.stringify({ url: 'http://127.0.0.1:1/gateway', token: 'ünïcode 世界 🚀' })
    await storage.writeRaw(HANDOFF, content)
    await expect(storage.readRaw(HANDOFF)).resolves.toBe(content)
    expect(oven.directories.has('runtime/cio-core-tools/session-1')).toBe(true)
    // The destination holds nothing until the staged file is published.
    expect(oven.files.get(HANDOFF)?.toString('utf8')).toBe(content)
  })

  it('writes content larger than one chunk at increasing offsets and reassembles it', async () => {
    const oven = new FakeOven()
    const storage = storageFor(oven)
    const content = `{"prompt":"${'ü'.repeat(CHUNK)}"}`

    await storage.writeRaw(HANDOFF, content)

    expect(oven.writeCalls().map((call) => call.offset)).toEqual([0, CHUNK, CHUNK * 2])
    expect(oven.files.get(HANDOFF)).toEqual(Buffer.from(content, 'utf8'))
    await expect(storage.readRaw(HANDOFF)).resolves.toBe(content)
  })

  it('reads a file whose length is an exact multiple of the chunk', async () => {
    const oven = new FakeOven()
    const storage = storageFor(oven)
    const content = 'a'.repeat(CHUNK * 2)

    await storage.writeRaw(HANDOFF, content)

    expect(oven.writeCalls().map((call) => call.offset)).toEqual([0, CHUNK])
    await expect(storage.readRaw(HANDOFF)).resolves.toBe(content)
  })

  it('does not interleave two writes to the same path', async () => {
    const oven = new FakeOven()
    const storage = storageFor(oven)
    const first = `A${'a'.repeat(CHUNK)}`
    const second = `B${'b'.repeat(CHUNK)}`

    await Promise.all([storage.writeRaw(HANDOFF, first), storage.writeRaw(HANDOFF, second)])

    const writes = oven.writeCalls()
    const staged = [...new Set(writes.map((call) => call.path))]
    expect(staged).toHaveLength(2)
    // Each write's chunks land together, at increasing offsets.
    expect(writes.map((call) => call.path)).toEqual([staged[0], staged[0], staged[1], staged[1]])
    expect(writes.map((call) => call.offset)).toEqual([0, CHUNK, 0, CHUNK])
    await expect(storage.readRaw(HANDOFF)).resolves.toBe(second)
  })

  it('removes a handoff file, and tolerates one that is already gone', async () => {
    const oven = new FakeOven()
    const storage = storageFor(oven)

    await expect(storage.remove(HANDOFF)).resolves.toBeUndefined()

    await storage.writeRaw(HANDOFF, 'token')
    await storage.remove(HANDOFF)

    await expect(storage.readRaw(HANDOFF)).resolves.toBeNull()
    // The Oven's file API has no unlink: a removal parks the file recoverably.
    expect([...oven.files.keys()].filter((path) => path.includes('.trash/'))).toHaveLength(1)
  })

  it('rejects with the operation and path, never the content, and keeps the old file', async () => {
    const oven = new FakeOven()
    const storage = storageFor(oven)
    const secret = 'gateway-token-8f31ab'
    await storage.writeRaw(HANDOFF, 'previous')
    oven.fail = (input) => input.operation === 'write' && input.offset > 0

    const error = await storage.writeRaw(HANDOFF, `${secret}${'a'.repeat(CHUNK)}`).then(
      () => null,
      (failure: unknown) => failure
    )

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain(`write ${HANDOFF}`)
    expect(message).toContain('on the Oven')
    expect(message).not.toContain(secret)
    oven.fail = null
    await expect(storage.readRaw(HANDOFF)).resolves.toBe('previous')
  })
})
