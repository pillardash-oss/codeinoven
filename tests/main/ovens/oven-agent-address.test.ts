import { createServer, type Server } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import {
  candidateAddresses,
  rankAddresses,
  type AddressCandidate
} from '../../../packages/cio-oven/src/addresses'
import { firstReachableEndpoint } from '../../../src/main/ovens/oven-agent-address'

/** Build one interface entry the way `os.networkInterfaces()` reports it. */
function entry(address: string, family = 'IPv4', internal = false): AddressCandidate {
  return { address, family, internal }
}

describe('oven agent address ranking', () => {
  it('puts private LAN addresses first and the host name last', () => {
    expect(
      rankAddresses(
        [
          entry('8.8.8.8'),
          entry('192.168.64.10'),
          entry('10.0.0.5'),
          entry('fe80::1', 'IPv6'),
          entry('fd11:1ebc::1', 'IPv6'),
          entry('2001:db8::1', 'IPv6')
        ],
        'win-box'
      )
    ).toEqual(['192.168.64.10', '10.0.0.5', '8.8.8.8', '2001:db8::1', 'win-box'])
  })

  it('drops loopback, link-local and unique-local IPv6, and zone indexes', () => {
    expect(
      rankAddresses(
        [
          entry('127.0.0.1', 'IPv4', true),
          entry('fe80::abcd', 'IPv6'),
          entry('fd11:1ebc::2', 'IPv6'),
          entry('192.168.1.4%en0')
        ],
        'box'
      )
    ).toEqual(['192.168.1.4', 'box'])
  })

  it('never repeats an address, and always offers the host name', () => {
    const ranked = rankAddresses(
      [entry('192.168.1.4'), entry('192.168.1.4'), entry('10.1.1.1')],
      'box'
    )
    expect(ranked).toEqual(['192.168.1.4', '10.1.1.1', 'box'])
    expect(new Set(ranked).size).toBe(ranked.length)
  })

  it('reports this machine’s own candidates without external addresses', () => {
    const addresses = candidateAddresses()
    expect(addresses.length).toBeGreaterThan(0)
    expect(addresses).not.toContain('127.0.0.1')
    expect(new Set(addresses).size).toBe(addresses.length)
  })
})

describe('oven agent reachability probe', () => {
  const servers: Server[] = []
  afterAll(() => {
    for (const server of servers) server.close()
  })

  /** A real listener, so a probe that connects has something to connect to. */
  function listen(): Promise<number> {
    return new Promise((resolve) => {
      const server = createServer()
      servers.push(server)
      // No host: a dual-stack listener answers on both loopback families, so the
      // ordering test does not depend on which one this machine resolves first.
      server.listen(0, () => {
        const address = server.address()
        if (address && typeof address !== 'string') resolve(address.port)
      })
    })
  }

  /** A port with nothing on it: claimed by a listener, then released. */
  function closedPort(): Promise<number> {
    return new Promise((resolve) => {
      const server = createServer()
      server.listen(0, () => {
        const address = server.address()
        const port = address && typeof address !== 'string' ? address.port : 0
        server.close(() => resolve(port))
      })
    })
  }

  it('keeps the machine’s own order among the addresses that answer', async () => {
    const port = await listen()
    expect(await firstReachableEndpoint(['127.0.0.1'], [port])).toEqual({
      host: '127.0.0.1',
      port
    })
    // Only meaningful where IPv6 loopback exists; the probe itself decides.
    if ((await firstReachableEndpoint(['::1'], [port])) === null) return
    expect(await firstReachableEndpoint(['::1', '127.0.0.1'], [port])).toEqual({
      host: '::1',
      port
    })
    expect(await firstReachableEndpoint(['127.0.0.1', '::1'], [port])).toEqual({
      host: '127.0.0.1',
      port
    })
  })

  it('corrects a reported port nothing is listening on', async () => {
    const live = await listen()
    const dead = await closedPort()
    // The machine reported `dead`; SSH is really on `live`.
    expect(await firstReachableEndpoint(['127.0.0.1'], [dead, live])).toEqual({
      host: '127.0.0.1',
      port: live
    })
  })

  it('prefers the machine’s own port over the fallback', async () => {
    const first = await listen()
    const second = await listen()
    expect(await firstReachableEndpoint(['127.0.0.1'], [first, second])).toEqual({
      host: '127.0.0.1',
      port: first
    })
    expect(await firstReachableEndpoint(['127.0.0.1'], [second, first])).toEqual({
      host: '127.0.0.1',
      port: second
    })
  })

  it('skips an address that does not answer instead of failing', async () => {
    const port = await listen()
    // 192.0.2.0/24 is reserved for documentation, so nothing ever answers there.
    expect(await firstReachableEndpoint(['192.0.2.1', '127.0.0.1'], [port])).toEqual({
      host: '127.0.0.1',
      port
    })
  })

  it('answers null when nothing is listening, so the caller can fall back', async () => {
    // Bind then release, so the port is known to be closed on this machine.
    const port = await closedPort()
    expect(await firstReachableEndpoint(['127.0.0.1'], [port])).toBeNull()
    expect(await firstReachableEndpoint([], [port])).toBeNull()
    expect(await firstReachableEndpoint(['127.0.0.1'], [])).toBeNull()
  })
})
