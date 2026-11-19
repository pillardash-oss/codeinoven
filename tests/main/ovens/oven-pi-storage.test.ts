import { describe, expect, it } from 'vitest'
import {
  OVEN_UNSUPPORTED_WORKSPACE_OPERATION,
  type OvenWorkspaceRequest,
  type OvenWorkspaceResult
} from '../../../src/lib/ovens'
import {
  OvenPiStorage,
  OVEN_PI_STORAGE_CHUNK_BYTES,
  OVEN_PI_TRASH_KEEP,
  type OvenPiStorageService
} from '../../../src/main/ovens/oven-pi-storage'

const OVEN = 'oven-6a1f0d3c'
const ROOT = '/home/ova/.config/pillardash/codeinoven/ovens/pi-status'
const HANDOFF = 'runtime/cio-core-tools/session-1/gateway-handoff.json'
const TRASH = 'runtime/cio-core-tools/session-1/.trash'
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
  /**
   * Fail a request, to prove a failure is surfaced instead of hidden.
   */
  fail: ((input: OvenWorkspaceRequest) => boolean) | null = null
  /**
   * When set, this Oven runs a service bundle that predates `remove`, and
   * answers every such request the way that bundle does.
   */
  cannotDelete = false
  /**
   * Write time per file, in call order.
   *
   * A fake cannot reproduce filesystem timestamp precision, and two parks in the
   * same millisecond must still order the way the real `.trash` does: newest
   * first, because that decides which entry survives.
   */
  private readonly stamps = new Map<string, number>()
  private clock = 0

  async workspace(id: string, input: OvenWorkspaceRequest): Promise<OvenWorkspaceResult> {
    expect(id).toBe(OVEN)
    if (this.fail?.(input)) throw new Error('The Oven service stopped answering.')
    this.calls.push(input)
    if (this.cannotDelete && input.operation === 'remove')
      throw new Error(OVEN_UNSUPPORTED_WORKSPACE_OPERATION)
    switch (input.operation) {
      case 'mkdir':
        this.directories.add(input.path)
        return { root: input.root }
      case 'list': {
        const prefix = input.path === '.' ? '' : `${input.path}/`
        const names = [...this.files.keys()]
          .filter((path) => path.startsWith(prefix))
          .map((path) => path.slice(prefix.length))
          // One directory's own entries, never a subdirectory's.
          .filter((name) => !name.includes('/'))
          .sort()
          .filter((name) => !input.after || name > input.after)
        return {
          root: input.root,
          files: names.map((name) => ({
            path: `${prefix}${name}`,
            kind: 'file' as const,
            size: this.files.get(`${prefix}${name}`)?.length ?? 0,
            modifiedAt: this.stamps.get(`${prefix}${name}`) ?? 0,
            mode: 0o600
          }))
        }
      }
      case 'remove': {
        if (!this.files.delete(input.path)) throw missing(`${input.root}/${input.path}`)
        return { root: input.root }
      }
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
        this.stamps.set(input.path, ++this.clock)
        return { root: input.root }
      }
      case 'replace': {
        const staged = this.files.get(input.staged)
        if (!staged) throw missing(`${input.root}/${input.staged}`)
        this.files.delete(input.staged)
        this.files.set(input.path, staged)
        this.stamps.set(input.path, ++this.clock)
        return { root: input.root }
      }
      case 'move': {
        const data = this.files.get(input.path)
        if (!data) throw missing(`${input.root}/${input.path}`)
        if (this.files.has(input.to)) throw new Error('The destination already exists on the Oven.')
        this.files.delete(input.path)
        this.files.set(input.to, data)
        this.stamps.set(input.to, ++this.clock)
        return { root: input.root }
      }
      default:
        throw new Error(`Unexpected workspace operation: ${input.operation}`)
    }
  }

  /** Put one file on the Oven without asking it, in write order. */
  seed(path: string, content: string): void {
    this.files.set(path, Buffer.from(content))
    this.stamps.set(path, ++this.clock)
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
    // The Oven deletes the file: nothing is left behind, in `.trash` or anywhere.
    expect(oven.files.has(HANDOFF)).toBe(false)
    expect([...oven.files.keys()].filter((path) => path.includes('.trash/'))).toHaveLength(0)
    expect(oven.calls.filter((call) => call.operation === 'remove')).toEqual([
      { operation: 'remove', root: ROOT, path: HANDOFF },
      { operation: 'remove', root: ROOT, path: HANDOFF }
    ])
  })

  it('parks a handoff file only when the Oven service predates remove', async () => {
    const oven = new FakeOven()
    oven.cannotDelete = true
    const storage = storageFor(oven)
    await storage.writeRaw(HANDOFF, 'token')

    await storage.remove(HANDOFF)

    await expect(storage.readRaw(HANDOFF)).resolves.toBeNull()
    expect(oven.calls.some((call) => call.operation === 'remove')).toBe(true)
    const parked = [...oven.files.keys()].filter((path) => path.startsWith(`${TRASH}/`))
    expect(parked).toHaveLength(1)
    expect(oven.files.get(parked[0]!)?.toString('utf8')).toBe('token')
  })

  it('keeps a parked .trash directory to the newest few entries', async () => {
    const oven = new FakeOven()
    oven.cannotDelete = true
    const storage = storageFor(oven)
    const total = OVEN_PI_TRASH_KEEP + 4

    for (let index = 0; index < total; index++) {
      const path = `runtime/cio-core-tools/session-1/handoff-${index}.json`
      await storage.writeRaw(path, `content-${index}`)
      await storage.remove(path)
    }

    const parked = [...oven.files.entries()].filter(([path]) => path.startsWith(`${TRASH}/`))
    const holding = parked.filter(([, data]) => data.length > 0)
    // A bundle with no delete cannot lose the names, but it must not keep the
    // bytes either: the newest few survive whole and everything older is emptied.
    expect(holding).toHaveLength(OVEN_PI_TRASH_KEEP)
    expect(holding.map(([, data]) => data.toString('utf8'))).toEqual(
      Array.from(
        { length: OVEN_PI_TRASH_KEEP },
        (_, index) => `content-${total - OVEN_PI_TRASH_KEEP + index}`
      )
    )
  })

  it('bounds a .trash directory an older bundle left behind once removal can delete', async () => {
    const oven = new FakeOven()
    const total = OVEN_PI_TRASH_KEEP + 5
    for (let index = 0; index < total; index++)
      oven.seed(`${TRASH}/parked-${index}`, `old-${index}`)
    const storage = storageFor(oven)
    await storage.writeRaw(HANDOFF, 'token')

    await storage.remove(HANDOFF)

    // The oldest entries are gone, not merely emptied: this Oven can delete.
    expect([...oven.files.keys()].filter((path) => path.startsWith(`${TRASH}/`))).toEqual(
      Array.from(
        { length: OVEN_PI_TRASH_KEEP },
        (_, index) => `${TRASH}/parked-${total - OVEN_PI_TRASH_KEEP + index}`
      )
    )
    expect(oven.files.has(HANDOFF)).toBe(false)
  })

  it('propagates a genuine removal failure and parks nothing', async () => {
    const oven = new FakeOven()
    const storage = storageFor(oven)
    await storage.writeRaw(HANDOFF, 'token')
    oven.fail = (input) => input.operation === 'remove'

    const error = await storage.remove(HANDOFF).then(
      () => null,
      (failure: unknown) => failure
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(`Could not remove ${HANDOFF} on the Oven`)
    expect((error as Error).message).toContain('The Oven service stopped answering.')
    // A real failure is not the old-bundle answer, so it is never turned into a
    // parked file: the caller has to see what the Oven said, and the file stays.
    expect([...oven.files.keys()].filter((path) => path.includes('.trash/'))).toHaveLength(0)
    oven.fail = null
    expect(oven.files.has(HANDOFF)).toBe(true)
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
