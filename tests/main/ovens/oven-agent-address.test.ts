import { describe, expect, it } from 'vitest'
import {
  candidateAddresses,
  isGloballyRoutableAddress,
  rankAddresses,
  type AddressCandidate
} from '../../../packages/cio-oven/src/addresses'
import { discoverPublicAddress } from '../../../packages/cio-oven/src/public-address'

/** Build one interface entry the way `os.networkInterfaces()` reports it. */
function entry(address: string, family = 'IPv4', internal = false): AddressCandidate {
  return { address, family, internal }
}

/**
 * A fetch that answers from a handler, so no test reaches the network.
 *
 * `preconnect` is part of Bun's `fetch` type and is never called here, so the
 * stub carries a no-op one to stay assignable to `typeof fetch`.
 */
function stubFetch(handler: (url: string) => Promise<Response>): typeof fetch {
  return Object.assign(async (input: string | URL | Request) => handler(String(input)), {
    preconnect: () => undefined
  })
}

/** A fetch that answers every request with the given body. */
function answering(bodyFor: (url: string) => string): typeof fetch {
  return stubFetch(async (url) => new Response(bodyFor(url), { status: 200 }))
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

  it('leads with a discovered public address, ahead of the private LAN ones', () => {
    expect(rankAddresses([entry('192.168.1.4'), entry('10.0.0.5')], 'box', '203.0.113.7')).toEqual([
      '203.0.113.7',
      '192.168.1.4',
      '10.0.0.5',
      'box'
    ])
  })

  it('does not repeat a public address the interfaces already report', () => {
    expect(
      rankAddresses([entry('203.0.113.7'), entry('192.168.1.4')], 'box', '203.0.113.7')
    ).toEqual(['203.0.113.7', '192.168.1.4', 'box'])
  })

  it('keeps the order unchanged when no public address was discovered', () => {
    const candidates = [entry('8.8.8.8'), entry('192.168.1.4'), entry('2001:db8::1', 'IPv6')]
    expect(rankAddresses(candidates, 'box', undefined)).toEqual(rankAddresses(candidates, 'box'))
  })

  it('offers an explicitly discovered public address first on this machine', () => {
    expect(candidateAddresses('203.0.113.7')[0]).toBe('203.0.113.7')
  })
})

describe('oven agent public address validation', () => {
  it('accepts routable addresses only', () => {
    for (const address of ['8.8.8.8', '203.0.113.7', '2001:4860:4860::8888'])
      expect(isGloballyRoutableAddress(address), address).toBe(true)
    for (const address of [
      '10.0.0.5',
      '172.16.4.5',
      '192.168.1.4',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.1.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      'fe80::1',
      'fd11:1ebc::1',
      '::ffff:10.0.0.5',
      '<html>blocked</html>'
    ])
      expect(isGloballyRoutableAddress(address), address).toBe(false)
  })
})

describe('oven agent public address discovery', () => {
  it('reports the address an echo service answers with', async () => {
    const endpoints = ['https://echo.test/ip']
    expect(
      await discoverPublicAddress({ endpoints, fetchImpl: answering(() => '8.8.8.8\n') })
    ).toBe('8.8.8.8')
  })

  it('falls through a private answer to the next endpoint', async () => {
    const seen: string[] = []
    const endpoints = ['https://first.test/ip', 'https://second.test/ip']
    const discovered = await discoverPublicAddress({
      endpoints,
      fetchImpl: answering((url) => {
        seen.push(url)
        return url === 'https://first.test/ip' ? '10.0.0.5' : '8.8.4.4'
      })
    })
    expect(discovered).toBe('8.8.4.4')
    expect(seen).toEqual(['https://first.test/ip', 'https://second.test/ip'])
  })

  it('reports nothing when every endpoint fails', async () => {
    const discovered = await discoverPublicAddress({
      endpoints: ['https://echo.test/ip'],
      fetchImpl: stubFetch(async () => {
        throw new Error('offline')
      })
    })
    expect(discovered).toBeUndefined()
  })

  it('rejects a body that is not one bare address', async () => {
    const discovered = await discoverPublicAddress({
      endpoints: ['https://echo.test/ip'],
      fetchImpl: answering(() => '{"ip":"8.8.8.8"}')
    })
    expect(discovered).toBeUndefined()
  })
})
