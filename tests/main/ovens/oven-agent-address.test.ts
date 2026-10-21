import { describe, expect, it } from 'vitest'
import {
  candidateAddresses,
  rankAddresses,
  type AddressCandidate
} from '../../../packages/cio-oven/src/addresses'

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
