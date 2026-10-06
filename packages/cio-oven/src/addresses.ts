import { networkInterfaces, hostname, type NetworkInterfaceInfo } from 'node:os'

/** One entry of `os.networkInterfaces()` flattened to what ranking needs. */
export interface AddressCandidate {
  address: string
  family: string
  internal: boolean
}

/**
 * Every address this machine answers on, most likely to be reachable first.
 *
 * A machine cannot know which of its own addresses another computer can reach:
 * that depends on the network between them, not on this machine. So rather than
 * guess one, the agent reports all of its real candidates and the app dials them
 * and keeps the first that connects.
 *
 * The order is a head start, not a decision. Private LAN ranges come first
 * because that is the shape of a development machine reached from a workstation,
 * then anything else routable, then the host name last: it is the value that
 * fails most often, and it is only useful when mDNS or DNS actually resolves it.
 */
export function candidateAddresses(): string[] {
  return rankAddresses(flattenInterfaces(networkInterfaces()), hostname())
}

/** Flatten the platform's interface map into one list of candidates. */
function flattenInterfaces(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): AddressCandidate[] {
  const candidates: AddressCandidate[] = []
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      candidates.push({ address: entry.address, family: entry.family, internal: entry.internal })
    }
  }
  return candidates
}

/**
 * Order candidates for dialing, dropping the ones that can never help.
 *
 * Pure on purpose: the app's own tests pin the ordering rules here rather than
 * depending on whatever interfaces the machine running them happens to have.
 */
export function rankAddresses(candidates: readonly AddressCandidate[], hostName: string): string[] {
  const ipv4Private: string[] = []
  const ipv4Other: string[] = []
  const ipv6: string[] = []
  for (const candidate of candidates) {
    if (candidate.internal) continue
    // A zone index (`%en0`) is meaningful only to this machine's stack.
    const address = candidate.address.split('%')[0]
    if (!address) continue
    if (candidate.family === 'IPv4') {
      if (isPrivateIpv4(address)) ipv4Private.push(address)
      else ipv4Other.push(address)
    } else if (candidate.family === 'IPv6' && isGlobalIpv6(address)) {
      ipv6.push(address)
    }
  }
  return [...new Set([...ipv4Private, ...ipv4Other, ...ipv6, hostName])]
}

/** RFC 1918 and carrier-grade NAT, the ranges a workstation can typically reach. */
function isPrivateIpv4(address: string): boolean {
  const [first, second] = address.split('.').map(Number)
  if (first === 10) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  if (first === 100 && second >= 64 && second <= 127) return true
  return false
}

/**
 * Whether an IPv6 address can plausibly name a host on another machine.
 *
 * Only global unicast (`2000::/3`) qualifies. Link-local (`fe80::/10`) names a
 * link and unique-local (`fc00::/7`) names a site, so neither is reachable from
 * a machine outside them and both would only add noise to the candidate list.
 */
function isGlobalIpv6(address: string): boolean {
  const first = Number.parseInt(address.split(':')[0] || '0', 16)
  return first >= 0x2000 && first <= 0x3fff
}
