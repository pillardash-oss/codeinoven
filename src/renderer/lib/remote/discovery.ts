/**
 * LAN peer discovery.
 *
 * Probes for the desktop peer on the local network: mDNS when `LAN_USE_MDNS`
 * is enabled and a native `mdnsLookup` adapter is available, otherwise it falls
 * back to the manual host list (`LAN_HOSTS`) combined with `LAN_PORT`. Peers
 * are deduplicated and optionally filtered through a reachability probe, and
 * lifecycle events (started, found, timeout) are reported to the caller.
 */

import type { PeerRef } from './routes'
import { remoteLog } from './logger'

export interface DiscoveredPeer extends PeerRef {
  source: 'mdns' | 'manual'
}

export type DiscoveryEvent =
  { kind: 'started' } | { kind: 'found'; peer: DiscoveredPeer } | { kind: 'timeout' }

export interface DiscoveryOptions {
  port: number
  manualHosts: string[]
  useMdns: boolean
  /** Native mDNS lookup. Browsers have no mDNS, so the manual fallback is the norm. */
  mdnsLookup?: (port: number) => Promise<string[]>
  /** Optional reachability probe; only peers that pass are emitted/returned. */
  reachable?: (peer: DiscoveredPeer) => Promise<boolean>
  timeoutMs?: number
  onEvent?: (event: DiscoveryEvent) => void
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function uniquePeers(peers: DiscoveredPeer[]): DiscoveredPeer[] {
  const seen = new Set<string>()
  const unique: DiscoveredPeer[] = []
  for (const peer of peers) {
    const key = `${peer.host}:${peer.port}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(peer)
  }
  return unique
}

/**
 * Discover reachable LAN peers. Resolves with the reachable peers after any
 * configured mdns/manual probing and reachability filtering, and reports
 * lifecycle events through `onEvent`.
 */
export async function discoverPeers(options: DiscoveryOptions): Promise<DiscoveredPeer[]> {
  options.onEvent?.({ kind: 'started' })
  remoteLog.dev(`LAN discovery started (mdns=${options.useMdns})`)

  const candidates: DiscoveredPeer[] = []
  if (options.useMdns && options.mdnsLookup) {
    let mdnsHosts: string[]
    try {
      mdnsHosts = await options.mdnsLookup(options.port)
    } catch {
      remoteLog.dev('mDNS lookup failed; falling back to manual hosts')
      mdnsHosts = []
    }
    for (const host of mdnsHosts) {
      candidates.push({ host, port: options.port, source: 'mdns' })
    }
  }
  for (const host of options.manualHosts) {
    const trimmed = host.trim()
    if (trimmed.length === 0) continue
    candidates.push({ host: trimmed, port: options.port, source: 'manual' })
  }

  const discovered: DiscoveredPeer[] = []
  for (const peer of uniquePeers(candidates)) {
    let reachable = true
    if (options.reachable) {
      try {
        reachable = await options.reachable(peer)
      } catch {
        reachable = false
      }
    }
    if (reachable) {
      discovered.push(peer)
      options.onEvent?.({ kind: 'found', peer })
    }
  }

  if (discovered.length === 0) {
    await delay(options.timeoutMs ?? 3000)
    options.onEvent?.({ kind: 'timeout' })
    remoteLog.dev('LAN discovery timed out — no reachable peer found')
  }

  return discovered
}

/** Build the manual-host candidates for a given port (used by tests/tools). */
export function manualCandidates(hosts: string[], port: number): DiscoveredPeer[] {
  return hosts
    .map((host) => host.trim())
    .filter((host) => host.length > 0)
    .map((host) => ({ host, port, source: 'manual' as const }))
}
