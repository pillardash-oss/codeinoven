import { describe, expect, it } from 'vitest'
import { manualCandidates, discoverPeers, type DiscoveryEvent } from './discovery'
import { lanFirstRoute } from './routes'

describe('discoverPeers', () => {
  const options = {
    port: 4455,
    manualHosts: ['localhost'],
    useMdns: false,
    timeoutMs: 0
  }

  it('starts discovery and returns manual-host candidates when mDNS is off', async () => {
    const events: DiscoveryEvent[] = []
    const peers = await discoverPeers({ ...options, onEvent: (event) => events.push(event) })

    expect(peers).toEqual([{ host: 'localhost', port: 4455, source: 'manual' }])
    expect(events[0]).toEqual({ kind: 'started' })
    expect(events[1]).toEqual({ kind: 'found', peer: peers[0] })
  })

  it('includes mDNS peers when LAN_USE_MDNS is on and a lookup adapter is present', async () => {
    const peers = await discoverPeers({
      ...options,
      useMdns: true,
      mdnsLookup: async () => ['192.168.1.20', '192.168.1.21']
    })

    expect(peers).toEqual([
      { host: '192.168.1.20', port: 4455, source: 'mdns' },
      { host: '192.168.1.21', port: 4455, source: 'mdns' },
      { host: 'localhost', port: 4455, source: 'manual' }
    ])
  })

  it('falls back to manual hosts when mDNS lookup fails', async () => {
    const peers = await discoverPeers({
      ...options,
      useMdns: true,
      mdnsLookup: async () => {
        throw new Error('no mdns')
      }
    })

    expect(peers).toEqual([{ host: 'localhost', port: 4455, source: 'manual' }])
  })

  it('filters peers through the reachability probe', async () => {
    const peers = await discoverPeers({
      ...options,
      manualHosts: ['localhost', '192.168.1.99'],
      reachable: async (peer) => peer.host === 'localhost'
    })

    expect(peers).toEqual([{ host: 'localhost', port: 4455, source: 'manual' }])
  })

  it('emits a timeout event when no peer is reachable', async () => {
    const events: DiscoveryEvent[] = []
    const peers = await discoverPeers({
      ...options,
      manualHosts: [],
      reachable: async () => false,
      onEvent: (event) => events.push(event)
    })

    expect(peers).toEqual([])
    expect(events.some((event) => event.kind === 'timeout')).toBe(true)
  })

  it('deduplicates identical host:port candidates', async () => {
    const peers = await discoverPeers({
      ...options,
      manualHosts: ['localhost', 'localhost', '  localhost ']
    })

    expect(peers).toEqual([{ host: 'localhost', port: 4455, source: 'manual' }])
  })
})

describe('manualCandidates', () => {
  it('builds manual candidates for a port', () => {
    expect(manualCandidates(['a', 'b'], 4455)).toEqual([
      { host: 'a', port: 4455, source: 'manual' },
      { host: 'b', port: 4455, source: 'manual' }
    ])
  })
})

describe('LAN-first routing integration', () => {
  it('maps a discovered LAN peer to LAN_CONNECTED', async () => {
    const peers = await discoverPeers({
      port: 4455,
      manualHosts: ['192.168.1.5'],
      useMdns: false,
      reachable: async () => true
    })

    expect(lanFirstRoute(peers, true)).toEqual({
      kind: 'LAN_CONNECTED',
      peer: { host: '192.168.1.5', port: 4455 }
    })
  })

  it('falls back to RELAY_PROBING only when LAN finds no reachable peer', async () => {
    const peers = await discoverPeers({
      port: 4455,
      manualHosts: [],
      useMdns: false,
      timeoutMs: 0
    })

    expect(lanFirstRoute(peers, true)).toEqual({ kind: 'RELAY_PROBING' })
    expect(lanFirstRoute(peers, false)).toEqual({ kind: 'DISCONNECTED', reason: 'no-lan-peer' })
  })

  it('prefers LAN even when a relay is configured and reachable-looking', async () => {
    const peers = await discoverPeers({
      port: 4455,
      manualHosts: ['192.168.1.5'],
      useMdns: false,
      reachable: async () => true
    })

    const route = lanFirstRoute(peers, true)
    expect(route.kind).toBe('LAN_CONNECTED')
  })
})
